/**
 * `AcpEvent` -> `LLMEvent`.
 *
 * This module is **the** state machine of the OpenCode adapter, and it is
 * **pure**: no input is required, no process is spawned, no `Effect` is built in
 * the heart of the translation. That is what makes the cases hardest to reach
 * with a real agent testable - a `*-delta` with no `*-start`, an agent dying
 * mid-block - without depending on a subprocess's timing.
 *
 * Note: the event sequence produced here is **strictly validated** by
 * `@opencode/ai`: the slightest malformation fails with "The provider response
 * ended unexpectedly.", a message **indistinguishable** from a truncation. Two
 * rules follow, applied everywhere:
 *
 * 1. at most **one** text or reasoning block open at a time - close before
 *    opening, in both directions;
 * 2. a stream that stops without `step-finish` **and** `finish` is a bug, not a
 *    detail: `halt()` fills the hole, including for an *empty* stream.
 *
 * Note: `usage` must be an **instance** of the `Usage` class. A plain object
 * produces exactly the same error message as a truncated stream; the reducer
 * therefore always builds the instance, and only adds it to the state when the
 * agent actually reported counters.
 *
 * Note: **a turn's text is buffered.** The agent's `text` is no longer
 * translated as it arrives: it is accumulated, then decoded by `core/parse.ts`
 * at the `done`, and rendered in a single block. Until the whole answer has been
 * read, there is no way to know whether it is text or a tool call - and
 * emitting the first `text-delta` earlier would show the contract's raw JSON in
 * the transcript. It is a deliberate trade-off: what still streams live is the
 * agent's activity (`thought` -> `reasoning-*`, `plan`), so the user is never
 * left staring at nothing.
 */

import { Effect, Schema } from "effect"
import { Protocol } from "@opencode/ai/route"
import { Usage } from "@opencode/ai/schema/index"
import type { AIError, FinishReason, LLMEvent, LLMRequest } from "@opencode/ai/schema/index"

import { parseAgentOutput } from "../core/parse.js"
import type { AgentOutput } from "../core/parse.js"
import type {
  AcpEvent,
  AcpStopReason,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
  PlanEntry,
} from "../core/types.js"
import type { AcpProviderSettings } from "../settings.js"

/** The protocol's id, visible in `@opencode/ai` diagnostics. */
export const PROTOCOL_ID = "acp"

// ─────────────────────────────────────────────────────────────────────────────
// Request body
// ─────────────────────────────────────────────────────────────────────────────

/** What `body.from` produces, and what `prepare` receives. */
export interface AcpBody {
  /** The model OpenCode asked for - an option value agent-side. */
  readonly model: string
  /** The request as the core understands it, whoever the caller is. */
  readonly request: NormalizedRequest
}

const normalizedToolSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  schema: Schema.Unknown,
  // Declared, otherwise the codec **strips** the key when decoding the body and
  // the adapter would lose a namespaced tool's namespace - half of the name
  // OpenCode's runtime indexes its registry under.
  namespace: Schema.optional(Schema.String),
})

const normalizedMessageSchema = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), text: Schema.String }),
  Schema.Struct({ role: Schema.Literal("assistant"), text: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    id: Schema.String,
    name: Schema.String,
    output: Schema.String,
  }),
])

/**
 * The body schema.
 *
 * Note: a tool result is very often a JSON object, so its schema is `unknown`
 * rather than a string. Constraining it to a string would make `compileRequest`
 * fail on the first file read, before the agent is even spawned.
 */
const bodySchema: Schema.Codec<AcpBody, unknown> = Schema.Struct({
  model: Schema.String,
  request: Schema.Struct({
    system: Schema.Array(Schema.String),
    tools: Schema.Array(normalizedToolSchema),
    messages: Schema.Array(normalizedMessageSchema),
    maxOutputTokens: Schema.optional(Schema.Number),
    thinkingLevel: Schema.optional(Schema.String),
  }),
})

// ─────────────────────────────────────────────────────────────────────────────
// Frame envelope
// ─────────────────────────────────────────────────────────────────────────────

/** A frame emitted by the transport: a wrapped, serialisable `AcpEvent`. */
export interface AcpFrame {
  readonly ev: AcpEvent
}

const planEntrySchema = Schema.Struct({
  content: Schema.String,
  priority: Schema.Literals(["high", "medium", "low"]),
  status: Schema.Literals(["pending", "in_progress", "completed"]),
})

const permissionRequestSchema = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  title: Schema.String,
  kind: Schema.String,
  options: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, kind: Schema.String })),
})

const permissionDecisionSchema = Schema.Union([
  Schema.Struct({ action: Schema.Literal("select"), optionId: Schema.String }),
  Schema.Struct({ action: Schema.Literal("reject"), optionId: Schema.optional(Schema.String) }),
  Schema.Struct({ action: Schema.Literal("cancel") }),
])

/**
 * Note: the two `usage` variants stay **disjoint** (`kind: "context"` /
 * `"turn"`). The context window notification and the turn's cost come from two
 * different producers, and confusing them would display a wrong counter instead
 * of none (see `core/types.ts`).
 *
 * `usage: "turn"` carries **only optional fields**, never nested objects: the
 * reducer is what builds the `Usage` class, at the last moment, when there is
 * known to be data.
 */
const acpEventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thought"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool"),
    id: Schema.String,
    name: Schema.String,
    title: Schema.String,
    kind: Schema.String,
    status: Schema.String,
    // `Unknown` and **not** `optional`: the type must stay aligned with
    // `AcpEvent`, otherwise the `Schema.Codec<AcpFrame, string>` annotation below
    // stops verifying anything. It is `toFrame` (transport) that guarantees the
    // key is **present** in the JSON, `JSON.stringify` silently dropping
    // `undefined` values.
    input: Schema.Unknown,
    output: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("plan"), entries: Schema.Array(planEntrySchema) }),
  Schema.Struct({ type: Schema.Literal("usage"), kind: Schema.Literal("context"), used: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("usage"),
    kind: Schema.Literal("turn"),
    input: Schema.optional(Schema.Number),
    output: Schema.optional(Schema.Number),
    total: Schema.optional(Schema.Number),
    reasoning: Schema.optional(Schema.Number),
    cacheRead: Schema.optional(Schema.Number),
    cacheWrite: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("permission"),
    request: permissionRequestSchema,
    decision: permissionDecisionSchema,
    selectedOptionId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("done"),
    stopReason: Schema.Literals(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]),
  }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
])

/**
 * A frame is a **JSON string**: the core codec decodes *every* frame through
 * `Schema.decodeUnknownEffect`, and a `Schema.fromJsonString` is the only way to
 * obtain a `Codec<Event, string>` with the public `Protocol` API.
 */
const frameSchema: Schema.Codec<AcpFrame, string> = Protocol.jsonEvent(
  Schema.Struct({ ev: acpEventSchema }),
)

// ─────────────────────────────────────────────────────────────────────────────
// Reducer state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reducer's state, **immutable**: every `reduce` returns a new state, which
 * makes tests reproducible (replaying the same sequence gives the same result)
 * and prevents an `onHalt` from mutating an already observed state.
 */
export interface ReducerState {
  /** Index of the running step; 0 while a single `step-finish` is expected. */
  readonly step: number
  /** Has a `step-start` been emitted for the current step? */
  readonly started: boolean
  /**
   * Id of the open reasoning block, `null` if none.
   *
   * Note: this is the **only** block that can stay open between two `reduce`
   * calls. A text block is now emitted in one go (`text-start` / `text-delta` /
   * `text-end` in the same array) once the output is decoded, so it structurally
   * cannot be left open. There is therefore no "open text" field in the state.
   */
  readonly reasoning: string | null
  /** Open block counter, for ids that are unique and readable in logs. */
  readonly blocks: number
  /**
   * The agent's raw output, accumulated **without being emitted**.
   *
   * Note: the only way to know whether the answer is text or a tool call is to
   * have read it **in full**. Emitting the first `text-delta` before the end
   * would show the raw JSON in the transcript - that is, the contract text the
   * agent produced rather than its answer. So it is buffered, and rendered as a
   * single block at the end. What still **streams live**: `thought` ->
   * `reasoning-*`, `plan`, so the agent keeps showing its activity while waiting.
   */
  readonly buffer: string
  /**
   * The request's tool catalogue, copied from `NormalizedRequest.tools`.
   *
   * Note: it lives in the state rather than in a global for two reasons: the
   * reducer stays **pure** (same catalogue + same events => same output, hence
   * reproducible tests) and two concurrent requests cannot steal each other's
   * catalogue. `initial(request)` fills it; `initialState` leaves it empty, which
   * is the only way to test "the agent proposed a tool when none was available".
   */
  readonly catalog: readonly NormalizedTool[]
  /** Emitted tool call counter, for unique `tool-call` ids. */
  readonly calls: number
  /** Ids of tool calls **already emitted** - once per id. */
  readonly tools: ReadonlySet<string>
  /** Has a `step-finish` been emitted for the current step? */
  readonly stepFinished: boolean
  /** Has a `finish` been emitted? */
  readonly finished: boolean
  /** Has a terminal event (`finish` **or** `provider-error`) been emitted? */
  readonly terminal: boolean
  /** The last turn `usage` reported by the agent, if any. */
  readonly usage: Usage | undefined
  /**
   * The agent's own reading of its context window, if it announced one.
   *
   * Note: `usage_update` is monotonic, so the **last** one of the turn is also
   * the highest. It is not a cost (see `core/types.ts`) but the only figure that
   * measures what the agent actually holds, which is what OpenCode's `/compact`
   * threshold is compared against.
   */
  readonly context: number | undefined
  /** Number of permission decisions taken during the turn (observability). */
  readonly permissions: number
}

/** The result of one reduction step. */
export interface Reduction {
  readonly state: ReducerState
  readonly events: LLMEvent[]
}

/** Initial state - a turn that has produced nothing yet. */
export const initialState: ReducerState = {
  step: 0,
  started: false,
  reasoning: null,
  blocks: 0,
  buffer: "",
  catalog: [],
  calls: 0,
  tools: new Set<string>(),
  stepFinished: false,
  finished: false,
  terminal: false,
  usage: undefined,
  context: undefined,
  permissions: 0,
}

// ─────────────────────────────────────────────────────────────────────────────
// Reduction
// ─────────────────────────────────────────────────────────────────────────────

/** ACP `stopReason` -> normalised OpenCode reason. */
const normalizedStopReason = (reason: AcpStopReason): FinishReason => {
  switch (reason) {
    case "end_turn":
    case "cancelled":
      return "stop"
    case "max_tokens":
      return "length"
    case "refusal":
      return "content-filter"
    // `max_turn_requests` has no equivalent: the turn stopped because the agent
    // reached its turn limit, not because it refused to answer. "stop" is the
    // only choice that does not lie about the output.
    case "max_turn_requests":
      return "stop"
  }
}

/**
 * The turn's finish reason.
 *
 * Note: `tool-calls` always wins when at least one call was emitted: it is the
 * only value that makes the OpenCode loop continue, so turning a turn that
 * proposes a tool into `stop` would silently lose the agent's work.
 */
const finishReasonOf = (state: ReducerState, stopReason?: AcpStopReason): FinishReason => {
  if (state.tools.size > 0) return "tool-calls"
  return stopReason === undefined ? "stop" : normalizedStopReason(stopReason)
}

/** Reason of an interrupted stream: the `stopReason` is unknown. */
const haltReason = (state: ReducerState): FinishReason =>
  state.tools.size > 0 ? "tool-calls" : "stop"

/** Text rendering of an arbitrary value (tool result, call input...). */
const renderJson = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  // A tool result can be circular: an honest mention is better than an
  // exception in the middle of building the prompt.
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * How far ACP's `input` may drift from the agent's own context window before the
 * counter is believed to describe the session rather than the turn.
 *
 * Note: a `fresh` session reports its turn's own prompt and lands at 0.97x the
 * window, so the gap between "tokens sent" and "tokens reserved" - a few per
 * cent, and the only difference a correct agent has any reason to show - never
 * reaches this ratio. A **resumed** session reports the cache accounting
 * accumulated over the whole session, measured at 4.4x the window at turn 6.
 * That ratio is cumulative, so it crosses two within the first turns of a
 * conversation - which is where OpenCode's `/compact` threshold starts firing on
 * a figure that is not a context at all.
 *
 * Note: the direction matters. A window **above** the counter is ordinary - a
 * model reserves more than one turn sends - and is never substituted. Only a
 * counter far above the window is a cumulative one, and only that direction can
 * be corrected without inventing a number.
 */
const CONTEXT_OVERRIDE_RATIO = 2

/**
 * The window to believe instead of ACP's `input`, or `undefined` to keep it.
 *
 * Note: a silent agent (`context === undefined`) keeps the counter - there is
 * nothing to compare it with, and guessing is worse than forwarding. An empty
 * window does the same: zero is not a context, it is an agent that counted
 * nothing, and believing it would hide the conversation from `/compact` for
 * good.
 */
const contradictedWindow = (input: number, context: number | undefined): number | undefined => {
  if (context === undefined) return undefined
  const window = Math.round(context)
  if (window <= 0) return undefined
  return input > window * CONTEXT_OVERRIDE_RATIO ? window : undefined
}

/** The three terms of a `Usage`'s input split, each possibly unreported. */
interface InputTerms {
  readonly input: number | undefined
  readonly nonCached: number | undefined
  readonly cacheRead: number | undefined
  readonly cacheWrite: number | undefined
}

/**
 * `Usage`'s input split, once the agent's context window has had its say.
 *
 * Note: overriding rescales the **whole** split, not only its total. The cached
 * share is a property of the prompt and is worth keeping; the cumulative
 * counter is the only thing that is wrong, and leaving `cacheRead` alone would
 * put a term above the window it is a part of - and break the invariant.
 *
 * Note: `floor` then `min` is what makes `nonCached >= 0` hold whatever the
 * rounding and whatever nonsense the agent announces (more cached tokens than
 * sent ones), so `nonCached + cacheRead + cacheWrite = input` stays exact.
 */
const inputTermsOf = (
  input: number | undefined,
  cacheRead: number | undefined,
  cacheWrite: number | undefined,
  context: number | undefined,
): InputTerms => {
  if (input === undefined) return { input: undefined, nonCached: undefined, cacheRead, cacheWrite }
  const read = cacheRead ?? 0
  const write = cacheWrite ?? 0
  const window = contradictedWindow(input, context)
  if (window === undefined) {
    return { input, nonCached: Math.max(0, input - read - write), cacheRead, cacheWrite }
  }
  const scaledRead = Math.min(window, Math.floor((read * window) / input))
  const scaledWrite = Math.min(window - scaledRead, Math.floor((write * window) / input))
  return {
    input: window,
    nonCached: window - scaledRead - scaledWrite,
    cacheRead: cacheRead === undefined ? undefined : scaledRead,
    cacheWrite: cacheWrite === undefined ? undefined : scaledWrite,
  }
}

/** ACP usage -> a `Usage` instance, or `undefined` if the agent said nothing. */
const toUsage = (
  event: Extract<AcpEvent, { type: "usage"; kind: "turn" }>,
  context: number | undefined,
): Usage | undefined => {
  const { input, output, total, reasoning, cacheRead, cacheWrite } = event
  const reported = [input, output, total, reasoning, cacheRead, cacheWrite]
  // An empty `usage` is no better than no `usage` at all: OpenCode would show
  // "0 tokens" for a turn it simply failed to count.
  if (reported.every((value) => value === undefined)) return undefined
  // Documented `Usage` invariant: `nonCached + cacheRead + cacheWrite = input`.
  // ACP does not report it, so it is derived.
  const terms = inputTermsOf(input, cacheRead, cacheWrite, context)
  return new Usage({
    ...(terms.input === undefined ? {} : { inputTokens: terms.input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(terms.cacheRead === undefined ? {} : { cacheReadInputTokens: terms.cacheRead }),
    ...(terms.cacheWrite === undefined ? {} : { cacheWriteInputTokens: terms.cacheWrite }),
    ...(terms.nonCached === undefined ? {} : { nonCachedInputTokens: terms.nonCached }),
  })
}

/** Renders a plan as text, for the reasoning block. */
const renderPlan = (entries: readonly PlanEntry[]): string =>
  entries
    .map((entry) => `Plan — [${entry.priority}] ${entry.content} (${entry.status})`)
    .join("\n")

/** Tool name carried by a call: never empty, or OpenCode cannot tell what to run. */
const toolNameOf = (event: Extract<AcpEvent, { type: "tool" }>): string =>
  event.name !== "" ? event.name : event.title !== "" ? event.title : "tool"

/**
 * Translates a **validated** agent output into `LLMEvent`s - the heart of the
 * project.
 *
 * Pure, and shared by the `done` and by `halt`'s flush.
 *
 * Note: the `tool-call` is emitted **without `providerExecuted` and without
 * `tool-result`**. That is precisely what makes OpenCode actually run the tool,
 * with its permissions, snapshots and undo. A `tool-result` here would suggest
 * the agent had already done the work - it only **proposed** it.
 *
 * Note: the `tool-call` id is synthesised here, the only place in the project
 * that dares to. It comes from the `buffer`, not from the transcript, so it
 * cannot collide with an id in `request.messages`, and `fromRequest` echoes it
 * back verbatim on the next turn.
 *
 * Note: the catalogue's `namespace` is **re-read** here rather than transmitted
 * by the agent: the agent only knows the flat name, and our catalogue is what
 * knows where it came from. That is what lets OpenCode's runtime find the tool
 * in its registry, indexed by `namespace.name`.
 */
const emitOutput = (state: ReducerState, output: AgentOutput): Reduction => {
  if (output.type === "text") {
    const id = `text-${state.blocks}`
    return {
      state: { ...state, blocks: state.blocks + 1 },
      events: [
        { type: "text-start", id },
        { type: "text-delta", id, text: output.text },
        { type: "text-end", id },
      ],
    }
  }
  const id = `acp-call-${state.calls}`
  const { name } = output
  const input = output.arguments
  const namespace = state.catalog.find((tool) => tool.name === name)?.namespace
  return {
    state: { ...state, calls: state.calls + 1, tools: new Set([...state.tools, id]) },
    events: [
      { type: "tool-input-start", id, name, ...(namespace === undefined ? {} : { namespace }) },
      {
        type: "tool-input-delta",
        id,
        name,
        text: renderJson(input),
        input,
        ...(namespace === undefined ? {} : { namespace }),
      },
      { type: "tool-input-end", id, name, ...(namespace === undefined ? {} : { namespace }) },
      { type: "tool-call", id, name, input, ...(namespace === undefined ? {} : { namespace }) },
    ],
  }
}

/**
 * Translates **one** `AcpEvent`.
 *
 * Pure: same inputs, same output, no shared mutable state.
 *
 * Note: `text` is no longer translated as it arrives: it is **buffered** (see
 * `ReducerState.buffer`) and rendered as one block at the `done`, once
 * `core/prompt.ts`'s output contract has been decoded. Reasoning and plans are
 * still emitted live, which is what keeps showing the agent's activity.
 *
 * Note: ACP has neither a "block start" nor a "block end" event: a `text` is a
 * delta, nothing more. The opening is therefore **derived** and the closing
 * **computed**, so an agent sending a delta it never "opened" cannot put us in
 * the wrong, since there is nothing to open.
 */
export const reduce = (state: ReducerState, event: AcpEvent): Reduction => {
  const events: LLMEvent[] = []

  // A terminal event is the last one: `@opencode/ai` explicitly rejects anything
  // after it ("Provider emitted X after the terminal event").
  if (state.terminal) return { state, events }

  let next = state

  /** Opens the step if needed - the sequence **always** starts there. */
  const ensureStep = (): void => {
    if (next.started) return
    events.push({ type: "step-start", index: next.step })
    next = { ...next, started: true }
  }

  /** Closes the reasoning block if it is open. */
  const closeReasoning = (): void => {
    if (next.reasoning === null) return
    events.push({ type: "reasoning-end", id: next.reasoning })
    next = { ...next, reasoning: null }
  }

  /**
   * Opens a reasoning block.
   *
   * Note: reasoning is the **only** block that can stay open from one `reduce`
   * to the next. A text block is now emitted in one go by `emitOutput`
   * (`text-start` / `text-delta` / `text-end` in the same array), so it
   * structurally cannot stay open; reasoning, on the other hand, streams live,
   * which makes it the only one closed here.
   */
  const openReasoning = (): void => {
    if (next.reasoning !== null) return
    const id = `reasoning-${next.blocks}`
    events.push({ type: "reasoning-start", id })
    next = { ...next, reasoning: id, blocks: next.blocks + 1 }
  }

  switch (event.type) {
    case "text": {
      // Buffered, nothing is emitted: see `ReducerState.buffer`. No `step-start`
      // here either - a step only opens once it has something to show, and the
      // `done` will open it anyway.
      if (event.text === "") return { state: next, events }
      return { state: { ...next, buffer: next.buffer + event.text }, events }
    }

    case "thought": {
      if (event.text === "") return { state: next, events }
      ensureStep()
      openReasoning()
      events.push({ type: "reasoning-delta", id: next.reasoning ?? "", text: event.text })
      return { state: next, events }
    }

    case "plan": {
      if (event.entries.length === 0) return { state: next, events }
      ensureStep()
      openReasoning()
      events.push({ type: "reasoning-delta", id: next.reasoning ?? "", text: renderPlan(event.entries) })
      return { state: next, events }
    }

    case "tool": {
      // ACP sends **several** `AcpEvent`s for a single call (`tool_call`, then
      // `tool_call_update` `in_progress`, then `completed`). Emitting only once
      // is the only way to produce a valid sequence - and it is also the mode:
      // the provider **proposes**, OpenCode executes, so no `tool-result` is
      // emitted here. The result comes back on the next turn, in
      // `request.messages`.
      if (next.tools.has(event.id)) return { state: next, events }
      ensureStep()
      closeReasoning()
      const name = toolNameOf(event)
      const input = event.input ?? {}
      events.push({ type: "tool-input-start", id: event.id, name })
      events.push({ type: "tool-input-delta", id: event.id, name, text: renderJson(input), input })
      events.push({ type: "tool-input-end", id: event.id, name })
      // **No** `providerExecuted`: that is what makes OpenCode actually run the
      // tool (permissions, snapshots, undo, logging).
      events.push({ type: "tool-call", id: event.id, name, input })
      return {
        state: { ...next, calls: next.calls + 1, tools: new Set([...next.tools, event.id]) },
        events,
      }
    }

    case "usage": {
      // The context window is not the turn's cost: it is kept aside, never
      // added to the counters, and only read when the counters contradict it.
      if (event.kind === "context") return { state: { ...next, context: event.used }, events }
      const usage = toUsage(event, next.context)
      return { state: usage === undefined ? next : { ...next, usage }, events }
    }

    case "permission": {
      // No `LLMEvent` is defined for a permission. It is counted anyway, so a
      // diagnostic can say "the agent asked for 3 permissions, all refused"
      // without replaying the stream.
      return { state: { ...next, permissions: next.permissions + 1 }, events }
    }

    case "error": {
      ensureStep()
      closeReasoning()
      events.push({ type: "step-finish", index: next.step, reason: { normalized: "error" } })
      // `provider-error` **is** the protocol's terminal event: it carries the
      // agent's message all the way to the interface, where a `finish{error}`
      // would have lost it. The `done{cancelled}` that follows in the ACP stream
      // is then ignored (`terminal`).
      events.push({ type: "provider-error", message: event.message })
      return { state: { ...next, stepFinished: true, terminal: true }, events }
    }

    case "done": {
      ensureStep()
      closeReasoning()
      const usage = next.usage

      // The moment of truth: this, and **only** this, is where we know whether
      // the accumulated answer is text or a tool call.
      //
      // An **empty** buffer is not a malformed output: the agent may simply have
      // written nothing (it proposed a tool over ACP, or it was cancelled), and
      // there is then nothing to decode. The contract is only applied when there
      // is actually something to read.
      const parsed =
        next.buffer.trim() === "" ? undefined : parseAgentOutput(next.buffer, next.catalog)
      if (parsed !== undefined && !parsed.ok) {
        // `provider-error` is terminal and the core **refuses** any event after
        // it, so the missing `step-finish` is emitted - and above all **never** a
        // `finish` behind it. A `ParseError` denying that `step-finish` would
        // read like a stream truncation, indistinguishable from a dead pipe and
        // therefore unusable.
        events.push({ type: "step-finish", index: next.step, reason: { normalized: "error" } })
        events.push({ type: "provider-error", message: parsed.error.message })
        return { state: { ...next, stepFinished: true, terminal: true }, events }
      }

      const emitted =
        parsed === undefined ? { state: next, events: [] } : emitOutput(next, parsed.output)
      events.push(...emitted.events)
      next = emitted.state

      const reason = { normalized: finishReasonOf(next, event.stopReason) } as const
      events.push({
        type: "step-finish",
        index: next.step,
        reason,
        ...(usage === undefined ? {} : { usage }),
      })
      events.push({
        type: "finish",
        reason,
        ...(usage === undefined ? {} : { usage }),
      })
      return {
        state: { ...next, stepFinished: true, finished: true, terminal: true },
        events,
      }
    }
  }
}

/**
 * End-of-stream flush - called by `onHalt`.
 *
 * Note: this is the **only** guarantee that an interrupted, truncated or
 * completely empty stream does not produce "The provider response ended
 * unexpectedly." The core requires a terminal event and there is nowhere else to
 * emit it. An already terminal state returns the empty list, so `onHalt` has no
 * effect after a normal `done`.
 */
export const halt = (state: ReducerState): Reduction => {
  if (state.terminal) return { state, events: [] }
  const events: LLMEvent[] = []
  let next = state
  if (!next.started) {
    events.push({ type: "step-start", index: next.step })
    next = { ...next, started: true }
  }
  if (next.reasoning !== null) {
    events.push({ type: "reasoning-end", id: next.reasoning })
    next = { ...next, reasoning: null }
  }
  // The buffer is read here, and **only if it is complete**. A stream interrupted
  // in the middle of a JSON has nothing usable - rendering it would produce a
  // half-eaten transcript - but a stream whose answer arrived complete and that
  // then dies on the `done` deserves to be shown.
  if (next.buffer.trim() !== "") {
    const parsed = parseAgentOutput(next.buffer, next.catalog)
    if (parsed.ok) {
      const emitted = emitOutput(next, parsed.output)
      events.push(...emitted.events)
      next = emitted.state
    }
  }
  const reason = { normalized: haltReason(next) } as const
  const usage = next.usage
  events.push({
    type: "step-finish",
    index: next.step,
    reason,
    ...(usage === undefined ? {} : { usage }),
  })
  events.push({
    type: "finish",
    reason,
    ...(usage === undefined ? {} : { usage }),
  })
  return { state: { ...next, stepFinished: true, finished: true, terminal: true }, events }
}

// ─────────────────────────────────────────────────────────────────────────────
// `LLMRequest` -> `NormalizedRequest`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A tool name, namespaces flattened the way `@opencode/ai`'s `flattenTools` does
 * it.
 *
 * Note: the separator is `_`, not `.`: that is the library's own convention
 * ("`.` is not broadly accepted in provider tool names", `protocols/shared.js`),
 * and therefore exactly the name the agent must reproduce in the prompt.
 */
const NAMESPACED_SEPARATOR = "_"

const flatToolName = (namespace: string | undefined, name: string): string =>
  namespace === undefined ? name : `${namespace}${NAMESPACED_SEPARATOR}${name}`

/**
 * A textual content block, without `as`: the predicate **is** the narrowing, and
 * TypeScript's `in` operator is enough to make `block.type` readable.
 */
const isTextBlock = (block: unknown): block is { readonly type: "text"; readonly text: string } =>
  typeof block === "object" &&
  block !== null &&
  "type" in block &&
  block.type === "text" &&
  "text" in block &&
  typeof block.text === "string"

/**
 * Renders a tool result for the transcript.
 *
 * `content` is the most frequent case on the OpenCode side (a `read` returns
 * text blocks): serialising it as JSON would wrap the tool's answer in braces,
 * which the agent reads as noise.
 */
const renderToolResult = (result: { readonly type: string; readonly value: unknown }): string => {
  switch (result.type) {
    case "text":
      return renderJson(result.value)
    case "content": {
      const blocks = Array.isArray(result.value) ? result.value.filter(isTextBlock) : []
      return blocks.length > 0 ? blocks.map((block) => block.text).join("\n") : renderJson(result.value)
    }
    case "error":
      return `error: ${renderJson(result.value)}`
    default:
      return renderJson(result.value)
  }
}

/** Renders a **transcript** tool call: what the agent proposed on the previous turn. */
const renderToolCall = (name: string, input: unknown): string =>
  `Tool call ${name} : ${renderJson(input)}`

/**
 * A catalogue tool with a flattened namespace - **namespace preserved**.
 *
 * Note: the catalogue carries two halves: `name` is the flat name the agent must
 * reproduce (hence the one in the prompt), and `namespace` the one OpenCode's
 * runtime expects to find the tool in its registry. Emitting a `tool-call`
 * carrying only the flat name would produce "No tool named "search_grep" is
 * currently available": the tool would be lost, silently.
 */
const flattenTools = (tools: LLMRequest["tools"]): NormalizedTool[] =>
  tools.flatMap((entry) => {
    if (entry.type === "namespace") {
      return entry.tools
        .filter((inner): inner is Exclude<typeof inner, { type: "namespace" }> => inner.type !== "namespace")
        .map((inner) => ({
          name: flatToolName(entry.name, inner.name),
          description: inner.description,
          schema: inner.inputSchema,
          namespace: entry.name,
        }))
    }
    return [{ name: entry.name, description: entry.description, schema: entry.inputSchema }]
  })

/** A transcript message as accumulated text (`text` and `tool-call` parts merged). */
interface Textual {
  readonly role: "user" | "assistant"
  readonly parts: string[]
}

/**
 * A turn's initial state, catalogue included.
 *
 * Note: `Protocol.stream.initial` receives the resolved `LLMRequest`, the only
 * place where the tool catalogue is available to the reducer since the frames
 * that follow carry only ACP data. It is copied **into the state** rather than
 * into a module variable: the reducer stays pure, and two concurrent turns do
 * not share their catalogue.
 */
export const initialStateFor = (request: LLMRequest): ReducerState => ({
  ...initialState,
  catalog: flattenTools(request.tools),
})

/**
 * `LLMRequest` -> `NormalizedRequest`.
 *
 * The heart of the project (prompt, output contract, policy) only knows this
 * shape, which is what lets any other transport reuse exactly the same prompt
 * rendering.
 */
export const fromRequest = (
  request: LLMRequest,
  settings: AcpProviderSettings,
): Effect.Effect<AcpBody, AIError> => {
  const system: string[] = []
  for (const part of request.system) {
    if (part.text !== "") system.push(part.text)
  }
  // The suffix comes **after** OpenCode's system prompt: it carries the output
  // contract, and it must close the prompt rather than mix into it.
  if (settings.systemSuffix !== undefined && settings.systemSuffix !== "") {
    system.push(settings.systemSuffix)
  }

  const messages: NormalizedMessage[] = []
  for (const message of request.messages) {
    switch (message.role) {
      case "system": {
        // A `system`-role message mid-conversation is an operator instruction:
        // it belongs to the system, not to the transcript.
        const text = message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n")
          .trim()
        if (text !== "") system.push(text)
        break
      }

      case "user":
      case "assistant": {
        const textual: Textual = { role: message.role, parts: [] }
        for (const part of message.content) {
          if (part.type === "text") {
            if (part.text !== "") textual.parts.push(part.text)
          } else if (part.type === "tool-call") {
            // A `tool-call` from a previous turn **is** an instruction: without
            // it the agent does not know what it proposed and cannot continue.
            textual.parts.push(renderToolCall(flatToolName(part.namespace, part.name), part.input))
          }
          // `reasoning`, `media` and `compaction` are deliberately ignored: a
          // past turn's reasoning is a rendering artefact, not an instruction,
          // and sending it costs tokens for nothing.
        }
        const text = textual.parts.join("\n").trim()
        if (text !== "") messages.push({ role: textual.role, text })
        break
      }

      case "tool": {
        for (const part of message.content) {
          if (part.type !== "tool-result") continue
          messages.push({
            role: "tool",
            // `id` **verbatim**: the ACP agent synthesised this identifier at
            // turn N and must recognise it at turn N+1. Rewriting it would break
            // the round-trip of the whole mechanism.
            id: part.id,
            name: flatToolName(part.namespace, part.name),
            output: renderToolResult(part.result),
          })
        }
        break
      }
    }
  }

  const normalized: NormalizedRequest = {
    system,
    tools: flattenTools(request.tools),
    messages,
    ...(request.generation?.maxTokens === undefined
      ? {}
      : { maxOutputTokens: request.generation.maxTokens }),
  }

  return Effect.succeed({ model: String(request.model.id), request: normalized })
}

// ─────────────────────────────────────────────────────────────────────────────
// The `Protocol`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the route's protocol.
 *
 * Note: it is a **function** and not a constant: `body.from` depends on the
 * settings (the `systemSuffix`), whereas `@opencode/ai`'s `Protocol` is built
 * once and for all in `Route.make`. Since the route itself is rebuilt on every
 * call to `model()`, coherence is guaranteed by construction, not by convention.
 */
export const makeProtocol = (settings: AcpProviderSettings): Protocol<
  AcpBody,
  string,
  AcpFrame,
  ReducerState
> =>
  Protocol.make({
    id: PROTOCOL_ID,
    body: {
      schema: bodySchema,
      from: (request) => fromRequest(request, settings),
    },
    stream: {
      event: frameSchema,
      initial: initialStateFor,
      step: (state, frame) => {
        const { state: next, events } = reduce(state, frame.ev)
        return Effect.succeed([next, events] as const)
      },
      // The final flush: fills in the missing `step-finish` / `finish`.
      onHalt: (state) => Effect.succeed(halt(state).events),
    },
  })
