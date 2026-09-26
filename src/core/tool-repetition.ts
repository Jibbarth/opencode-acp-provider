/**
 * The tool call loop guard.
 *
 * The problem, as measured on a real run. The provider emits a `tool-call`
 * **without** `tool-result` and lets OpenCode run the tool - that is the whole
 * mechanism, and it works. But OpenCode then asks the model again **before** it
 * has validated the agent's message, and the request it sends is byte for byte
 * the previous one:
 *
 *   turn 1 : messages=1  roles=user                 -> tool-call read
 *   turn 2 : messages=1  roles=user                 -> tool-call read   <- the same prompt
 *   turn 3 : messages=3  roles=user,assistant,tool  -> finish: stop
 *
 * The agent therefore receives the **same prompt twice**, and a deterministic
 * agent proposes the same call twice. The waste is measured twice over: one
 * wasted turn on an ordinary run, and the same `read` repeated sixteen times on
 * another, tokens and all. The result does arrive - at turn 3 - and the agent
 * converges; the only thing missing is someone cutting the loop **before** the
 * second proposal.
 *
 * So this module answers one question, purely: is the call the agent is
 * proposing right now **the same** one it already proposed and never got a
 * result for? The state that remembers it is the adapter's - see
 * `adapters/tool-loop.ts`, which is where a turn is matched to a conversation.
 *
 * Note: **repeating is legitimate.** An agent that re-reads a file after having
 * read it is doing ordinary, well-behaved work, and refusing it would break a
 * working session. Only an **exact** repetition is ever refused: same name, same
 * arguments, and no result received since. Anything else passes.
 *
 * Note: the comparison is **structural**, not textual. `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` are the same call with the same arguments, and comparing their
 * renderings character by character would call them different - which is exactly
 * the kind of false negative that lets the loop run. Keys are therefore sorted
 * before rendering.
 *
 * Note: **arguments that cannot be rendered never refuse.** A cycle, a `BigInt`,
 * a function: an identity that cannot be established is not an identity. The
 * call then passes, exactly as it did before this guard existed, because
 * refusing a legitimate turn on a guess is worse than letting the old behaviour
 * happen for an input that cannot even reach us over ACP (the arguments are
 * JSON-RPC decoded, so this branch is a defensive one, not an expected one).
 */

import { createHash } from "node:crypto"

import type { SessionIdentity } from "./session-key.js"

// ─────────────────────────────────────────────────────────────────────────────
// Scope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The scope a dangling call belongs to: the agent identity, plus what the
 * conversation started with.
 *
 * Note: deliberately **not** `sessionKey`. That one anchors on a
 * `NormalizedMessage`, and the guard runs on the host's own request, before
 * anything normalises it: what is available there is the first message as the
 * host spelled it. The anchor has exactly two duties - stay constant for the
 * life of a conversation, and differ between two of them - and it decides which
 * memory a call is compared against, nothing else. It never reaches the agent.
 *
 * Note: the model is part of the identity, as in `sessionKey`: a model change is
 * a different conversation for the agent, hence for the guard. Forgetting there
 * costs at worst a missed cut, never a wrong refusal.
 */
export const loopScope = (identity: SessionIdentity, anchor: string): string =>
  createHash("sha256")
    .update(JSON.stringify([identity.agent, identity.cwd, identity.model, anchor]))
    .digest("hex")

/**
 * Does this incoming transcript carry a tool **result**?
 *
 * Note: the parameter is deliberately the loosest shape that answers the
 * question - a `role` and nothing else - so the same function serves the
 * normalised transcript of `core/types.ts` and the host's own messages, without
 * this module ever importing a host type.
 */
export const carriesToolResult = (messages: readonly { readonly role: string }[]): boolean =>
  messages.some((message) => message.role === "tool")

// ─────────────────────────────────────────────────────────────────────────────
// Canonical rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A value with keys to walk: an object or an array.
 *
 * Note: the predicate **is** the narrowing - the same convention as
 * `isTextBlock` in `adapters/opencode-protocol.ts` and `isRecord` in
 * `settings.ts`. It exists so the code below can index a value the type system
 * only knows as `object`, without an assertion doing the work silently.
 */
const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] =>
  typeof value === "object" && value !== null

/**
 * A value rebuilt with its object keys **sorted**, arrays left in order.
 *
 * Note: it throws on anything it cannot render faithfully - a cycle, a
 * `BigInt`, a function, a symbol - and `canonicalArguments` turns that into
 * `null`. Throwing rather than degrading is what makes the failure visible in
 * one place instead of producing two different renderings of the same call.
 *
 * Note: `JSON.stringify` alone cannot do this: a replacer sees values, never
 * key order, so the insertion order survives - and two identical calls built by
 * two different code paths rarely spell their keys in the same order.
 */
const canonical = (value: unknown, seen: ReadonlySet<object>): unknown => {
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("tool arguments are not renderable")
  }
  if (!isContainer(value)) return value
  if (seen.has(value)) throw new TypeError("circular tool arguments")
  // A **copy**, not a mutation: two properties pointing at the same object are
  // siblings, not a cycle, and a shared `seen` would report the second one as
  // circular - refusing to compare a perfectly renderable call.
  const nested = new Set(seen)
  nested.add(value)
  if (Array.isArray(value)) return value.map((item) => canonical(item, nested))
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const item = canonical(value[key], nested)
    // `undefined` is what `JSON.stringify` drops: keeping it would make
    // `{a:1,b:undefined}` differ from `{a:1}`, for no reason a tool could care
    // about - and a false difference here is a missed cut, not a safe refusal.
    if (item !== undefined) sorted[key] = item
  }
  return sorted
}

/**
 * The arguments as the one string two calls are compared on, or `null`.
 *
 * Note: `null` also covers an absent argument list, whose canonical rendering is
 * the `JSON.stringify` of `undefined` - nothing at all, which is exactly what it
 * is.
 */
export const canonicalArguments = (args: unknown): string | null => {
  try {
    return JSON.stringify(canonical(args, new Set())) ?? null
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict
// ─────────────────────────────────────────────────────────────────────────────

/** A call the agent proposed, reduced to what "the same call" means. */
export interface ProposedCall {
  /** The tool name, as the agent spelled it. */
  readonly name: string
  /** The tool arguments, exactly as received. */
  readonly arguments: unknown
}

/** A proposed call, reduced to something comparable, plus how often it happened. */
export interface CallFingerprint {
  readonly name: string
  /** Canonical rendering of the arguments; `null` when they cannot be rendered. */
  readonly args: string | null
  /** How many times this exact call has been proposed without a result. */
  readonly times: number
}

/** What the guard decided about a proposed call. */
export type LoopVerdict =
  /** The call passes: either it is the first one, or it is not the same call. */
  | { readonly repeat: false }
  /** The call is refused: the agent already proposed it and got no result. */
  | { readonly repeat: true; readonly name: string; readonly times: number }

/** The decision, and what the memory must hold once the call has been accepted. */
export interface LoopDecision {
  readonly verdict: LoopVerdict
  /** To remember **only** when the verdict is `repeat: false`. */
  readonly memory: CallFingerprint
}

/** Are the two fingerprints the same call, arguments that could be compared? */
const sameCall = (previous: CallFingerprint, call: CallFingerprint): boolean =>
  previous.name === call.name && call.args !== null && previous.args === call.args

/**
 * Judges a proposed call against the one the conversation is still waiting for.
 *
 * Note: the count is part of the memory, so a host that retries the turn is
 * told "3 times" rather than being told "twice" again on every attempt. It is
 * also the reason the verdict is not a boolean: the user is told **how many
 * times**, which is the figure that makes a decision possible.
 */
export const judgeCall = (
  previous: CallFingerprint | undefined,
  proposed: ProposedCall,
): LoopDecision => {
  const call: CallFingerprint = { name: proposed.name, args: canonicalArguments(proposed.arguments), times: 1 }
  if (previous === undefined || !sameCall(previous, call)) {
    return { verdict: { repeat: false }, memory: call }
  }
  const times = previous.times + 1
  return { verdict: { repeat: true, name: call.name, times }, memory: { ...call, times } }
}

/**
 * The message the user reads when a call is refused.
 *
 * Note: it names the tool, says how many times it was proposed, and says what to
 * do about it. A refusal the user cannot act on is an outage wearing the clothes
 * of a safeguard: cutting the loop here is only worth it if the human receives
 * the decision back.
 */
export const loopMessage = (verdict: Extract<LoopVerdict, { repeat: true }>): string =>
  `the agent proposed the tool call "${verdict.name}" ${String(verdict.times)} times in a row with ` +
  `identical arguments, and no tool result came back in between: the conversation cannot advance, ` +
  `so this turn is refused rather than spending tokens on it. Rephrase the request, or run it ` +
  `with another model.`
