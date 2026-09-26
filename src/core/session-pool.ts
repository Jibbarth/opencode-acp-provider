/**
 * Persistent ACP session pool.
 *
 * This module holds the **state** that `core/session-key.ts` deliberately has
 * none of: which ACP sessions are alive, which one carries which conversation,
 * how much history each has already received, and when it must die. The
 * decision logic stays pure and testable elsewhere; here there is only
 * lifecycle.
 *
 * The pool is **generic** (`SessionPool<AcpSession>` on the transport side,
 * `SessionPool<Fake>` in tests) and therefore knows neither ACP nor OpenCode.
 * It knows exactly two things about a session: open it, and close it. That is
 * what makes its three policies - reuse, bounded LRU, serialisation queue -
 * testable without starting a single subprocess.
 *
 * The three rules, and the reason for each:
 *
 * 1. One turn at a time per session. Two concurrent `session/prompt` calls on
 *    the same session steal each other's notifications, and the second
 *    `permissionSinks.set` would erase the first one's permission funnel - a
 *    permission refusal turned mute, the worst possible failure. Two OpenCode
 *    requests carrying the **same** conversation must therefore be **queued**,
 *    one after the other. Distinct conversations have distinct keys, hence
 *    distinct queues: they run in parallel, as they should.
 * 2. Bounded LRU, which never evicts a running turn. An ACP session costs
 *    memory in the agent; keeping one per conversation would open an
 *    ever-growing process. So the least recently used one is evicted - **unless**
 *    it carries a turn: closing it would interrupt a response that is still
 *    streaming. The bound is therefore a *defensive* ceiling, not a strict
 *    one: with N concurrent turns `max` can be exceeded by N, which is not
 *    comparable to a leak.
 * 3. Close on release, and "poisoned" closure. A session whose turn ended badly
 *    (dead agent, cancelled turn) carries an inconsistent memory: reusing it
 *    would send a delta to an agent that never saw the end of the previous
 *    turn. `poison()` marks the session; it is closed when the turn is
 *    released, never mid-flight - a stream is not cut from under its consumer.
 */

import type { NormalizedMessage } from "./types.js"
import { historyDigests, planTurn, sessionKey } from "./session-key.js"
import type { ResumeRefusal, SessionIdentity, TurnPlan } from "./session-key.js"

/** All the pool knows how to do to a session: close it. */
export interface ManagedSession {
  close(): Promise<void>
}

/**
 * Default number of live sessions.
 *
 * Note: this is a **default**, and it is deliberately modest - an ACP session
 * costs memory in the agent, and the worst case (one session per open
 * conversation) is precisely what the bound must prevent. Eight simultaneous
 * conversations is plenty for human use; beyond that, reopening a session is
 * preferable, and that costs a `session/new`, not a correctness regression. An
 * adapter wanting another bound passes its own to the constructor.
 */
export const DEFAULT_MAX_SESSIONS = 8

/** What a turn holds on its session until it is released. */
export interface TurnLease<S extends ManagedSession> {
  readonly session: S
  /** `true` if the session already existed and only receives the delta. */
  readonly reused: boolean
  /** What to send: the delta when resumed, the whole history otherwise. */
  readonly delta: readonly NormalizedMessage[]
  /** Why the session could not be resumed (`null` if it was). */
  readonly reason: ResumeRefusal | null
  /**
   * Declares the session unusable: it will be closed when the turn is released.
   *
   * The fail-safe's escape hatch: a cancelled turn or an agent dying mid-turn
   * leaves a memory whose continuity can no longer be guaranteed, and losing
   * the session is then **safer** than betting the agent will cope.
   */
  poison(): void
  /**
   * Gives the queue back. **Idempotent**, and mandatory even on error: it is
   * what unblocks the next turn of the same conversation. Every exit path of
   * the caller must therefore go through a `finally`.
   */
  release(): void
}

/** A live session, and what we know about it. */
interface Pooled<S extends ManagedSession> {
  readonly session: S
  /** Digests of everything the session already received, in order. */
  digests: readonly string[]
  /** Usage counter, for the LRU. */
  usedAt: number
  /** A turn is running: neither reusable nor evictable. */
  busy: boolean
  /** The memory is no longer reliable (poisoned turn). */
  poisoned: boolean
}

/** What an `acquire` decided, once the session is settled. */
interface Settled<S extends ManagedSession> {
  readonly pooled: Pooled<S>
  readonly reused: boolean
  readonly delta: readonly NormalizedMessage[]
  readonly reason: ResumeRefusal | null
}

/** A key's wait queue: a promise resolved on every release. */
interface Gate {
  /** Resolved when it is the next turn's turn in the queue. */
  tail: Promise<void>
  /** Number of waiters, to know when the queue can disappear. */
  waiting: number
}

/** Pool options. */
export interface SessionPoolOptions {
  /** Maximum number of retained sessions. Default: {@link DEFAULT_MAX_SESSIONS}. */
  readonly max?: number
}

/**
 * A bounded, serialised ACP session pool.
 *
 * No project dependency beyond `core/session-key.ts`: the class is testable on
 * its own, and the OpenCode transport only adds the actual opening of a session
 * (`() => agent.open()`).
 */
export class SessionPool<S extends ManagedSession> {
  /** Live sessions, by key. */
  private readonly records = new Map<string, Pooled<S>>()
  /** Wait queues, by key. */
  private readonly gates = new Map<string, Gate>()
  /** Monotonic LRU clock - `Date.now()` would be too coarse. */
  private clock = 0
  private readonly max: number

  constructor(options: SessionPoolOptions = {}) {
    const max = options.max ?? DEFAULT_MAX_SESSIONS
    // A negative or zero bound would make the pool unable to retain the session
    // it just opened, so it is clamped rather than accepted.
    this.max = Math.max(1, Math.floor(max))
  }

  /** Number of live sessions, busy ones included. */
  get size(): number {
    return this.records.size
  }

  /** The live keys, from least to most recently used. */
  keys(): readonly string[] {
    return [...this.records.entries()]
      .sort((left, right) => left[1].usedAt - right[1].usedAt)
      .map(([key]) => key)
  }

  /** `true` if a session is registered for this key. */
  has(identity: SessionIdentity, messages: readonly NormalizedMessage[]): boolean {
    return this.records.has(sessionKey(identity, messages))
  }

  /**
   * Takes hold of this conversation's session, and returns the turn plan.
   *
   * Note: the promise only resolves once the key's **queue** is free: that is
   * the whole of the serialisation. `open` is called only when no live session
   * can serve the turn, and its failure propagates rather than leaving a queue
   * stuck - the `catch` frees the queue in every case.
   */
  async acquire(
    identity: SessionIdentity,
    messages: readonly NormalizedMessage[],
    open: () => Promise<S>,
  ): Promise<TurnLease<S>> {
    const key = sessionKey(identity, messages)
    const digests = historyDigests(messages)
    const gate = this.enter(key)
    try {
      await gate.turn
      const settled = await this.settle(key, digests, messages, open)
      const pooled = settled.pooled
      let released = false
      return {
        session: pooled.session,
        reused: settled.reused,
        delta: settled.delta,
        reason: settled.reason,
        poison: () => {
          pooled.poisoned = true
        },
        release: () => {
          if (released) return
          released = true
          this.release(key, pooled, gate.open)
        },
      }
    } catch (error) {
      // Opening failed (dead agent, `session/new` refused): nobody will hold this
      // lease, so the queue is freed here. Without this `catch`, a single dead
      // session would freeze **every** following turn of the conversation.
      gate.open()
      throw error
    }
  }

  /**
   * Closes all sessions and empties the pool.
   *
   * Note: **busy** sessions are closed too - this is a shutdown, not an
   * eviction, and letting an in-flight turn prevent the process from dying
   * would be worse. The running turn sees its session go away and fails cleanly.
   */
  async closeAll(): Promise<void> {
    const records = [...this.records.values()]
    this.records.clear()
    this.gates.clear()
    await Promise.all(records.map((record) => this.discard(record.session)))
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Decides the plan, then produces the session that will carry it.
   *
   * Split out of `acquire` because this, and **only** this, is where state is
   * touched: the queue is already held, so no other task can observe a
   * half-modified pool.
   */
  private async settle(
    key: string,
    digests: readonly string[],
    messages: readonly NormalizedMessage[],
    open: () => Promise<S>,
  ): Promise<Settled<S>> {
    const known = this.records.get(key)

    if (known !== undefined) {
      // A **poisoned** session has already been removed from the pool on its
      // release (see `release`): it cannot be met here, so continuity alone
      // decides. That is why the plan only knows two outcomes.
      const plan: TurnPlan = planTurn(known.digests, digests, messages)
      if (plan.reuse) {
        // The session already holds the first N messages: only the remainder is
        // sent, and the transmitted history becomes its own.
        known.digests = digests
        known.usedAt = ++this.clock
        known.busy = true
        return { pooled: known, reused: true, delta: plan.delta, reason: null }
      }
      // The known session cannot serve this turn: it is dropped. Closing it here
      // is safe - the previous turn is over and the queue is ours - and it is the
      // only way not to keep in memory a session nothing will ever reuse.
      await this.drop(key, known)
      this.evict()
      return this.openNew(key, digests, messages, open, plan.reason)
    }

    this.evict()
    return this.openNew(key, digests, messages, open, "inconnue")
  }

  /**
   * Opens a fresh session and registers it for the key.
   *
   * Note: a fresh session receives the **whole** history, so its trace is
   * everything the request carries - which is what lets the next turn resume
   * it.
   */
  private async openNew(
    key: string,
    digests: readonly string[],
    messages: readonly NormalizedMessage[],
    open: () => Promise<S>,
    reason: ResumeRefusal,
  ): Promise<Settled<S>> {
    const pooled: Pooled<S> = {
      session: await open(),
      digests,
      usedAt: ++this.clock,
      busy: true,
      poisoned: false,
    }
    this.records.set(key, pooled)
    return { pooled, reused: false, delta: messages, reason }
  }

  /**
   * Evicts the least recently used session for as long as there is room.
   *
   * Note: the loop stops if the least recently used one is **busy**: the others
   * are busy too, so nothing is evictable. This is the *defensive* ceiling
   * announced at the top of the file - an overrun of one per in-flight turn,
   * not a leak.
   */
  private evict(): void {
    while (this.records.size >= this.max) {
      let victimKey: string | undefined
      let victim: Pooled<S> | undefined
      for (const [key, record] of this.records) {
        if (record.busy) continue
        if (victim === undefined || record.usedAt < victim.usedAt) {
          victimKey = key
          victim = record
        }
      }
      // Nothing evictable: overrun is accepted rather than killing a turn.
      if (victimKey === undefined || victim === undefined) return
      void this.drop(victimKey, victim)
    }
  }

  /** Removes a session from the pool, then closes it. */
  private async drop(key: string, record: Pooled<S>): Promise<void> {
    if (this.records.get(key) === record) this.records.delete(key)
    await this.discard(record.session)
  }

  /**
   * Closes a session without ever letting an error surface.
   *
   * Note: an already dead session (stopped agent) refuses `session/close`;
   * letting that exception through would fail a routine LRU eviction, and with
   * it a perfectly healthy turn. The pool has nothing to say about a failed
   * close.
   */
  private discard(session: S): Promise<void> {
    return session.close().then(
      () => undefined,
      () => undefined,
    )
  }

  /**
   * Takes a place in the key's queue and returns the function that frees it.
   *
   * The queue is a chain of promises that are **never rejected**: a rejection
   * would lose the next link, and the next turn would never be served again.
   *
   * Note: `release` is typed `(value: undefined) => void` and called with an
   * explicit `undefined` rather than `() => void`. `Promise<void>`'s `resolve`
   * takes `void | PromiseLike<void>`, and assigning it a zero-argument signature
   * is not a valid type application - the error would otherwise surface as a
   * bogus diagnostic where there is nothing to see.
   */
  private enter(key: string): { readonly turn: Promise<void>; readonly open: () => void } {
    const gate = this.gates.get(key) ?? { tail: Promise.resolve(), waiting: 0 }
    gate.waiting += 1
    const turn = gate.tail
    let release: (value: undefined) => void = () => {}
    const mine = new Promise<void>((resolve) => {
      release = resolve
    })
    gate.tail = turn.then(() => mine)
    this.gates.set(key, gate)
    return { turn, open: () => this.leave(key, () => release(undefined)) }
  }

  /**
   * Opens the queue to the caller, and erases it once nobody waits.
   *
   * Note: `open` is **idempotent** by construction - a promise resolves only
   * once, so a double call (a sloppy `finally`, a shutdown racing a turn) just
   * replays a no-op. The counter, on the other hand, is decremented once per
   * `leave`, since `leave` is the entry point.
   */
  private leave(key: string, open: () => void): void {
    open()
    const gate = this.gates.get(key)
    if (gate === undefined) return
    gate.waiting -= 1
    if (gate.waiting <= 0) this.gates.delete(key)
  }

  /**
   * Releases a turn: the queue moves on, and a poisoned session dies.
   *
   * Note: the clock is deliberately **not** bumped. A turn that just finished
   * must not become the most recent of the two, or a running conversation would
   * evict one idle for longer - that is, the exact opposite of an LRU. Leaving
   * `usedAt` untouched is what keeps the ordering on "last **use**" rather
   * than "last turn end".
   */
  private release(key: string, record: Pooled<S> | undefined, open: () => void): void {
    if (record !== undefined) {
      record.busy = false
      if (record.poisoned) void this.drop(key, record)
    }
    open()
  }
}
