/**
 * ACP session key and conversation delta.
 *
 * The problem, in one sentence: `LLMRequest` carries neither an OpenCode
 * `sessionID` nor a `cwd`, so there is no identifier to match against an ACP
 * session. Without one, every turn opens a fresh session and replays the whole
 * history into the prompt — the agent forgets everything between turns, even
 * though an ACP agent is stateful by nature.
 *
 * The key is an indexing trick: a hash of the identity plus the **first**
 * message, so it survives the conversation growing. The continuity guarantee is
 * a separate **proof**: the full history the session already received is
 * compared message by message, exactly. A prefix hash cannot do that — a
 * `/compact` replacing a long tail with a same-prefix summary would share the
 * key, and the agent would receive a delta computed against a conversation that
 * is not its own. Silently, and undiagnosable from the transcript.
 *
 * Note: this module imports nothing from the project, only `node:crypto` — no
 * `effect`, no `@opencode/ai`, no ACP SDK. `node:crypto` is a runtime builtin
 * present in every targeted host, not a framework dependency; an invariant test
 * in `test/opencode.test.ts` enforces it.
 */

import { createHash } from "node:crypto"

import type { NormalizedMessage } from "./types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What distinguishes two ACP sessions that must not be confused.
 *
 * Note: none of the three components is decorative. `agent` is the agent
 * **process** key — two agents (two commands, two environments) each have their
 * own memory, and mixing them would send one conversation's delta to another's
 * agent. `cwd` is the session's working directory: two projects must not share
 * a session. `model` has **already been applied** to the session via
 * `session/set_config_option` before its first turn, so switching model
 * mid-session would blend two reasoning histories in the same window — a model
 * change therefore yields a fresh session, which is the correct behaviour
 * rather than an accidental cost.
 */
export interface SessionIdentity {
  /** Agent process identity (spawn key). */
  readonly agent: string
  /** Session working directory, as the agent received it. */
  readonly cwd: string
  /** Model applied to the session. */
  readonly model: string
}

/** The session key in the readable form used by diagnostics. */
export const describeIdentity = (identity: SessionIdentity): string =>
  `${identity.agent} [${identity.cwd}] ${identity.model}`

// ─────────────────────────────────────────────────────────────────────────────
// Digests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `sha256` of a message, wide enough that a collision can never be mistaken
 * for content equality.
 *
 * Note: role and tool `id` are part of the digest — two messages with the same
 * text but different roles must not hash alike, otherwise a rewritten
 * conversation could pass for an appended one.
 */
export const messageDigest = (message: NormalizedMessage): string => {
  const payload =
    message.role === "tool"
      ? JSON.stringify(["tool", message.id, message.name, message.output])
      : JSON.stringify([message.role, message.text])
  return createHash("sha256").update(payload).digest("hex")
}

/**
 * Digests of the **whole** history, in order.
 *
 * Note: this is the continuity proof — comparing it against the previous trace
 * is what establishes that the session holds the first N messages, so only the
 * remainder needs to be sent. Digests rather than messages themselves: the
 * check stays exact and the memory retained per conversation is bounded to 64
 * characters per message.
 */
export const historyDigests = (messages: readonly NormalizedMessage[]): readonly string[] =>
  messages.map(messageDigest)

// ─────────────────────────────────────────────────────────────────────────────
// Key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The **family** a session belongs to: the identity alone, without any anchor.
 *
 * Note: a session opened for one identity can never serve another - the agent
 * memory, the working directory and the applied model are not shareable - so
 * this is the widest scope in which two live sessions can ever concern the same
 * conversation. It is what lets a session that lost its anchor be recognised
 * as belonging to the conversation now arriving, and only to it.
 */
export const conversationKey = (identity: SessionIdentity): string =>
  createHash("sha256")
    .update(JSON.stringify([identity.agent, identity.cwd, identity.model]))
    .digest("hex")

/**
 * A **stable** session key: it depends only on the identity and the **first**
 * message, so it survives the conversation growing.
 *
 * Note: the first message is the anchor because it is the only one guaranteed
 * to be present, identical and never rewritten by every destabilising scenario —
 * editing a message, forking, `/compact` all act **after** the start of the
 * conversation. A key covering more history would change every turn, making
 * reuse impossible; a shorter key (the agent alone) would confuse two distinct
 * conversations — the anchor is exactly the compromise.
 *
 * Note: rewriting the **first** message is the one scenario the anchor cannot
 * survive, and `/compact` does exactly that. The key then points at nothing
 * while the session it named is still alive, which is why the pool also tracks
 * {@link conversationKey}.
 *
 * An **empty** conversation (no message) gets a key computed without an anchor:
 * `prepare` rejects a message-less request anyway, but the function must not
 * throw on it, to stay pure and total.
 */
export const sessionKey = (
  identity: SessionIdentity,
  messages: readonly NormalizedMessage[],
): string => {
  const first = messages[0]
  const anchor = first === undefined ? "" : messageDigest(first)
  return createHash("sha256")
    .update(JSON.stringify([identity.agent, identity.cwd, identity.model, anchor]))
    .digest("hex")
}

// ─────────────────────────────────────────────────────────────────────────────
// Continuity and delta
// ─────────────────────────────────────────────────────────────────────────────

/** Why a live session cannot be resumed. */
export type ResumeRefusal =
  /** No session known for this key: one has to be opened. */
  | "inconnue"
  /** The incoming history is no longer an extension of the sent one. */
  | "historique"
  /** Nothing new to send: the prompt would be empty. */
  | "vide"

/** The decision, and what it implies for the prompt. */
export type TurnPlan =
  | { readonly reuse: true; readonly delta: readonly NormalizedMessage[] }
  | { readonly reuse: false; readonly reason: ResumeRefusal }

/** A readable reason, in French, for the logs. */
export const refusalLabel: Readonly<Record<ResumeRefusal, string>> = {
  inconnue: "aucune session ACP vivante pour cette conversation",
  historique: "l'historique a été réécrit (édition, fork ou /compact)",
  vide: "le tour n'apporte aucun message nouveau",
}

/**
 * Are the first N received messages **exactly** the ones already sent?
 *
 * Pure, and this is the whole heart of reuse: `previous` is the trace of what
 * the ACP session received, `current` what the request brings. The test is
 * deliberately **strict** — no tolerance, no "at least n":
 *
 * - the history must have **grown** (`>`): at equal length the request is a
 *   replay of the same turn, and the delta would be empty;
 * - **every** earlier digest must be found at the same rank. An edited,
 *   inserted, removed or reordered message breaks equality at the first gap,
 *   and the exact rank prevents a shared prefix from masking a divergence.
 */
export const isContinuous = (
  previous: readonly string[],
  current: readonly string[],
): boolean => {
  if (current.length <= previous.length) return false
  for (let i = 0; i < previous.length; i += 1) {
    if (current[i] !== previous[i]) return false
  }
  return true
}

/**
 * Do these two histories mention at least one **same** message?
 *
 * Note: the proof of continuity is a prefix, so a shared message proves nothing
 * about resuming — it answers the other question. A history that keeps some of
 * a live session's messages while no longer extending them has been **rewritten**:
 * the summary a `/compact` puts at rank 0, the branch a fork opens, the edit that
 * rewrote the first message. The session is then unreachable by key and will
 * stay so, whatever the conversation does next.
 *
 * Note: an empty overlap proves nothing at all, and must not be read as a
 * rewrite. Two conversations of the same directory, of the same model, on the
 * same agent, routinely share nothing - and a false rewrite would cost a live
 * session its whole memory.
 */
export const sharesMessage = (
  previous: readonly string[],
  current: readonly string[],
): boolean => {
  for (const digest of previous) {
    if (current.includes(digest)) return true
  }
  return false
}

/**
 * Decides, for a turn, whether to **resume** a live session and send only the
 * delta, or to open a fresh one with the whole history.
 *
 * Pure: same triplet implies same plan, with no state anywhere.
 *
 * Note: `current` **must** be `historyDigests(messages)`. The pool computes the
 * digests once to both store and decide; recomputing them here would cost a
 * `sha256` per message for nothing, and accepting two inconsistent arrays would
 * make the delta unprovable. The contract is explicit: messages only, never
 * digests computed elsewhere.
 *
 * Note: since `isContinuous` already requires the history to have grown, the
 * `delta.length === 0` guard below is unreachable — a replay of the same turn
 * is refused as `"historique"`, one step earlier. The guard stays as a
 * defence-in-depth: an empty delta would produce a prompt with neither
 * transcript nor message, and the agent would answer nothing — a mute `ACK:`,
 * inexplicable to the user. A fresh session receiving the whole history is
 * always the safer fallback.
 */
export const planTurn = (
  previous: readonly string[] | undefined,
  current: readonly string[],
  messages: readonly NormalizedMessage[],
): TurnPlan => {
  if (previous === undefined) return { reuse: false, reason: "inconnue" }
  if (!isContinuous(previous, current)) return { reuse: false, reason: "historique" }
  const delta = messages.slice(previous.length)
  if (delta.length === 0) return { reuse: false, reason: "vide" }
  return { reuse: true, delta }
}
