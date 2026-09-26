/**
 * The ACP `Transport` over stdio.
 *
 * This is the **only** shell of the project that depends on both
 * `@opencode/ai` and `effect` - roughly 150 lines to throw away if those
 * internals move. It holds no business logic; all it does is
 *
 *   1. obtain an `AcpAgent` (**cached at module level**),
 *   2. obtain the turn's ACP session - fresh (`fresh`) or taken from a session
 *      pool (`reuse`),
 *   3. turn the `AcpEvent` stream into frames, never stopping before the
 *      `Scope` closes.
 *
 * Note: the process cache is not an optional optimisation. An ACP `initialize`
 * costs a few seconds and the provider is called on **every turn** of a
 * conversation; without the cache a chat session would gain a `spawn` per
 * message.
 *
 * Note: `session: "reuse"` does not make that cache shareable. An ACP session
 * **retains the conversation**, so it can only be resumed if the history
 * received is exactly an extension of what it already received. The decision
 * belongs to `core/session-key.ts` (pure) and its state to
 * `core/session-pool.ts` (bounded LRU, serialisation queue); here the two are
 * merely **wired** together: open the session when the pool asks for it, give
 * the queue back at the end of the turn, and "poison" the session if the turn
 * ended badly. The default stays `fresh` - reuse only activates on explicit
 * request.
 *
 * Note: `TransportExecution.http` is deliberately **absent**. There is no HTTP
 * request, and providing one would make the core believe a network context
 * exists (URL, status) when the only thing that can fail is a pipe. That is
 * also why a pipe failure is reported as `ProviderInternalError` rather than
 * `TransportError`: the latter's `transport` field is a **closed** union over
 * `["http","websocket"]`, with no `stdio` value.
 */

import { Effect, Scope, Stream } from "effect"
import { Auth, Endpoint, Route } from "@opencode/ai/route"
import type { TransportDef, TransportExecution, TransportRuntime } from "@opencode/ai/route"
import type { TransportPrepareInput } from "@opencode/ai/route/transport/index"
import { AIError, InvalidRequestError, ProviderID, ProviderInternalError } from "@opencode/ai/schema/index"
import type { LLMRequest } from "@opencode/ai/schema/index"

import { AcpAgentError, createAcpAgent } from "../acp/agent.js"
import type {
  AcpAgent,
  AcpEvent,
  AcpPermissionPolicy,
  AcpSession,
  NormalizedMessage,
  NormalizedRequest,
} from "../core/types.js"
import { allowAllPermissions, denyAllPermissions } from "../core/types.js"
import { SessionPool } from "../core/session-pool.js"
import type { TurnLease } from "../core/session-pool.js"
import { agentKey, agentLabel, allowsEveryTool } from "../settings.js"
import type { AcpProviderSettings } from "../settings.js"
import { makeProtocol } from "./opencode-protocol.js"
import type { AcpBody, AcpFrame, ReducerState } from "./opencode-protocol.js"

/** The route's id: stable, and readable in a diagnostic. */
export const ROUTE_ID = "acp-stdio"

/** The value of `route.provider`: the provider identity as OpenCode reports it. */
export const PROVIDER = ProviderID.make("acp")

/**
 * A **fake** but valid URL.
 *
 * Note: it is never called, since the ACP transport does no HTTP. But
 * `compileRequest` renders the endpoint **before** choosing the transport, and
 * `Route.model` refuses a route without a `baseURL`; an invalid placeholder
 * (`"acp"`) would fail the route for a reason unrelated to real behaviour.
 */
const PLACEHOLDER_BASE_URL = "http://acp.local"

// ─────────────────────────────────────────────────────────────────────────────
// Prepared request
// ─────────────────────────────────────────────────────────────────────────────

/** What `prepare` produces: exactly what `execute` needs. */
export interface AcpPrepared {
  /** Model option value to apply before the prompt. */
  readonly model: string
  /** The normalised request, already rendered by the protocol. */
  readonly request: NormalizedRequest
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/** Label common to every message: without it, "ACP connection closed" says nothing. */
const labelOf = (settings: AcpProviderSettings): string => agentLabel(settings)

/**
 * Turns any exception into an `AIError`.
 *
 * Note: there is no `TransportError.transport: "stdio"`, so this stays in
 * `ProviderInternalError` - which remains in the `AIError` union, hence in
 * OpenCode's `retry` hook, but **without** a `status`. That is a deliberate
 * limitation: `RateLimitError` and `QuotaExceededError` remain reachable for an
 * error *reported by the agent*, not for the death of the pipe.
 */
export const toAiError = (error: unknown, settings: AcpProviderSettings): AIError => {
  if (error instanceof AIError) return error
  const label = labelOf(settings)
  // `AcpAgentError` already carries the command and the stderr queue: do not
  // wrap it in a second message that would drown it in Effect jargon.
  const detail =
    error instanceof AcpAgentError
      ? error.message
      : `${error instanceof Error ? error.message : String(error)}`
  return new AIError({
    reason: new ProviderInternalError({ message: `${label}: ${detail}`, cause: error }),
  })
}

/** An `Effect.tryPromise` that cannot let anything escape the `AIError` union. */
const attempt = <A>(settings: AcpProviderSettings, run: () => Promise<A>): Effect.Effect<A, AIError> =>
  Effect.tryPromise({
    try: run,
    catch: (error: unknown) => toAiError(error, settings),
  })

// ─────────────────────────────────────────────────────────────────────────────
// Process cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The permission policy applied to the agent.
 *
 * Note: `allowedTools` is only applied as an **all-or-nothing switch**. A
 * whitelist of names would require knowing the tool's name at the moment of the
 * permission request - and `PermissionRequest` has no `name` field, because the
 * ACP spec makes `toolCallUpdate.name` optional. Degrading a whitelist to "refuse
 * everything" is the **fail-safe** choice: someone who whitelists tools expects
 * a restriction, and gets none.
 */
const policyOf = (settings: AcpProviderSettings): AcpPermissionPolicy =>
  allowsEveryTool(settings) ? allowAllPermissions : denyAllPermissions

/**
 * Live ACP agents, indexed by `agentKey`.
 *
 * Note: the `Map` key is kept **in addition to** the promise: without it, two
 * providers wanting exactly the same agent would share nothing, since the key
 * cannot be derived from the value.
 */
const agents = new Map<string, Promise<AcpAgent>>()

/**
 * The ACP agent matching the settings, launched if needed.
 *
 * Note: a **rejected** promise is removed from the cache. Otherwise a
 * non-existent command would fail "forever" in this process, and the error
 * message of the **first** attempt (incomplete install?) would keep being
 * returned long after the user fixed their configuration.
 */
export const acquireAgent = (settings: AcpProviderSettings): Promise<AcpAgent> => {
  const key = agentKey(settings)
  const existing = agents.get(key)
  if (existing !== undefined) return existing
  const started = createAcpAgent({
    command: settings.command,
    ...(settings.args === undefined ? {} : { args: settings.args }),
    ...(settings.cwd === undefined ? {} : { cwd: settings.cwd }),
    ...(settings.env === undefined ? {} : { env: settings.env }),
    // The policy is a settings **value**, not a function: a provider package
    // only receives JSON.
    policy: policyOf(settings),
    stderr: settings.stderr ?? "pipe",
    // The agent's stderr is **always** captured but only relayed if someone
    // listens: as a provider nobody supplied an `onStderr`, and dropping those
    // lines would mean losing the only source that says why the agent died. The
    // `"inherit"` mode already writes to our own stderr.
    onStderr:
      settings.stderr === "inherit"
        ? undefined
        : (chunk: string) => {
            process.stderr.write(`[${labelOf(settings)}] ${chunk}`)
          },
  })
  agents.set(key, started)
  started.catch(() => {
    if (agents.get(key) === started) agents.delete(key)
  })
  return started
}

/** Closes every cached agent and empties the cache (tests, server shutdown). */
export const closeCachedAgents = async (): Promise<void> => {
  // Sessions **before** agents: a still-open session references the agent it
  // uses, and closing the agent first would send `session/close` to an already
  // killed process. Harmless - the pool swallows close errors - but needlessly
  // late.
  await closeAllSessions()
  const pending = [...agents.values()]
  agents.clear()
  await Promise.all(pending.map(async (started) => {
    const agent = await started.catch(() => undefined)
    await agent?.close()
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistent sessions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ACP session pools, **one per agent process**.
 *
 * Note: the key is `agentKey`, exactly the process cache's: two providers
 * launching the same command share one agent, hence its sessions, and two
 * different commands share no memory. A different key here would produce either
 * an unusable session or - worse - a delta sent to the wrong agent.
 */
const pools = new Map<string, SessionPool<AcpSession>>()

/** The session pool of the agent process matching the settings, created if needed. */
const poolFor = (settings: AcpProviderSettings): SessionPool<AcpSession> => {
  const key = agentKey(settings)
  const existing = pools.get(key)
  if (existing !== undefined) return existing
  const created = new SessionPool<AcpSession>()
  pools.set(key, created)
  return created
}

/**
 * Closes **every** retained ACP session, all agents alike.
 *
 * This is the shutdown entry point: the plugin calls it on exit, and the tests at
 * the end of a run. Without it, a stopping OpenCode server would leave sessions
 * open on agents it kills immediately after - the agent would see
 * `session/close` on turns still in flight, and the pool would keep orphan
 * promises.
 */
export const closeAllSessions = async (): Promise<void> => {
  const pending = [...pools.values()]
  pools.clear()
  await Promise.all(pending.map((pool) => pool.closeAll()))
}

/** Number of retained ACP sessions, all agents alike (tests, diagnostics). */
export const countRetainedSessions = (): number =>
  [...pools.values()].reduce((total, pool) => total + pool.size, 0)

// ─────────────────────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The working directory of an ACP session.
 *
 * Note: it is the user's `settings.cwd` when there is one, and the server's
 * directory otherwise (`LLMRequest` carries none). The resolved value goes into
 * the session identity (`core/session-key.ts`): two projects must never share
 * agent memory.
 */
const sessionCwd = (settings: AcpProviderSettings): string => settings.cwd ?? process.cwd()

/** Opens a fresh ACP session, attached to nothing. */
const openSessionPromise = (settings: AcpProviderSettings): Promise<AcpSession> =>
  acquireAgent(settings).then((agent) => agent.open({ cwd: sessionCwd(settings) }))

/** Opens the session, with closure guaranteed by the request's `Scope`. */
const openSession = (settings: AcpProviderSettings): Effect.Effect<
  AcpSession,
  AIError,
  Scope.Scope
> =>
  Effect.acquireRelease(
    attempt(settings, () => openSessionPromise(settings)),
    (session) =>
      // A session that does not close leaves a turn in flight agent-side and
      // blocks the following turns on `turnInFlight`: a close error is
      // **never** allowed to surface.
      Effect.promise(() => session.close()).pipe(Effect.ignore),
  )

/**
 * What a turn holds, in both modes.
 *
 * Note: `fresh` and `reuse` share this shape so that `execute` is written
 * **once**. The mode is no longer an `if` scattered through the turn mechanics;
 * it is decided **before**, and everything after (model, effort, cancellation,
 * frames) is identical. That is what makes the `fresh` fallback genuinely safe:
 * there is no path "half in reuse".
 */
interface TurnSession {
  readonly session: AcpSession
  /** `true` if the session came from the pool: it only receives the delta. */
  readonly reused: boolean
  /** What to send: the delta when resumed, the whole history otherwise. */
  readonly messages: readonly NormalizedMessage[]
  /** Marks the session unusable (cancelled turn, dead agent). */
  poison(): void
  /** Gives the serialisation queue back, and closes the session if poisoned. */
  release(): void
}

/** `fresh` mode (the default): one session per request, closed at end of turn. */
const beginFresh = (
  settings: AcpProviderSettings,
  prepared: AcpPrepared,
): Effect.Effect<TurnSession, AIError, Scope.Scope> =>
  Effect.map(openSession(settings), (session) => ({
    session,
    reused: false,
    messages: prepared.request.messages,
    // The session is closed by `openSession`'s finaliser: there is nothing to
    // release here, and "poisoning" a session that is about to die is meaningless.
    poison: () => {},
    release: () => {},
  }))

/** `reuse` mode: one durable session per conversation, delta on every turn. */
const beginReuse = (
  settings: AcpProviderSettings,
  prepared: AcpPrepared,
): Effect.Effect<TurnSession, AIError, Scope.Scope> =>
  Effect.acquireRelease(
    attempt(settings, () =>
      poolFor(settings).acquire(
        {
          agent: agentKey(settings),
          cwd: sessionCwd(settings),
          // The model goes into the key: a session applied its own via
          // `set_config_option` before its first turn, and its memory is worth
          // nothing to another.
          model: prepared.model,
        },
        prepared.request.messages,
        () => openSessionPromise(settings),
      ),
    ),
    (turn) => Effect.sync(turn.release),
  ).pipe(
    Effect.map(
      (lease: TurnLease<AcpSession>): TurnSession => ({
        session: lease.session,
        reused: lease.reused,
        messages: lease.delta,
        // Both functions are **arrows** in the pool: detaching them changes
        // nothing about what they close over.
        poison: lease.poison,
        release: lease.release,
      }),
    ),
  )

/**
 * The switch: `session: "reuse"` reuses, `session: "fresh"` (and the absence of
 * the field) opens a fresh session.
 *
 * Note: the default is **explicit**: only the literal `"reuse"` arms reuse. An
 * absent, invalid, or older `settings.session` therefore falls back to `fresh` -
 * the slowest mode, but the only one whose correctness can be guaranteed. Reuse
 * remains a heuristic: it must only activate when it was asked for.
 */
const beginTurn = (
  settings: AcpProviderSettings,
  prepared: AcpPrepared,
): Effect.Effect<TurnSession, AIError, Scope.Scope> =>
  settings.session === "reuse" ? beginReuse(settings, prepared) : beginFresh(settings, prepared)

/**
 * Applies a session option value **before** the prompt.
 *
 * Note: three cases, three treatments. The agent has no option in that category
 * (it has only a model, or only an effort: there is nothing to do). The
 * requested value is already the current one (no useless `set_config_option` is
 * sent, which would cost a JSON-RPC round trip per turn). The value is **not**
 * in the list: it fails with the list in front of the user rather than letting
 * the agent silently refuse a value, or worse, pick another one.
 *
 * Note: `label` names the thing requested ("model", "effort level"). The same
 * code serves both, and a message reading 'model "high"' would be worse than
 * unusable.
 */
const applyOption = async (
  session: AcpSession,
  category: "model" | "thought_level",
  label: string,
  value: string,
  settings: AcpProviderSettings,
): Promise<void> => {
  const option = session.inventory().options.find((entry) => entry.category === category)
  if (option === undefined) return
  if (option.currentValue === value) return
  if (!option.values.includes(value)) {
    throw new AcpAgentError(
      `${labelOf(settings)}: ${label} « ${value} » n'est pas proposé par cet agent ` +
        `(valeurs acceptées : ${option.values.join(", ")})`,
      labelOf(settings),
    )
  }
  await session.setOption(option.id, value)
}

/** Applies the requested model - the `Model.ID` comes from the request. */
const applyModel = async (
  session: AcpSession,
  model: string,
  settings: AcpProviderSettings,
): Promise<void> => applyOption(session, "model", "le modèle", model, settings)

/**
 * Applies the effort level of the selected variant.
 *
 * Note: this happens **after** `applyModel`, never before. The list of accepted
 * levels depends on the current model agent-side (`none` disappears on
 * `claude-sonnet-5` for `copilot --acp`), and `setOption` relays the complete
 * state returned by the agent - so this is the only way to validate against the
 * right list.
 *
 * Note: an effort absent from the settings sends nothing: the agent keeps the
 * value it announces in `session/new`. That is the correct behaviour for a
 * `/model` with no variant selected.
 */
const applyEffort = async (
  session: AcpSession,
  settings: AcpProviderSettings,
): Promise<void> => {
  const effort = settings.effort
  if (effort === undefined) return
  await applyOption(session, "thought_level", "le niveau d'effort", effort, settings)
}


/**
 * Turn cancellation signal, armed by the closing of the `Scope`.
 *
 * Note: **why merely abandoning the iterator is not enough.** `@opencode/ai`'s
 * `TransportRuntime` carries **no** interruption signal: when OpenCode
 * abandons the stream, the `Scope` closes and... nothing else happens. The ACP
 * generator is then left **suspended** in `await session.nextUpdate()` while the
 * agent goes on working. Yielding is therefore not enough: the agent has to be
 * *told* to stop, or it burns a full turn behind our back and keeps its session
 * busy.
 *
 * Hence this controller: it is armed by a finaliser of the **same** `Scope` as
 * the session, so it fires exactly when the request is interrupted. And since a
 * `Scope`'s finalisers run in **reverse** registration order, this one
 * (registered after `openSession`) runs **before** the session is closed: the
 * wire order is therefore `session/cancel` then `session/close`, as the
 * specification requires.
 */
const turnCancellation = Effect.acquireRelease(
  Effect.sync(() => new AbortController()),
  (controller) =>
    Effect.sync(() => {
      if (!controller.signal.aborted) controller.abort()
    }),
)

// ─────────────────────────────────────────────────────────────────────────────
// Frames
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A frame = a JSON string.
 *
 * Note: serialising rather than emitting the object is not a whim. The
 * `Protocol` decodes every frame with `Schema.decodeUnknownEffect`, and
 * `jsonEvent` is the only `string -> Event` codec in the public API. The gain - a
 * frame inspectable in a log - is worth the JSON round trip over a few hundred
 * bytes.
 *
 * Note: `input` is normalised to `{}` when the agent sent none. The reason is
 * technical and admits no exception: `JSON.stringify` **drops** `undefined` keys,
 * the core decoder requires the key to be present, and an ACP `tool_call_update`
 * that only changes a status has no `rawInput`. Without this normalisation the
 * turn would fail with "Invalid acp/acp-stdio stream event" - a message
 * mentioning neither the tool nor the agent.
 */
const toFrame = (event: AcpEvent): string =>
  JSON.stringify(
    event.type === "tool" ? { ev: { ...event, input: event.input ?? {} } } satisfies AcpFrame : { ev: event } satisfies AcpFrame,
  )

/** Turns an exception of the ACP generator into an `AIError` (an aborted frame, not a silent one). */
const toFrameError = (error: unknown, settings: AcpProviderSettings): AIError => toAiError(error, settings)

// ─────────────────────────────────────────────────────────────────────────────
// The transport
// ─────────────────────────────────────────────────────────────────────────────

/** `prepare`: the body already rendered by the protocol, validated before any spawn. */
const prepare = (input: TransportPrepareInput<AcpBody>): Effect.Effect<AcpPrepared, AIError> => {
  const body = input.body
  if (body.request.messages.length === 0) {
    // A turn with no message is an upstream bug, not an empty answer: the agent
    // would reply "ACK:" and the user would watch an empty turn end without
    // understanding why.
    return Effect.fail(
      new AIError({
        reason: new InvalidRequestError({
          message: "requête sans aucun message : il n'y a rien à envoyer à l'agent ACP",
        }),
      }),
    )
  }
  return Effect.succeed({ model: body.model, request: body.request })
}

/**
 * `execute`: one `Scope` per request, one ACP session per conversation (`reuse`
 * mode) or per request (`fresh` mode).
 *
 * The `Scope` is what makes cancellation clean: when OpenCode interrupts the
 * stream (or the TUI abandons the turn), the `Scope` closes, the cancellation
 * controller fires - so the agent receives `session/cancel` - and then the
 * session is released. In `fresh` mode that release **closes** it; in `reuse`
 * mode it returns it to the pool, **unless** the turn was poisoned, in which
 * case the close happens anyway. That is exactly the net guaranteeing that a
 * forgotten stream leaves neither a corrupted session nor a live process.
 */
const execute = (
  prepared: AcpPrepared,
  _request: LLMRequest,
  _runtime: TransportRuntime,
  settings: AcpProviderSettings,
): Effect.Effect<TransportExecution<string>, AIError, Scope.Scope> =>
  Effect.gen(function* () {
    // The mode is decided **before** everything else: `beginTurn` always
    // returns a `TurnSession`, and nothing after it knows (nor should know) which
    // mode produced the session.
    const turn = yield* beginTurn(settings, prepared)
    // Registered **after** `beginTurn`: a `Scope`'s finalisers run in reverse
    // order, so cancellation fires before the release - and the poisoning before
    // the cancellation, since it is what decides whether the session is closed.
    const cancellation = yield* turnCancellation
    yield* Effect.acquireRelease(
      Effect.succeed(undefined),
      // Interrupted turn: the session's memory can no longer be considered
      // reliable. Marking it here - rather than closing on the spot - lets the
      // cancellation controller send `session/cancel` **before** the close, in
      // the order the specification requires.
      () =>
        Effect.sync(() => {
          if (cancellation.signal.aborted) turn.poison()
        }),
    )
    yield* attempt(settings, () => applyModel(turn.session, prepared.model, settings))
    yield* attempt(settings, () => applyEffort(turn.session, settings))
    // The delta replaces the transcript only if the session was **actually**
    // resumed. In `fresh` mode, and on the first turn of a conversation, the
    // request is sent as-is: the prompt stays byte for byte the one before.
    const request: NormalizedRequest = turn.reused
      ? { ...prepared.request, messages: turn.messages, resume: true }
      : prepared.request
    const frames: Stream.Stream<string, AIError> = Stream.fromAsyncIterable(
      // The signal is passed **and** the iterator stays abandonable: both
      // cancellation paths (stream interruption, signal armed by the Scope)
      // converge on the same `session/cancel`, and the agent is stopped even if
      // the generator remains suspended in `nextUpdate()`.
      turn.session.prompt(request, { signal: cancellation.signal }),
      // An exception from the generator becomes a stream failure: an `AIError`
      // naming the command is better than a frame aborted in silence.
      (error: unknown) => toFrameError(error, settings),
    ).pipe(
      Stream.map((event) => {
        // An `error` mid-turn leaves the agent's memory in a state whose
        // continuity can no longer be guaranteed: the session is marked, so it is
        // closed on release, and the next turn starts from a fresh session with
        // the whole history.
        if (event.type === "error") turn.poison()
        return toFrame(event)
      }),
    )
    // No `complete`: the core calls it after consuming the stream *and* closing
    // it, which is too late for an ACP session. Closure is carried by the
    // `Scope`, which closes at exactly the same moment.
    return { frames }
  })

/** The transport, closed over its settings (the route is rebuilt for each). */
export const makeTransport = (
  settings: AcpProviderSettings,
): TransportDef<AcpBody, AcpPrepared, string> => ({
  id: `${ROUTE_ID}/transport`,
  prepare,
  execute: (prepared, request, runtime) => execute(prepared, request, runtime, settings),
})

// ─────────────────────────────────────────────────────────────────────────────
// The route
// ─────────────────────────────────────────────────────────────────────────────

/** The complete route, ready to produce a `LanguageModel`. */
export const makeRoute = (settings: AcpProviderSettings): Route<AcpBody, AcpPrepared> =>
  Route.make({
    id: ROUTE_ID,
    provider: PROVIDER,
    // The protocol is built **here**, hence with the settings: that is what
    // lets `systemSuffix` reach `body.from` with no global state.
    protocol: makeProtocol(settings),
    // Mandatory placeholder - see `PLACEHOLDER_BASE_URL`.
    endpoint: Endpoint.path("/", { baseURL: PLACEHOLDER_BASE_URL }),
    // stdio: neither token nor header. `Auth.none` explicitly says "no HTTP
    // authentication" rather than leaving it looking missing.
    auth: Auth.none,
    compact: undefined,
    transport: makeTransport(settings),
  })

/** The reducer's state, re-exported so the tests only import the adapter. */
export type { ReducerState }
