/**
 * The ACP layer - glue over `@agentclientprotocol/sdk`.
 *
 * This is the **only** part of the project that knows the SDK. It holds no
 * business logic: it spawns a subprocess, negotiates the protocol, wires the
 * client handlers, and translates `session/update` notifications into `AcpEvent`s
 * (the portable contract).
 *
 * Prompt construction lives in `core/prompt.ts`, **not here**: that is business
 * logic, and a transport reusing it must not end up with the SDK in its
 * dependency graph. Here it is a single call.
 *
 * Design point worth knowing: `client().connectWith(stream, fn)` ties `fn`'s
 * lifetime to the connection's. `client().connect(stream)` is therefore used
 * instead, returning a persistent `ClientConnection`
 * (`{ agent, signal, closed, close() }`), and `open()` / `inventory()` are
 * exposed as methods on the returned object.
 */

import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

import { parseInventory } from "../core/models.js"
import { renderRequest } from "../core/prompt.js"
import type {
  AcpAgent,
  AcpAgentInfo,
  AcpEvent,
  AcpPermissionPolicy,
  AcpSession,
  AcpStopReason,
  Inventory,
  NormalizedRequest,
  PermissionDecision,
  PermissionRequest,
} from "../core/types.js"
import { denyAllPermissions } from "../core/types.js"

/** Construction options of an ACP agent. */
export interface AcpAgentOptions {
  /** The command to launch, e.g. `"copilot"` or `"npx"`. */
  command: string
  /** Arguments, e.g. `["--acp"]`. */
  args?: readonly string[]
  /** Working directory of the subprocess. */
  cwd?: string
  /** Extra environment variables. */
  env?: Readonly<Record<string, string>>
  /**
   * Decision policy for `session/request_permission`.
   * Note: default is **refuse everything**.
   */
  policy?: AcpPermissionPolicy
  /** Name announced by the ACP client in `initialize`. */
  clientName?: string
  /**
   * What to do with the agent's stderr (useful when debugging).
   *
   * Note: the default is `"pipe"`. A host does not want the ACP agent's logs
   * landing in **its** journal, which would then mix two sources; only the CLI
   * asks for `"inherit"`.
   *
   * Whatever the mode, the last lines are kept for error messages: that is the
   * only source that says *why* the agent died. The only difference between the
   * modes: `"inherit"` forwards them to our own stderr, `"pipe"` passes them to
   * `onStderr`, `"ignore"` does neither (but still keeps them for the error).
   */
  stderr?: "inherit" | "ignore" | "pipe"
  /** Receives every chunk of the agent's stderr (`"pipe"` mode). */
  onStderr?: (chunk: string) => void
  /** `initialize` timeout, in ms. */
  initializeTimeoutMs?: number
}

/**
 * An error enriched with the **subject** of the failure, for a readable
 * diagnostic.
 *
 * Note: the field is called `subject` and not `command` because it does not
 * always hold a command: depending on where the error came from it is the
 * "command + args" label, a session's `sessionId`, or an empty string. A field
 * named `command` invited `log(e.command)` to print a UUID believing it was a
 * command line.
 */
export class AcpAgentError extends Error {
  /**
   * Note: field **declared explicitly** rather than as a `readonly subject:
   * string` constructor parameter property. The parameter property form is
   * TypeScript that Node's type stripping **cannot** handle (it strips, it does
   * not transform), so it would make `scripts/verify-package.mjs` - the only way
   * to actually **run** the package before publishing - fail with a
   * `SyntaxError` unrelated to the contract.
   */
  readonly subject: string

  constructor(message: string, subject: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "AcpAgentError"
    this.subject = subject
  }
}

const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000

/** Entry point for a session's permission events (see `createSession`). */
type PermissionSink = (event: AcpEvent) => void

/**
 * Rewrites any error into an `AcpAgentError` **naming the command**. This is the
 * only guarantee usable in CI: without the command name a failure reduces to
 * "ACP connection closed", with no clue at all.
 */
const asAgentError = (error: unknown, label: string): AcpAgentError => {
  if (error instanceof AcpAgentError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new AcpAgentError(`${label}: ACP protocol failure: ${detail}`, label, {
    cause: error,
  })
}

/**
 * Terminates the subprocess: `SIGTERM`, bounded wait, then `SIGKILL`.
 * Idempotent, and a no-op if the spawn failed (no `pid`) or the process is
 * already dead.
 */
const terminate = async (child: ReturnType<typeof spawn>): Promise<void> => {
  // Spawn impossible (non-existent command): `pid` is `undefined` and there is
  // nothing to kill. Same if the process already exited - waiting 2 s for a
  // `close` already emitted would gain nothing.
  if (child.pid === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
}

// ─────────────────────────────────────────────────────────────────────────────
// Translating ACP notifications into `AcpEvent`
// ─────────────────────────────────────────────────────────────────────────────

const textOf = (content: acp.ContentBlock | undefined): string | undefined => {
  if (content === undefined) return undefined
  if (content.type === "text") return content.text
  // Images, audio and resources are not translated into text: they are ignored
  // rather than lied about.
  return undefined
}

/**
 * A deliberate seam: the two unions are identical and the typecheck is enough.
 * A mapping will only be needed if one of them evolves - in which case this file
 * is **the** place to fix, not the callers.
 */
const toStopReason = (reason: acp.StopReason): AcpStopReason => reason

/**
 * Translates a `session/update` into zero or more `AcpEvent`s. Purely
 * metadata notifications (`session_info_update`, `available_commands_update`,
 * `notice`, `compaction_*`...) produce nothing: handling them belongs to the
 * adapter, not to the core.
 */
export const updateToEvents = (update: acp.SessionUpdate): AcpEvent[] => {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf(update.content)
      return text === undefined || text === "" ? [] : [{ type: "text", text }]
    }
    case "agent_thought_chunk": {
      const text = textOf(update.content)
      return text === undefined || text === "" ? [] : [{ type: "thought", text }]
    }
    case "tool_call":
      return [{
        type: "tool",
        id: update.toolCallId,
        name: update.name ?? "",
        title: update.title,
        kind: update.kind ?? "other",
        status: update.status ?? "pending",
        input: update.rawInput,
      }]
    case "tool_call_update": {
      // An update can be partial: `output` is present only if the agent sends
      // it, and is only emitted in that case.
      const event: AcpEvent = {
        type: "tool",
        id: update.toolCallId,
        name: update.name ?? "",
        title: update.title ?? update.toolCallId,
        kind: update.kind ?? "other",
        status: update.status ?? "in_progress",
        input: update.rawInput,
      }
      return update.rawOutput === undefined ? [event] : [{ ...event, output: update.rawOutput }]
    }
    case "plan":
      return [{ type: "plan", entries: update.entries }]
    case "plan_update":
      // `plan_update` (legacy v1 API) carries content *or* markdown: only the
      // structured items are translatable into `PlanEntry`.
      return update.plan.type === "items" ? [{ type: "plan", entries: update.plan.entries }] : []
    case "usage_update":
      // Context window, not turn cost: the two semantics are now two distinct
      // `usage` variants (see `core/types.ts`).
      return [{ type: "usage", kind: "context", used: update.used }]
    default:
      return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ACP `Usage` (at `stop`) -> the `turn` variant of `AcpEvent`.
 *
 * Only **present** fields are propagated: the union declares them optional so
 * the reducer can tell them apart, not so zeros can be invented.
 * `reasoning` / `cacheRead` / `cacheWrite` feed OpenCode's `Usage` class
 * directly, hence their presence here rather than a plain `input`/`output`.
 */
const toUsageEvent = (usage: acp.Usage): AcpEvent => ({
  type: "usage",
  kind: "turn",
  input: usage.inputTokens,
  output: usage.outputTokens,
  total: usage.totalTokens,
  ...(usage.thoughtTokens == null ? {} : { reasoning: usage.thoughtTokens }),
  ...(usage.cachedReadTokens == null ? {} : { cacheRead: usage.cachedReadTokens }),
  ...(usage.cachedWriteTokens == null ? {} : { cacheWrite: usage.cachedWriteTokens }),
})

/** The `session/request_permission` response plus the option actually taken. */
interface PermissionOutcome {
  response: acp.RequestPermissionResponse
  /** `undefined` when the turn is cancelled: nothing was offered to the agent. */
  selectedOptionId?: string
}

/**
 * Translates a policy decision into a `session/request_permission` response.
 * A `reject` without an explicit `optionId` designates the first `reject_*`
 * option the agent offered; if there is none, the turn is cancelled. Same for
 * `select` without `optionId` with the `allow_*` options.
 */
const toPermissionResponse = (
  decision: PermissionDecision,
  request: PermissionRequest,
): PermissionOutcome => {
  if (decision.action === "cancel") {
    return { response: { outcome: { outcome: "cancelled" } } }
  }
  if (decision.optionId !== undefined) {
    return {
      response: { outcome: { outcome: "selected", optionId: decision.optionId } },
      selectedOptionId: decision.optionId,
    }
  }
  const fallback = request.options.find((o) =>
    decision.action === "reject" ? o.kind.startsWith("reject_") : o.kind.startsWith("allow_"),
  )
  if (fallback === undefined) {
    // The agent offers nothing compatible: cancel rather than grant.
    return { response: { outcome: { outcome: "cancelled" } } }
  }
  return {
    response: { outcome: { outcome: "selected", optionId: fallback.id } },
    selectedOptionId: fallback.id,
  }
}

const createSession = (
  connection: acp.ClientConnection,
  session: acp.ActiveSession,
  permissionSinks: Map<string, PermissionSink>,
): AcpSession => {
  // `configOptions` evolve over the session's life, so the **last raw capture**
  // returned by the agent is kept and `parseInventory` (a pure function)
  // translates it on demand. A normalised `AcpOption` is never re-parsed: the
  // raw and normalised shapes do not use the same field names (`options` vs
  // `values`).
  let raw: readonly unknown[] = session.newSessionResponse.configOptions ?? []
  // `parseInventory` is pure: the result depends only on `raw`. It is memoised
  // so the capture is not walked again on every `inventory()`, `setModel` and
  // `setOption`, and invalidated on every write to `raw`.
  let parsedInventory: Inventory | undefined

  /** Invariant: `raw` is always a usable capture, never `undefined`. */
  const setRaw = (next: readonly unknown[] | undefined): void => {
    // A third-party agent may omit `configOptions`. `?? []` would lose the
    // current inventory, so the **previous state is kept** rather than emptied -
    // the only choice that does not make the agent regress.
    if (next === undefined) return
    raw = next
    parsedInventory = undefined
  }

  /**
   * Invariant: `closed` flips to `true` **once** and never goes back, so
   * `assertOpen` is a sufficient guard for the whole session lifecycle (no
   * reopening, no possible race).
   */
  let closed = false
  /** Invariant: armed on entry to every turn, disarmed in its `finally`. */
  let turnInFlight = false

  const assertOpen = (): void => {
    if (closed) {
      throw new AcpAgentError(`session ${session.sessionId}: session closed`, session.sessionId)
    }
  }

  const setOption = async (configId: string, value: string): Promise<void> => {
    assertOpen()
    const option = inventory().options.find((o) => o.id === configId)
    if (option === undefined) {
      throw new AcpAgentError(
        `session ${session.sessionId}: unknown config option "${configId}"`,
        session.sessionId,
      )
    }
    // A boolean requires a typed payload: `{ type: "boolean", value: bool }`.
    const params: acp.SetSessionConfigOptionRequest = option.type === "boolean"
      ? { sessionId: session.sessionId, configId, type: "boolean", value: value === "true" }
      : { sessionId: session.sessionId, configId, value }
    const response = await connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      params,
    )
    // The specification requires returning the complete state: it is relayed as-is.
    setRaw(response.configOptions)
  }

  const inventory = (): Inventory => (parsedInventory ??= parseInventory(raw))

  const prompt = (
    request: NormalizedRequest,
    options_?: { signal?: AbortSignal },
  ): AsyncIterable<AcpEvent> => {
    assertOpen()
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<AcpEvent> {
        const signal = options_?.signal

        // Invariant: **one turn at a time** per session. Armed on entry to the
        // generator, disarmed in the `finally`.
        //
        // Without this guard two concurrent `prompt()` calls share the same
        // `session.nextUpdate()`: the `session/update`s of both turns become
        // indistinguishable, and above all the second
        // `permissionSinks.set(sessionId, ...)` would **overwrite** the first
        // one's - whose permissions would become invisible, while the first
        // turn's `finally` then deletes them. A mute permission refusal is the
        // worst possible failure in the default deny-all mode.
        if (turnInFlight) {
          throw new AcpAgentError(
            `session ${session.sessionId}: a turn is already running on this session`,
            session.sessionId,
          )
        }
        turnInFlight = true

        // Permission decisions are taken **during** the turn, from a handler
        // that has no access to the generator: they are buffered and re-injected
        // on every loop turn. Without that the policy is invisible in the stream.
        const pending: AcpEvent[] = []
        permissionSinks.set(session.sessionId, (event) => {
          pending.push(event)
        })

        /** `session/cancel` is a notification: it cannot be awaited here. */
        const sendCancel = (): void => {
          void connection.agent
            .notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
            .catch(() => undefined)
        }
        const onAbort = (): void => {
          sendCancel()
        }
        if (signal?.aborted === true) onAbort()
        else signal?.addEventListener("abort", onAbort, { once: true })

        // `prompt()` resolves with the same completion as the `stop` message.
        // `settled` is **never** rejected (both branches convert), so it is an
        // orphan-rejection guard, not a wait.
        const pendingPrompt = session.prompt(renderRequest(request))
        const settled = pendingPrompt.then(
          () => undefined,
          (error: unknown) => error,
        )

        let completed = false
        try {
          for (;;) {
            const message = await session.nextUpdate()
            // Permissions requested while waiting arrive here.
            for (const event of pending.splice(0)) yield event

            if (message.kind === "stop") {
              const usage = message.response.usage
              if (usage !== undefined && usage !== null) yield toUsageEvent(usage)
              // Invariant: `completed` is armed **before** the `yield done` - at
              // that instant the turn is over, and a `session/cancel` must not be
              // sent into the void should the consumer stop on it. Arming it
              // afterwards would let the `finally` cancel a finished turn.
              completed = true
              yield { type: "done", stopReason: toStopReason(message.stopReason) }
              return
            }
            const update = message.update
            if (update.sessionUpdate === "config_option_update") {
              setRaw(update.configOptions)
              continue
            }
            for (const event of updateToEvents(update)) yield event
          }
        } catch (error) {
          yield { type: "error", message: error instanceof Error ? error.message : String(error) }
          // A stream that stops without `done` fails the `@opencode/ai` chain
          // with "The provider response ended unexpectedly.", so the turn is
          // explicitly closed.
          completed = true
          yield { type: "done", stopReason: "cancelled" }
        } finally {
          // Invariant: the turn is disarmed on **every** exit path - nominal,
          // `error`, or consumer abandonment. Without that, a single interrupted
          // turn would make the session permanently unusable.
          turnInFlight = false
          signal?.removeEventListener("abort", onAbort)
          permissionSinks.delete(session.sessionId)
          if (completed) {
            // Nominal path: the turn is over and `settled` already resolved. It
            // is awaited so nothing is ever left dangling.
            await settled
          } else {
            // The consumer abandoned (break / return / throw), possibly
            // **without** having supplied an `AbortSignal`. Awaiting `settled`
            // here could block the next tick for up to 80 s. The turn is
            // cancelled instead and control returns immediately; `settled` never
            // rejects, so no rejection can become an orphan.
            sendCancel()
          }
        }
      },
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    session.dispose()
    try {
      await connection.agent.request(acp.methods.agent.session.close, {
        sessionId: session.sessionId,
      })
    } catch {
      // `session/close` is optional (see sessionCapabilities.close): its
      // absence is not an error, local routing is simply released.
    }
  }

  return {
    sessionId: session.sessionId,
    inventory,
    async setModel(modelId: string): Promise<void> {
      const options = inventory().options
      const modelOption = options.find((o) => o.category === "model")
      if (modelOption === undefined) {
        // The existing `configId`s are listed: "no option of category model"
        // alone does not tell the user what to try instead.
        const known = options.map((o) => o.id).join(", ") || "(none)"
        throw new AcpAgentError(
          `session ${session.sessionId}: no option of category "model"` +
            `; available options: ${known}`,
          session.sessionId,
        )
      }
      await setOption(modelOption.id, modelId)
    },
    setOption,
    prompt,
    close,
  }
}

/**
 * Launches the ACP agent and negotiates `initialize`.
 * Returns a **persistent** object: the connection stays open until `close()`.
 *
 * Note, process invariant: *every* path leaving this function without having
 * returned the object must have killed the child. Otherwise a timed-out
 * `initialize` or a dead agent left an orphan process adopted by init - that is,
 * **one accumulation per request** for an agent that consistently times out.
 * The single `try/catch` wrapping the whole startup phase guarantees it.
 */
export const createAcpAgent = async (options: AcpAgentOptions): Promise<AcpAgent> => {
  const policy = options.policy ?? denyAllPermissions
  // Default `"pipe"`: a host does not want the ACP agent's logs landing in its
  // own journal. Only the CLI asks for `"inherit"`.
  const stderrMode = options.stderr ?? "pipe"
  const args = [...(options.args ?? [])]
  // A readable label present in **every** error message: without it a failure
  // reduces to "ACP connection closed", with no command name.
  const label = [options.command, ...args].join(" ").trim()

  // stderr is **always** captured, whatever the mode: it is the only source that
  // says *why* the agent died. The mode only decides **redistribution** (see
  // `AcpAgentOptions.stderr`), never capture. (An earlier version only captured
  // in `pipe` mode, which the CLI never used, so the queue was always empty -
  // dead code.)
  const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"]
  const child = spawn(options.command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env },
    stdio,
  })

  let stderrTail = ""
  const tailOf = (): string =>
    stderrTail === "" ? "" : `\n--- stderr de l'agent ---\n${stderrTail.trim()}`
  const fail = (reason: string, cause?: unknown): AcpAgentError =>
    new AcpAgentError(
      `${label}: ${reason}${tailOf()}`,
      label,
      cause === undefined ? undefined : { cause },
    )
  const captureStderr = child.stderr
  if (captureStderr !== null) {
    captureStderr.setEncoding("utf8")
    captureStderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2_000)
      // `"inherit"` forwards to our stderr, `"pipe"` to the host that supplied
      // `onStderr`, `"ignore"` to neither - but all three modes feed
      // `stderrTail`, the only source of the death diagnostic.
      if (stderrMode === "inherit") process.stderr.write(chunk)
      else if (stderrMode === "pipe") options.onStderr?.(chunk)
    })
  }

  // Permissions requested during a turn, by `sessionId`: the only way to make
  // them observable in the `AcpEvent` stream.
  //
  // Invariant: **at most one entry per open session**, set by the running turn
  // and removed by its `finally`. That is why `prompt()` refuses two concurrent
  // turns: a `set` would overwrite the first turn's entry.
  const permissionSinks = new Map<string, PermissionSink>()

  let connection: acp.ClientConnection | undefined
  let terminated = false
  const shutdown = async (): Promise<void> => {
    if (terminated) return
    terminated = true
    await terminate(child)
  }

  // The "the agent is dead" guard, single and genuinely reachable. The first of
  // the three subprocess signals to fire wins:
  //   - `error`: the spawn failed (non-existent command); `exit` is then never
  //     emitted, it is `close` that is;
  //   - `exit`: died with a code;
  //   - `close`: stdio ended (covers the codeless case).
  let deathReason: AcpAgentError | undefined
  const death = new Promise<never>((_resolve, reject) => {
    const die = (error: AcpAgentError): void => {
      deathReason ??= error
      // The cause is propagated to **in-flight** requests: otherwise they would
      // only see "ACP connection closed", with no command name.
      connection?.close(deathReason)
      reject(deathReason)
    }
    child.once("error", (error: Error) => {
      die(fail(`cannot start the agent: ${error.message}`, error))
    })
    child.once("exit", (code, signal) => {
      die(fail(`the agent stopped (code=${String(code)}, signal=${String(signal)})`))
    })
    child.once("close", () => {
      die(deathReason ?? fail("the agent stopped without an exit code"))
    })
  })
  // `death` does not always reject: the agent can die later, at shutdown. Its
  // rejection is neutralised to avoid an `unhandledRejection`.
  death.catch(() => undefined)

  /**
   * Waits **briefly** for the agent's death to be observed. Returns `undefined`
   * if it is still alive when the delay elapses.
   */
  const deathSoon = async (ms: number): Promise<AcpAgentError | undefined> =>
    await Promise.race([
      death,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
    ])

  let initResponse: acp.InitializeResponse
  try {
    // An unreadable stdout is a classic symptom (the agent wrote to stdout
    // before starting the protocol): the error message will say so.
    const stream = acp.ndJsonStream(
      Writable.toWeb(requireStream(child.stdin, "stdin")),
      Readable.toWeb(requireStream(child.stdout, "stdout")),
    )

    const app = acp
      .client({ name: options.clientName ?? "opencode-acp-provider" })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const request: PermissionRequest = {
          sessionId: ctx.params.sessionId,
          toolCallId: ctx.params.toolCall.toolCallId,
          title: ctx.params.toolCall.title ?? ctx.params.toolCall.toolCallId,
          kind: ctx.params.toolCall.kind ?? "other",
          options: ctx.params.options.map((o) => ({
            id: o.optionId,
            name: o.name,
            kind: o.kind,
          })),
        }
        const decision = await policy(request)
        const outcome = toPermissionResponse(decision, request)
        permissionSinks.get(ctx.params.sessionId)?.({
          type: "permission",
          request,
          decision,
          ...(outcome.selectedOptionId === undefined
            ? {}
            : { selectedOptionId: outcome.selectedOptionId }),
        })
        return outcome.response
      })

    connection = app.connect(stream)

    const request = connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        // Default deny-all mode: we can neither read nor write on disk.
        // Declaring `true` was a **lying capability** - the agent believed it
        // could have us read files and only got nothing. `false` is therefore
        // declared explicitly rather than dropping the handlers.
        fs: { readTextFile: false, writeTextFile: false },
      },
    })
    const timeout = AbortSignal.timeout(
      options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
    )
    initResponse = await Promise.race([request, death, rejectOn(timeout, label)])
  } catch (error) {
    // No error exit may return with the child still alive. This also covers an
    // exception thrown while building the stream or registering the handlers.
    //
    // When the agent is dead, **its death is the cause**: the SDK can only say
    // "ACP connection closed", which is unusable. The death is therefore awaited
    // briefly, to prefer the message naming the command, the exit code and the
    // stderr. Bounded at 250 ms, and free when the agent is alive (explicit
    // timeout) since it is only consulted on an untyped error.
    const cause =
      error instanceof AcpAgentError ? undefined : (deathReason ?? (await deathSoon(250)))
    connection?.close(cause ?? error)
    await shutdown()
    throw cause ?? asAgentError(error, label)
  }

  const info: AcpAgentInfo = {
    name: initResponse.agentInfo?.name ?? options.command,
    version: initResponse.agentInfo?.version ?? "unknown",
  }

  let closed = false
  const assertAlive = (): void => {
    if (closed) throw new AcpAgentError(`${label}: agent closed`, label)
  }

  const openSession = async (
    openOptions: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<AcpSession> => {
    assertAlive()
    const active = await connection.agent
      .buildSession(openOptions.cwd ?? options.cwd ?? process.cwd())
      .start()
    return createSession(connection, active, permissionSinks)
  }

  // The inventory lives in the `session/new` response: a throwaway session is
  // opened, read, and closed again.
  const inventory = async (): Promise<Inventory> => {
    const session = await openSession()
    try {
      return session.inventory()
    } finally {
      await session.close()
    }
  }

  return {
    info,
    protocolVersion: initResponse.protocolVersion,

    inventory,

    async models() {
      return (await inventory()).models
    },

    open: openSession,

    async close(): Promise<void> {
      if (closed) return
      closed = true
      // Still-open sessions lose their ability to emit: routing is released
      // before the channel is closed.
      permissionSinks.clear()
      connection?.close()
      await shutdown()
    },
  }
}

/** `stdio` is pinned to `"pipe"` above: this guard is only a safety net. */
const requireStream = <T>(stream: T | null, name: string): T => {
  if (stream === null) throw new AcpAgentError(`spawn produced no ${name} stream`, "")
  return stream
}

const rejectOn = (signal: AbortSignal, subject: string): Promise<never> =>
  new Promise((_resolve, reject) => {
    const onAbort = (): void =>
      reject(new AcpAgentError(`${subject}: initialize timed out`, subject))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
