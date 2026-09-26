#!/usr/bin/env bun
/**
 * A fake ACP agent, built with the **real** SDK (`acp.agent()`) and speaking
 * over stdio, exactly like `copilot --acp`. The tests spawn it as a subprocess,
 * so what is tested is the whole chain spawn -> ndJsonStream -> initialize ->
 * session/new -> session/prompt, not a simplified in-process version.
 *
 * Observable behaviour (deterministic, no latency by default):
 *   - `initialize`  -> protocol v1, `agentInfo: { name: "fake-acp", ... }`
 *   - `session/new`  -> 4 realistic `configOptions` (3 models, 3 effort levels,
 *                      2 modes including one with a long URL, permissions)
 *   - `session/prompt` (keywords are looked for in the **last user message** of
 *     the transcript, not in the whole prompt - see `userText`):
 *       - contains `PING`           -> one text chunk: `{"type":"text","text":"PONG"}`
 *       - contains `TICK`           -> a `thought`, a long interruptible latency,
 *                                      then `{"type":"text","text":"TOK"}`
 *       - contains `TOOL_PROPOSAL`  -> a JSON tool proposal
 *       - contains `TOOL`           -> `tool_call` then two `tool_call_update`,
 *                                      then `{"type":"text","text":"TOOL_OK"}`
 *       - contains `PLAN`           -> a `plan` notification, then `PLAN_OK`
 *       - contains `NEED_PERMISSION`-> permission, then `ALLOWED`/`DENIED`/`CANCELLED`
 *       - otherwise                 -> `{"type":"text","text":"ACK: <prompt>"}`
 *     then `stop` with a `usage`.
 *
 * Note: **why all of this obeys `core/prompt.ts`'s JSON contract.** The provider
 * **buffers** the agent's text and decodes it at the `done`: a fake agent
 * answering "ACK: ..." in raw prose would fail **every** end-to-end turn with a
 * `provider-error`. An over-polite agent lets mutations through, and the first
 * instinct of a fake is to be inaccurate: it therefore obeys the contract, and
 * `FAKE_OUTPUT` makes it play the part of a non-obeying agent on demand.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Configuration through environment variables
 *
 * The fake is configurable because an over-polite agent lets mutations through:
 * `tool_call`, `stopReason != end_turn`, `boolean` options, policy fallback,
 * noise on stdout, dying mid-prompt... were untestable. Each variable makes a
 * case trivial to reach from `acp.test.ts`.
 *
 * | Variable                       | Effect                                                     |
 * | ------------------------------ | ---------------------------------------------------------- |
 * | `FAKE_EMIT_TOOL_CALL=1`        | emits `tool_call` + `tool_call_update` (pending->in_progress->completed) |
 * | `FAKE_EMIT_USAGE_UPDATE=1`     | emits a `usage_update` notification (context window)       |
 * | `FAKE_CUMULATIVE_USAGE=1`      | the turn reports the **session's** cache accounting, as a resumed agent does |
 * | `FAKE_STOP_REASON=<x>`         | the turn's `stopReason` (`max_tokens`, `refusal`, `cancelled`) |
 * | `FAKE_BOOLEAN_OPTION=1`        | adds a `configOption` of `type: "boolean"`                 |
 * | `FAKE_EFFORT_ID=<id>`          | renames the `thought_level` option's `id` (`opencode acp` uses `effort`) |
 * | `FAKE_NO_PERMISSIONS=1`        | publishes **no** `permissions` category                     |
 * | `FAKE_NO_CONFIG_OPTIONS=1`     | `session/new` **omits** `configOptions` (non-conforming third party) |
 * | `FAKE_SET_OMITS_CONFIG_OPTIONS=1` | `set_config_option` answers without `configOptions`      |
 * | `FAKE_ECHO_CONFIG=1`           | `PING` answers `PONG <model> <effort>`: the current options |
 * | `FAKE_REJECT_UNKNOWN_MODEL=1`  | `set_config_option` refuses a value outside the list (`Invalid model`) |
 * | `FAKE_PERMISSION_OPTIONS=<x>`  | `reject` \| `allow` \| `cancel`: only those options are offered |
 * | `FAKE_DIE_ON_PROMPT=1`         | exits mid-prompt (before the `stop`)                       |
 * | `FAKE_NOISY_STDOUT=1`          | writes non-JSON on stdout before the protocol              |
 * | `FAKE_EXIT_AT_INIT=1`          | exits before answering `initialize`                        |
 * | `FAKE_SLOW_INIT_MS=<n>`        | `initialize` only answers after `<n>` ms (tests the timeout) |
 * | `FAKE_SLOW_MS=<n>`             | deliberate latency, interruptible by `session/cancel`      |
 * | `FAKE_CANCEL_FILE=<path>`      | records every `session/cancel` received (dated proof of the cancellation) |
 * | `FAKE_OUTPUT=<x>`              | answer shape: `contract` (default), `raw`, `fenced`, `hallucinated`, `bad-type` |
 * | `FAKE_PROMPT_FILE=<path>`      | writes the prompt **received**, character by character, to this file |
 */

import { appendFileSync, writeFileSync } from "node:fs"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

// ─────────────────────────────────────────────────────────────────────────────
// Configuration through environment variables
// ─────────────────────────────────────────────────────────────────────────────

const flag = (name: string): boolean => process.env[name] === "1"

/** Reads a positive integer; `0` (or an absent / invalid value) means no latency. */
const positiveInt = (name: string): number => {
  const raw = process.env[name]
  if (raw === undefined) return 0
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** The only `stopReason`s an agent is supposed to be able to return. */
const STOP_REASONS = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"] as const

const STOP_REASON = ((): acp.StopReason => {
  const raw = process.env["FAKE_STOP_REASON"]
  const found = STOP_REASONS.find((reason) => reason === raw)
  return found ?? "end_turn"
})()

/** `initialize` latency: used to trigger the client-side timeout. */
const SLOW_INIT_MS = positiveInt("FAKE_SLOW_INIT_MS")

/** Latency shared by `wait()`. */
const SLOW_MS = positiveInt("FAKE_SLOW_MS")

/**
 * The fake agent's answer shape.
 *
 * `contract` is the only "honest" mode: it is what an agent that understood the
 * instruction produces, and therefore the default for end-to-end turns. The
 * others replay the mutations that are most expensive to reach with a real agent:
 * not answering in the requested format at all, burying it in a markdown block,
 * proposing a tool that does not exist, or getting the `type` wrong.
 */
type OutputMode = "contract" | "raw" | "fenced" | "hallucinated" | "bad-type"

const OUTPUT_MODE = ((): OutputMode => {
  const raw = process.env["FAKE_OUTPUT"]
  if (raw === "raw" || raw === "fenced" || raw === "hallucinated" || raw === "bad-type") return raw
  return "contract"
})()

/** The contract's JSON, possibly deformed according to `FAKE_OUTPUT`. */
const answer = (text: string): string => {
  const contract = JSON.stringify({ type: "text", text })
  switch (OUTPUT_MODE) {
    case "raw":
      return text
    case "fenced":
      return `Voici ma réponse :\n\`\`\`json\n${contract}\n\`\`\`\n`
    case "hallucinated":
      return JSON.stringify({ type: "tool", name: "outil_qui_nexiste_pas", arguments: {} })
    case "bad-type":
      return JSON.stringify({ type: "réponse", text })
    default:
      return contract
  }
}

/** A `thought`: the only content still streamed live. */
const thought = (text: string): acp.SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
})

/** The contract's "tool" shape, also deformed by `FAKE_OUTPUT`. */
const answerTool = (name: string, args: Record<string, unknown>): string => {
  if (OUTPUT_MODE === "raw") return `${name} ${JSON.stringify(args)}`
  return JSON.stringify({ type: "tool", name, arguments: args })
}

/** The set of permission options offered during a `session/request_permission`. */
type PermissionFlavor = "mixed" | "reject" | "allow" | "cancel"

const PERMISSION_FLAVOR = ((): PermissionFlavor => {
  const raw = process.env["FAKE_PERMISSION_OPTIONS"]
  if (raw === "reject" || raw === "allow" || raw === "cancel") return raw
  return "mixed"
})()

const ALLOW_OPTION: acp.PermissionOption = {
  optionId: "allow-once",
  name: "Autoriser une fois",
  kind: "allow_once",
}
const REJECT_OPTION: acp.PermissionOption = {
  optionId: "reject-once",
  name: "Refuser",
  kind: "reject_once",
}

const PERMISSION_OPTIONS: readonly acp.PermissionOption[] = (() => {
  switch (PERMISSION_FLAVOR) {
    case "allow":
      return [ALLOW_OPTION]
    case "reject":
      return [REJECT_OPTION]
    // No option at all: forces the policy's `cancelled` fallback.
    case "cancel":
      return []
    default:
      return [ALLOW_OPTION, REJECT_OPTION]
  }
})()

// ─────────────────────────────────────────────────────────────────────────────
// Inventory data
// ─────────────────────────────────────────────────────────────────────────────

const MODELS = [
  { value: "auto", name: "Auto", description: "Laisse l'agent choisir" },
  { value: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { value: "claude-sonnet-5", name: "Claude Sonnet 5" },
]

const THOUGHT_LEVELS = ["none", "medium", "high"]

/**
 * The `id` of the `thought_level` option.
 *
 * Note: the default reproduces `copilot --acp` (`reasoning_effort`), but **no
 * agent is obliged to name its options after ours**. `opencode acp` uses
 * `effort` for the very same category, and a category is never a valid
 * `configId`. The fake is therefore renameable: a suite that only ever saw
 * `reasoning_effort` would pass with a category sent on the wire.
 */
const EFFORT_OPTION_ID = process.env["FAKE_EFFORT_ID"] ?? "reasoning_effort"

/** The mode ids are URLs: that is the real case worth covering. */
const MODES = [
  { value: "https://agentclientprotocol.com/registry/modes/agent#agent", name: "Agent" },
  { value: "https://agentclientprotocol.com/registry/modes/plan#plan", name: "Plan" },
]

const BOOLEAN_OPTION: acp.SessionConfigOption = {
  id: "telemetry",
  name: "Telemetry",
  type: "boolean",
  category: "permissions",
  currentValue: false,
}

const CONFIG_OPTIONS: acp.SessionConfigOption[] = [
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "gpt-5.6-terra",
    options: MODELS,
  },
  {
    id: EFFORT_OPTION_ID,
    name: "Reasoning effort",
    type: "select",
    category: "thought_level",
    currentValue: "medium",
    options: THOUGHT_LEVELS.map((value) => ({ value, name: value })),
  },
  {
    id: "mode",
    name: "Mode",
    type: "select",
    category: "mode",
    currentValue: MODES[0]?.value ?? "",
    options: MODES,
  },
  // `FAKE_NO_PERMISSIONS=1`: `opencode acp` publishes no `permissions` category,
  // and the client must run on a single model rather than assume it is there.
  ...(flag("FAKE_NO_PERMISSIONS")
    ? []
    : [
        {
          id: "allow_all",
          name: "Allow all tools",
          type: "select",
          category: "permissions",
          currentValue: "off",
          options: [
            { value: "on", name: "On" },
            { value: "off", name: "Off" },
          ],
        },
      ] as acp.SessionConfigOption[]),
  // `FAKE_BOOLEAN_OPTION=1`: the only way to exercise the typed
  // `{ type: "boolean", value: bool }` payload of `session/set_config_option`.
  ...(flag("FAKE_BOOLEAN_OPTION") ? [BOOLEAN_OPTION] : []),
]

/**
 * Turn counters, with the optional fields actually filled in: that is the shape
 * observed on `copilot --acp`, and it must survive all the way to the
 * `AcpEvent` to feed OpenCode's `Usage` class.
 */
const USAGE = {
  totalTokens: 42,
  inputTokens: 40,
  outputTokens: 2,
  thoughtTokens: 1,
  cachedReadTokens: 7,
  cachedWriteTokens: 9,
}

/**
 * The same turn as a **resumed** agent accounts for it: the whole session's
 * cache, which is what makes `input` a running total instead of the window.
 */
const CUMULATIVE_USAGE = {
  totalTokens: 137_298,
  inputTokens: 136_867,
  outputTokens: 2,
  thoughtTokens: 1,
  cachedReadTokens: 106_805,
  cachedWriteTokens: 29_962,
}

/** Context window, in `usage_update`. */
const CONTEXT_USED = 12_345

/**
 * Separates two prompts deposited in the same `FAKE_PROMPT_FILE`.
 *
 * A prompt is free text: it can contain any line. The separator is therefore a
 * **whole line**, not a string insensitive to what the body contains. The test
 * only ever deposits one turn per file anyway - it is the robustness of the
 * deposit, not its slicing, that matters.
 */
const PROMPT_SEPARATOR = "-----8<-- PROMPT REÇU --8<-----"

const chunk = (text: string): acp.SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
})

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/** Per-session state: lets `session/set_config_option` be genuinely mutable. */
class FakeAgent {
  private readonly sessions = new Map<string, acp.SessionConfigOption[]>()
  /** Sessions whose running turn was cancelled by `session/cancel`. */
  private readonly cancelled = new Set<string>()

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    // `FAKE_CAPABILITIES_FILE=<path>`: what the client **declared** it could do
    // is recorded. That is the only way to verify from outside that `initialize`
    // announces no false capabilities.
    const capabilities = process.env["FAKE_CAPABILITIES_FILE"]
    if (capabilities !== undefined) {
      writeFileSync(capabilities, JSON.stringify(params.clientCapabilities ?? null))
    }
    if (SLOW_INIT_MS > 0) {
      // Answers late but correctly: it is the **client's timeout** that must
      // fire, and it must kill the agent by exiting with an error.
      await new Promise((resolve) => setTimeout(resolve, SLOW_INIT_MS))
    }
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
      agentInfo: { name: "fake-acp", version: "0.1.0" },
    }
  }

  newSession(): acp.NewSessionResponse {
    const sessionId = `fake-${Math.random().toString(16).slice(2, 10)}`
    this.sessions.set(sessionId, structuredClone(CONFIG_OPTIONS))
    const response: acp.NewSessionResponse = {
      sessionId,
      configOptions: structuredClone(CONFIG_OPTIONS),
    }
    // `FAKE_NO_CONFIG_OPTIONS=1`: the field is **omitted**. A third-party agent
    // is not obliged to send it, and the client must not blow up on
    // `undefined` at the next `inventory()`. (`Reflect.deleteProperty` because
    // `delete` would require an optional field - and the test must send an
    // object *genuinely* lacking the field, not one typed `undefined`.)
    if (flag("FAKE_NO_CONFIG_OPTIONS")) Reflect.deleteProperty(response, "configOptions")
    return response
  }

  setConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): acp.SetSessionConfigOptionResponse {
    // `FAKE_REJECT_UNKNOWN_MODEL=1`: behaves like `copilot`, which answers
    // -32602 "Invalid model" with the list of accepted values.
    if (
      flag("FAKE_REJECT_UNKNOWN_MODEL") &&
      params.configId === "model" &&
      !MODELS.some((m) => m.value === params.value)
    ) {
      // An explicit `RequestError`: a raw `Error` throw would surface as
      // -32603 "Internal error", without the useful message.
      throw acp.RequestError.invalidParams(
        { supported: MODELS.map((m) => m.value) },
        `Invalid model: ${String(params.value)}`,
      )
    }
    // An unknown `configId` is refused, like every real agent measured
    // (`Unknown config option '...'` on copilot, `unknown config option` on
    // opencode). Accepting everything here is what let a **category** be sent
    // as a `configId` pass unnoticed: the fake answered a request no agent
    // would have honoured. The `set` below matches nothing in that case, so a
    // lenient fake turns a protocol violation into a silent no-op.
    const known = this.sessions.get(params.sessionId) ?? CONFIG_OPTIONS
    if (!known.some((option) => option.id === params.configId)) {
      throw acp.RequestError.invalidParams(
        { configId: params.configId },
        `Unknown config option '${params.configId}'`,
      )
    }
    const current = this.sessions.get(params.sessionId) ?? structuredClone(CONFIG_OPTIONS)
    const next = current.map((option) => {
      if (option.id !== params.configId) return option
      if (option.type === "boolean") {
        return { ...option, currentValue: params.value === true }
      }
      return { ...option, currentValue: String(params.value) }
    })
    this.sessions.set(params.sessionId, next)
    // The spec requires returning the complete state. A non-conforming agent
    // omits it: the client must then **keep** its current state, not empty it.
    const response: acp.SetSessionConfigOptionResponse = { configOptions: next }
    if (flag("FAKE_SET_OMITS_CONFIG_OPTIONS")) {
      Reflect.deleteProperty(response, "configOptions")
    }
    return response
  }

  /** `session/cancel`: the session is remembered, `wait()` notices on the next tick. */
  cancel(params: acp.CancelNotification): void {
    this.cancelled.add(params.sessionId)
    // `FAKE_CANCEL_FILE=<path>`: the **dated** proof of the cancellation is
    // deposited. Without it a test can only check that the cancellation was
    // *requested* - which is precisely the point: a fast return does not prove
    // `session/cancel` went out, only that we stopped waiting.
    const file = process.env["FAKE_CANCEL_FILE"]
    if (file !== undefined) appendFileSync(file, `${Date.now()} ${params.sessionId}\n`)
  }

  /**
   * Current model and effort values, for the tests that check the adapter
   * **applied** them before the prompt.
   *
   * Without this, `set_config_option` would be a JSON-RPC round trip with no
   * observable counterpart: the test would pass even if the variant wiring
   * disappeared, which is precisely the regression to watch.
   */
  private echoConfig(sessionId: string): string {
    const current = this.sessions.get(sessionId) ?? CONFIG_OPTIONS
    const read = (category: string): string => {
      const option = current.find((entry) => entry.category === category)
      return option === undefined ? "?" : String(option.currentValue)
    }
    return `PONG ${read("model")} ${read("thought_level")}`
  }

  /**
   * Interruptible latency: unlike `setTimeout`, it **reacts** to
   * `session/cancel`, which makes it possible to test cancellation without a
   * race.
   */
  private async wait(sessionId: string): Promise<void> {
    const deadline = Date.now() + SLOW_MS
    while (!this.cancelled.has(sessionId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  async prompt(
    params: acp.PromptRequest,
    cx: acp.AgentContext,
  ): Promise<acp.PromptResponse> {
    // `FAKE_PROMPT_FILE=<path>`: the prompt **exactly as it was received** on
    // the wire is deposited. That is the only possible proof of what
    // `fromRequest` + `renderRequest` reconstruct: the "ACK" branch's echo goes
    // through the output contract and its tolerant extractor, so it does not
    // prove that no character was lost on the way.
    // `appendFileSync` and not `writeFileSync`: two turns on the same session
    // then write two prompts, separated by a marker.
    const promptFile = process.env["FAKE_PROMPT_FILE"]
    if (promptFile !== undefined) {
      appendFileSync(promptFile, `${PROMPT_SEPARATOR}\n${promptText(params)}\n`)
    }
    const text = userText(promptText(params))
    const notify = (update: acp.SessionUpdate): Promise<void> =>
      cx.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update })
    const finish = (stopReason: acp.StopReason = STOP_REASON): acp.PromptResponse => ({
      stopReason,
      usage: flag("FAKE_CUMULATIVE_USAGE") ? CUMULATIVE_USAGE : USAGE,
    })
    const interrupted = (): boolean => this.cancelled.has(params.sessionId)

    // The "TICK" case: a `thought` right away, then a long latency. The
    // `thought` is what still streams live (the text is buffered until the
    // `done`), so it is what makes it possible to check that the turn advances
    // and that the consumer's abandonment returns without waiting.
    if (text.includes("TICK")) {
      await notify(thought("TICK"))
      await this.wait(params.sessionId)
      if (interrupted()) return finish("cancelled")
      await notify(chunk(answer("TOK")))
      return finish()
    }

    await this.wait(params.sessionId)
    if (interrupted()) return finish("cancelled")

    // `usage_update` is a **different** semantic from the end-of-turn `usage`
    // (context window vs turn cost): both must stay distinguishable in the
    // stream, hence two distinct `AcpEvent` variants.
    if (flag("FAKE_EMIT_USAGE_UPDATE")) {
      await notify({ sessionUpdate: "usage_update", used: CONTEXT_USED, size: 200_000 })
    }

    if (text.includes("NEED_PERMISSION")) {
      const response = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "call-perm-1",
          title: "Écrire dans config.json",
          kind: "edit",
          status: "pending",
        },
        options: [...PERMISSION_OPTIONS],
      })
      const selected = response.outcome.outcome === "selected" ? response.outcome.optionId : ""
      const verdict =
        selected === "allow-once" ? "ALLOWED" : selected === "reject-once" ? "DENIED" : "CANCELLED"
      await notify(chunk(answer(verdict)))
    } else if (text.includes("TOOL_PROPOSAL")) {
      // Note: the core path. The agent **proposes** an OpenCode tool and
      // executes nothing itself. It is ordinary text on the ACP side - the
      // reducer decodes it and makes a `tool-call` out of it.
      await notify(chunk(answerTool("read", { filePath: "README.md" })))
    } else if (text.includes("TOOL")) {
      // `tool_call` then `tool_call_update` (pending -> in_progress ->
      // completed), with `content`/`rawOutput` on the final update.
      const toolCallId = "call-tool-1"
      await notify({
        sessionUpdate: "tool_call",
        toolCallId,
        name: "read_file",
        title: "Lire README.md",
        kind: "read",
        status: "pending",
        rawInput: { path: "README.md" },
      })
      await this.wait(params.sessionId)
      await notify({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" })
      await this.wait(params.sessionId)
      await notify({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "# README" } }],
        rawOutput: { bytes: 1234 },
      })
      await notify(chunk(answer("TOOL_OK")))
    } else if (text.includes("PLAN")) {
      await notify({
        sessionUpdate: "plan",
        entries: [
          { content: "Analyser", priority: "high", status: "completed" },
          { content: "Implémenter", priority: "medium", status: "in_progress" },
        ],
      })
      await notify(chunk(answer("PLAN_OK")))
    } else if (text.includes("PING")) {
      await notify(chunk(answer(flag("FAKE_ECHO_CONFIG") ? this.echoConfig(params.sessionId) : "PONG")))
    } else {
      // The "echo" default: it returns the prompt **it received**, which is the
      // only way to check `fromRequest` and `renderRequest` end to end.
      //
      // Note: in `raw` mode only the user message is echoed. The full prompt
      // holds the output contract and its examples, so `parseAgentOutput`'s
      // tolerant extractor would find a **valid** object in it - and "raw" would
      // go down a green path, exactly the false positive this mode is meant to
      // produce.
      await notify(chunk(answer(OUTPUT_MODE === "raw" ? text : `ACK: ${promptText(params)}`)))
    }

    if (flag("FAKE_DIE_ON_PROMPT") && text.includes("DIE")) {
      // Dying mid-turn: the client must see an `error` **then** a `done`, never
      // a silent truncation.
      process.exit(7)
    }

    return finish()
  }

  closeSession(params: acp.CloseSessionRequest): acp.CloseSessionResponse {
    this.sessions.delete(params.sessionId)
    this.cancelled.delete(params.sessionId)
    return {}
  }
}

const promptText = (params: acp.PromptRequest): string =>
  params.prompt
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")

/** What ends a user message: another role, or the next section. */
const END_OF_USER_MESSAGE = /(?:\n## |\n(?:Utilisateur|Assistant|Outil [^\n]*) : )/

/** Start of line of the role prefix written by `renderRequest`. */
const USER_LINE = /^Utilisateur : /gm

/**
 * The **last user message** of the prompt.
 *
 * Note: the fake agent's keywords (`PING`, `TOOL`...) must only apply to what
 * the user actually asked for. Searching the whole prompt was tenable as long as
 * it held only the transcript; it now holds the **output contract**, its examples
 * and the name of every tool - any of those words would make the fake unable to
 * choose its branch. The segment is therefore isolated, from the "Utilisateur :"
 * prefix up to the first line start that is another one, or to the start of the
 * next section.
 */
const userText = (full: string): string => {
  const starts = [...full.matchAll(USER_LINE)]
  const last = starts[starts.length - 1]
  if (last?.index === undefined) return full
  const after = full.slice(last.index + last[0].length)
  const end = after.search(END_OF_USER_MESSAGE)
  return end === -1 ? after : after.slice(0, end)
}

// ─────────────────────────────────────────────────────────────────────────────
// stdio wiring
// ─────────────────────────────────────────────────────────────────────────────

const agent = new FakeAgent()

// `FAKE_PID_FILE=<path>`: our pid is written to disk. That is what lets the
// leak test verify **precisely** that *that* process is dead, rather than
// counting `ps` output and waiting long enough for an orphan to disappear on
// its own.
const PID_FILE = process.env["FAKE_PID_FILE"]
if (PID_FILE !== undefined) {
  writeFileSync(PID_FILE, `${process.pid}\n`)
}

// `FAKE_NOISY_STDOUT=1`: a chatty agent writes before starting the protocol, on
// stdout **and** on stderr. The client must absorb the noise on stdout, and the
// stderr must show up in the error message - it is the only source saying why
// the agent died, and it was dead code as long as the CLI did not expose
// `stderr: "pipe"`.
if (flag("FAKE_NOISY_STDOUT")) {
  process.stdout.write("Ceci n'est pas du JSON, désolé.\n")
  process.stderr.write("fake-acp: avertissement de démarrage\n")
}

if (flag("FAKE_EXIT_AT_INIT")) {
  // Dying before even answering `initialize`: the "the agent is dead" guard must
  // produce an error naming the command and its exit code.
  acp
    .agent({ name: "fake-acp" })
    .onRequest(acp.methods.agent.initialize, () => process.exit(3))
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout),
        Readable.toWeb(process.stdin),
      ),
    )
} else {
  acp
    .agent({ name: "fake-acp" })
    .onRequest(acp.methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
    .onRequest(acp.methods.agent.session.new, () => agent.newSession())
    .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => agent.setConfigOption(ctx.params))
    .onRequest(acp.methods.agent.session.prompt, (ctx) => agent.prompt(ctx.params, ctx.client))
    .onRequest(acp.methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onNotification(acp.methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout),
        Readable.toWeb(process.stdin),
      ),
    )
}
