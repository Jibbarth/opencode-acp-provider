/**
 * The memory of a conversation's last tool call.
 *
 * This module holds the **state** the guard needs and the decision module
 * (`core/tool-repetition.ts`) deliberately has none of: which call each
 * conversation proposed last, and how many times, until a result comes back. The
 * rule is pure and testable on its own; here there is only a store with a rearm
 * and a bound.
 *
 * Note: **why the state lives in the adapter, not in the reducer.** The
 * repetition is only visible where the call is emitted - the reducer, which turns
 * the agent's answer into a `tool-call` - and the conversation a turn belongs to
 * is only known where the request enters the protocol. The reducer therefore
 * carries the **verdict's input** in its state (`pending`, read once per request
 * by `initialStateFor`) and writes the outcome back here. The decision stays a
 * function of `(state, event)`, and this store is only ever *written* mid-stream.
 *
 * Note: the memory is **per conversation** (`loopScope`), so a loop in one chat
 * can never refuse a call in another. A conversation that ends with a dangling
 * proposal - the user interrupted the turn, OpenCode never sent a result back -
 * would otherwise leave its entry behind for the life of the process.
 */

import type { CallFingerprint } from "../core/tool-repetition.js"

/**
 * How many conversations may hold a call at once.
 *
 * Note: an **entry is created only by a tool call and deleted by its result**, so
 * a long server would otherwise accumulate one entry per conversation that ever
 * proposed a tool. The bound is not a correctness requirement - forgetting a
 * conversation only costs a missed cut, never a wrong refusal - but an unbounded
 * map in a process that outlives many chats is a leak, whatever it holds.
 */
export const DEFAULT_MAX_TRACKED = 32

/** Memory options. */
export interface ToolLoopOptions {
  /** Maximum number of conversations holding a call. Default: {@link DEFAULT_MAX_TRACKED}. */
  readonly max?: number
}

/**
 * What each conversation is still waiting for.
 *
 * Knows neither ACP nor OpenCode, and decides nothing: the only things it ever
 * sees are a scope, a boolean, and a fingerprint the decision module has already
 * produced. That is what makes the rearm rule and the isolation between
 * conversations testable without spawning a single subprocess.
 */
export class ToolLoopMemory {
  /** The last call per scope, in insertion order (oldest first). */
  private readonly calls = new Map<string, CallFingerprint>()
  private readonly max: number

  constructor(options: ToolLoopOptions = {}) {
    const max = options.max ?? DEFAULT_MAX_TRACKED
    // A zero or negative bound would forget every call the moment it is
    // remembered, disabling the guard without saying so.
    this.max = Math.max(1, Math.floor(max))
  }

  /** Number of conversations currently holding a call (tests, diagnostics). */
  get size(): number {
    return this.calls.size
  }

  /**
   * The call this conversation proposed last, and how many times - unless a tool
   * result came back since.
   *
   * `answered` is the **rearm**: a tool result in the incoming request means the
   * previous call got its answer, so it is forgotten and the agent is free to
   * propose the very same call again - which is the ordinary case of an agent
   * re-reading a file it has just read.
   *
   * Note: an empty scope is inert. `initialState` (the exported reducer state,
   * used by the protocol's own tests) has no conversation, and a test replaying
   * a `tool` event must neither consult nor pollute the process-wide memory.
   */
  arm(scope: string, answered: boolean): CallFingerprint | undefined {
    if (scope === "") return undefined
    if (answered) {
      this.calls.delete(scope)
      return undefined
    }
    return this.calls.get(scope)
  }

  /**
   * Stores the call a conversation has just proposed, and its count.
   *
   * Note: a **refused** call is stored as well as an accepted one. The memory
   * holds what the agent asked for, and only a result clears it: that is what
   * makes the count in the refusal message grow on a host that retries, and
   * what keeps the loop cut for as long as the result never comes.
   *
   * Note: the entry is **re-inserted** rather than overwritten. `Map` keeps
   * insertion order, and that order is what evicts: an active conversation must
   * not be sacrificed for an idle one, and a `set` on an existing key would
   * leave its rank untouched.
   */
  remember(scope: string, call: CallFingerprint): void {
    if (scope === "") return
    this.calls.delete(scope)
    this.calls.set(scope, call)
    while (this.calls.size > this.max) {
      const oldest = this.calls.keys().next()
      // `while` on a `Map` that cannot be emptied: the guard costs one check.
      if (oldest.done === true) return
      this.calls.delete(oldest.value)
    }
  }

  /** Forgets a conversation entirely (shutdown, tests). */
  forget(scope: string): void {
    this.calls.delete(scope)
  }
}

/**
 * The process-wide memory.
 *
 * Note: module level, exactly like the agent cache and the session pools next
 * door: the guard has to survive across turns, and a turn is not a caller's
 * lifetime. Keying by conversation is what keeps that from becoming global
 * state in any meaningful sense.
 */
export const toolLoop = new ToolLoopMemory()
