/**
 * The project's portable contract.
 *
 * Note: this file imports **nothing** - no ACP SDK, no `@opencode/ai`, no
 * `effect`. That is what guarantees `core/` survives a change of transport, SDK
 * or host. Every reference to the ACP protocol goes through the structural
 * types declared here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Events emitted by an ACP agent
// ─────────────────────────────────────────────────────────────────────────────

/** Why a prompt turn stopped, aligned with ACP's `StopReason`. */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"

/**
 * The one stream the adapters share. Everything above speaks only `AcpEvent`;
 * everything below speaks ACP.
 */
export type AcpEvent =
  /** Text chunk produced by the agent (the visible answer). */
  | { type: "text"; text: string }
  /** Agent reasoning - routed to `reasoning-*` on the OpenCode side. */
  | { type: "thought"; text: string }
  /** Opening or update of a native agent tool call. */
  | {
      type: "tool"
      id: string
      /** Programmatic tool name; empty if the agent provides none. */
      name: string
      /** Readable title, always present in ACP. */
      title: string
      kind: string
      status: string
      input: unknown
      output?: unknown
    }
  /** The agent's execution plan. */
  | { type: "plan"; entries: readonly PlanEntry[] }
  /**
   * Token counters, in **two variants discriminated by `kind`**.
   *
   * Note: two variants rather than one object with optional fields, because
   * the two semantics come from **two distinct producers** and do not overlap.
   * `usage_update` only speaks about the context window (how many tokens are
   * *reserved*); the final `PromptResponse` only speaks about what the turn
   * *cost*. An all-optional `{ input?, output?, context? }` would make `{}`
   * legitimate, and the adapter reducer would have to guess which side it is
   * looking at - the very trap that makes a malformed `LLMEvent` surface as
   * "The provider response ended unexpectedly.", indistinguishable from a
   * truncation.
   *
   * - `context`: an `usage_update` notification, mid-turn (monotonic).
   * - `turn`: the turn's final `PromptResponse`. `reasoning` / `cacheRead` /
   *   `cacheWrite` map to `thoughtTokens` / `cachedReadTokens` /
   *   `cachedWriteTokens` of ACP's `Usage` and feed OpenCode's `Usage` class
   *   directly, `Usage` instances included.
   */
  | { type: "usage"; kind: "context"; used: number }
  | {
      type: "usage"
      kind: "turn"
      input?: number
      output?: number
      total?: number
      /** Reasoning tokens (`thoughtTokens` in ACP). */
      reasoning?: number
      cacheRead?: number
      cacheWrite?: number
    }
  /**
   * A permission decision taken during the turn.
   *
   * Note: without this event the policy is **invisible** in the stream: nothing
   * can show "the agent wanted to write, we refused", which is precisely what
   * the user must see. `selectedOptionId` is absent when the turn was
   * cancelled.
   */
  | {
      type: "permission"
      request: PermissionRequest
      decision: PermissionDecision
      selectedOptionId?: string
    }
  /**
   * End of turn. Always the last event of a `prompt()`.
   *
   * Note: also emitted **after** an `error`. A stream that ends without `done`
   * fails the `@opencode/ai` chain with "The provider response ended
   * unexpectedly.", indistinguishable from a truncation.
   */
  | { type: "done"; stopReason: AcpStopReason }
  /** Error caught during the turn; the stream ends right after. */
  | { type: "error"; message: string }

/** One entry of the agent's execution plan. */
export interface PlanEntry {
  content: string
  priority: "high" | "medium" | "low"
  status: "pending" | "in_progress" | "completed"
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized request - independent of OpenCode and of the OpenAI API alike
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A transcript message, rendered in an agnostic form.
 *
 * Note: the `tool` variant carries an **explicit `id`** even though ACP
 * transports none. The id is **synthesised by the emitter** (at turn N, when
 * the `tool-call` is emitted) and **echoed back verbatim** by the consumer at
 * turn N+1 - OpenCode through `toolCallId`, the OpenAI API through
 * `tool_call_id`. The round-trip is therefore stable in both cases, with no
 * lookup table to maintain.
 *
 * The alternative - dropping the id and rebuilding it at render time - made two
 * calls to the same tool within one conversation **indistinguishable**, and a
 * reducer cannot tell which result to close without a stable id.
 *
 * **Constraint for adapters**: propagate this `id` **verbatim**, and guarantee
 * its **uniqueness per request** - two `tool-call`s of the same turn must never
 * carry the same id.
 */
export type NormalizedMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool"; id: string; name: string; output: string }

/**
 * A tool exposed to the agent, with its real name and its real JSON schema.
 *
 * Note: `name` is the **flat** name the agent must reproduce, and `namespace`
 * the namespace it came from, **if any**. Both exist because OpenCode's runtime
 * indexes its registry by `namespace.name` (`ToolRuntime.dispatch` in
 * `@opencode/ai`), while protocols without a native namespace flatten to
 * `namespace_name`. An adapter sending only the flat name would produce an
 * unresolvable `tool-call` ("No tool named "..." is currently available"), so
 * both halves are kept, and only `name` is rendered into the prompt.
 */
export interface NormalizedTool {
  name: string
  description: string
  schema: unknown
  /** Origin namespace, absent for a top-level tool. */
  namespace?: string
}

/**
 * The request as the core understands it, whoever the caller is: the OpenCode
 * adapter converts `LLMRequest`, the HTTP adapter converts an OpenAI body. The
 * business logic exists exactly once.
 */
export interface NormalizedRequest {
  /** System instructions, already resolved (AGENTS.md, skills, output contract). */
  system: readonly string[]
  /** Catalogue of tools to offer the agent. */
  tools: readonly NormalizedTool[]
  /**
   * The transcript **to send**, which is not necessarily the whole history.
   *
   * Note: on session resume these are the only **new** messages: the agent
   * already holds the earlier ones in its own memory, and resending them would
   * produce a duplicated history - the agent would see every message twice and
   * reason over an incoherent conversation. See `core/session-key.ts` for the
   * delta computation, and `resume` below.
   */
  messages: readonly NormalizedMessage[]
  maxOutputTokens?: number
  /** Requested effort level (`thought_level` in ACP). */
  thinkingLevel?: string
  /**
   * `true` when `messages` is a **delta** rather than the full history.
   *
   * Note: this is only an **honest mention** in the prompt. Without it the
   * agent reads a "Conversation" section holding just the last messages and may
   * believe that is the whole exchange - so it reformulates, summarises or
   * "completes" a conversation it already has in front of it. Resume remains a
   * **heuristic**: the field says what we did, it guarantees nothing about what
   * the agent retained.
   */
  resume?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventory
// ─────────────────────────────────────────────────────────────────────────────

/** A model selectable on the agent side. */
export interface AcpModel {
  /** Raw id returned by the agent (the one echoed back to `set_config_option`). */
  id: string
  /** Readable label. */
  name: string
  description?: string
}

/** An agent operating mode (`#agent`, `#plan`...). */
export interface AcpMode {
  /** Shortened id, convenient for display (`#agent`). */
  id: string
  /** Full id returned by the agent (often a URL). */
  rawId: string
  name: string
  description?: string
}

/**
 * A normalised session configuration option. `type` is kept because
 * `session/set_config_option` needs a different payload for a boolean
 * (`{ type: "boolean", value: bool }`) and for a selector.
 */
export interface AcpOption {
  id: string
  name: string
  /** ACP semantic category: `model`, `thought_level`, `mode`, `permissions`... */
  category: string
  type: "select" | "boolean"
  /** Current value, always rendered as a string. */
  currentValue: string
  /** Accepted values, in the agent's display order. */
  values: readonly string[]
  description?: string
}

/** The full inventory deduced from a session's `configOptions`. */
export interface Inventory {
  /** `model` category: one OpenCode model per value. */
  models: readonly AcpModel[]
  /** `thought_level` category: variants of the model. */
  thoughtLevels: readonly string[]
  /** `mode` category: OpenCode agents. */
  modes: readonly AcpMode[]
  /** `permissions` category, pinned to `off` by the default policy. */
  permissions?: AcpOption
  /** All options, raw but normalised, for inspection. */
  options: readonly AcpOption[]
  currentModel?: string
  currentThoughtLevel?: string
  currentMode?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Permissions
// ─────────────────────────────────────────────────────────────────────────────

/** A choice offered by the agent during a `session/request_permission`. */
export interface PermissionOption {
  id: string
  name: string
  /** `allow_once`, `allow_always`, `reject_once`, `reject_always`. */
  kind: string
}

/** What the agent wants to do, summarised. */
export interface PermissionRequest {
  sessionId: string
  toolCallId: string
  title: string
  kind: string
  options: readonly PermissionOption[]
}

/** The decision handed back to the agent. */
export type PermissionDecision =
  /** Pick an offered option (by default the first compatible one). */
  | { action: "select"; optionId: string }
  /** Refuse; the agent receives the matching `reject_*` option. */
  | { action: "reject"; optionId?: string }
  /** Turn cancellation on the agent side (`outcome: "cancelled"`). */
  | { action: "cancel" }

/**
 * Decision function for `session/request_permission`.
 *
 * The provider package has no access to OpenCode's permissions (`Settings` is
 * flat JSON), so this is a function fed by the provider config.
 * **Default: deny.**
 */
export type AcpPermissionPolicy = (
  request: PermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>

/** Default policy: systematically refuse everything the agent proposes. */
export const denyAllPermissions: AcpPermissionPolicy = (request) => {
  const option = request.options.find((o) => o.kind.startsWith("reject_"))
  return option ? { action: "select", optionId: option.id } : { action: "cancel" }
}

/** "native tools allowed" policy: accept the first `allow_*` option. */
export const allowAllPermissions: AcpPermissionPolicy = (request) => {
  const option = request.options.find((o) => o.kind.startsWith("allow_"))
  return option ? { action: "select", optionId: option.id } : { action: "cancel" }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent & session
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ACP session strategy, per request.
 *
 * Note: declared here rather than in `src/settings.ts`, because `core/publish.ts`
 * needs it for `RawAgent` and `settings.ts` already depends on this module - the
 * other way round would be a cycle, and a duplicated union would be free to drift
 * from the validation that admits it.
 *
 * - `fresh`: one session per model call, the whole history replayed. Correct by
 *   construction, at the cost of a `session/new` per call and of an agent that
 *   forgets everything between two calls.
 * - `reuse`: one session per conversation, only the delta sent. Cheaper, and
 *   safe only because the delta is proven message by message - see
 *   `core/session-key.ts`.
 */
export type SessionMode = "reuse" | "fresh"

/** Agent identity, as reported by `initialize`. */
export interface AcpAgentInfo {
  name: string
  version: string
}

/** A running ACP agent, with its process alive. */
export interface AcpAgent {
  readonly info: AcpAgentInfo
  /** Protocol version negotiated during `initialize`. */
  readonly protocolVersion: number
  /** Full inventory (models, efforts, modes, permissions). */
  inventory(): Promise<Inventory>
  /** Shortcut: only the models of the `model` category. */
  models(): Promise<readonly AcpModel[]>
  /** Opens a fresh ACP session. */
  open(options?: { cwd?: string; signal?: AbortSignal }): Promise<AcpSession>
  /** Closes the connection, then kills the subprocess. */
  close(): Promise<void>
}

/** An open ACP session, ready to receive prompt turns. */
export interface AcpSession {
  readonly sessionId: string
  /** Inventory as returned by `session/new` (refreshed by updates). */
  inventory(): Inventory
  /** Shortcut: change the current value of the `model` category option. */
  setModel(modelId: string): Promise<void>
  /** Change any option (`reasoning_effort`, `allow_all`...). */
  setOption(configId: string, value: string): Promise<void>
  /**
   * The one point the three adapters share.
   *
   * Note: `signal` is **optional and treacherous** - not providing it must not
   * be more dangerous than providing it. The implementation therefore cancels
   * the turn automatically when the consumer abandons the iteration (`break`,
   * `return`, `throw`), with or without a signal.
   */
  prompt(
    request: NormalizedRequest,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<AcpEvent>
  /** Releases update routing and, if possible, closes the session agent-side. */
  close(): Promise<void>
}
