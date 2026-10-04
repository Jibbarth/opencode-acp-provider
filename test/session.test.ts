/**
 * Persistent ACP sessions.
 *
 * Three levels, from the innermost to the outermost:
 *
 * 1. **the key and the delta** (`core/session-key.ts`), pure - these are
 *    functions, so cases that never come up in a real run are plain calls:
 *    a prepended message, an edited message, `/compact`, a fork, a model change,
 *    a different `cwd`, a replay of the same turn;
 * 2. **the pool** (`core/session-pool.ts`), with a **fake** session - the
 *    serialisation queue and the LRU are proven without starting a single
 *    subprocess, and with no mock of the protocol whatsoever;
 * 3. **end to end**, against `test/fake-acp.ts` - two turns of the same
 *    conversation, and the **proof** that the second prompt holds only the
 *    delta. The capture is the one that already exists (`FAKE_PROMPT_FILE`): it
 *    is the only source saying what really reached the subprocess.
 *
 * Note: the `fresh` mode has as many tests as `reuse` mode. It is the default,
 * and a default that degrades in silence costs more than a visible regression:
 * if reuse became impossible, the fallback would have to be **proven**.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Effect, Result, Stream } from "effect"
import {
  LLMRequest,
  Message,
  SystemPart,
  ToolCallPart,
  ToolEntry,
  ToolResultPart,
} from "@opencode/ai/schema/index"
import type { LanguageModel, LLMEvent } from "@opencode/ai/schema/index"

import {
  DEFAULT_MAX_SESSIONS,
  SessionPool,
} from "../src/core/session-pool.js"
import type { ManagedSession } from "../src/core/session-pool.js"
import {
  conversationKey,
  describeIdentity,
  historyDigests,
  isContinuous,
  messageDigest,
  planTurn,
  refusalLabel,
  sessionKey,
  sharesMessage,
} from "../src/core/session-key.js"
import type { ResumeRefusal, SessionIdentity } from "../src/core/session-key.js"
import type { NormalizedMessage } from "../src/core/types.js"
import {
  closeAllSessions,
  closeCachedAgents,
  countRetainedSessions,
} from "../src/adapters/opencode-transport.js"
import type { AcpPrepared } from "../src/adapters/opencode-transport.js"
import { model } from "../src/index.js"
import { parseSettings } from "../src/settings.js"
import type { AcpProviderSettings } from "../src/settings.js"

const FAKE = fileURLToPath(new URL("./fake-acp.ts", import.meta.url))

/** The marker in `test/fake-acp.ts` that separates two deposited prompts. */
const SEPARATOR = "-----8<-- PROMPT RECEIVED --8<-----"

afterAll(async () => {
  // Agents **and** sessions are cached at module level: without this close,
  // `bun test` kills the test process leaving live children.
  await closeCachedAgents()
})

// ─────────────────────────────────────────────────────────────────────────────
// Utilities - level 1
// ─────────────────────────────────────────────────────────────────────────────

/** A session identity, with readable default values. */
const IDENTITY: SessionIdentity = { agent: "copilot --acp", cwd: "/srv/projet", model: "gpt-5.6-terra" }

const user = (text: string): NormalizedMessage => ({ role: "user", text })
const assistant = (text: string): NormalizedMessage => ({ role: "assistant", text })
const tool = (id: string, output: string): NormalizedMessage => ({ role: "tool", id, name: "read", output })

/** The history of a conversation that grows, turn after turn. */
const CONVERSATION: readonly NormalizedMessage[] = [
  user("M1"),
  assistant("A1"),
  tool("call-1", "R1"),
  user("M2"),
]

/** Number of occurrences of a pattern - the proof that a message is unique or not. */
const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1

/**
 * A message of the reference transcript, **without `as`**.
 *
 * The transcript is frozen: the index exists, and saying so loudly beats a cast
 * that would silently turn a test case into `undefined`.
 */
const at = (index: number): NormalizedMessage => {
  const message = CONVERSATION[index]
  if (message === undefined) throw new Error(`CONVERSATION[${String(index)}] is absent`)
  return message
}

/** The transcript section of a prompt, or `""` if there is none. */
const conversationOf = (prompt: string): string => {
  const start = prompt.search(/\n## Conversation/)
  if (start === -1) return ""
  const rest = prompt.slice(start)
  const next = rest.slice(1).search(/\n## /)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities - level 2: a fake session
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A toy ACP session: the only thing the pool knows how to do to it is close it.
 * No mock of the protocol, no side effect.
 */
class FakeSession implements ManagedSession {
  readonly id: string
  closed = false
  closes = 0

  constructor(id: string) {
    this.id = id
  }

  close(): Promise<void> {
    this.closed = true
    this.closes += 1
    return Promise.resolve()
  }
}

/** Records the opened sessions, for the LRU assertions. */
interface Ledger {
  readonly opened: FakeSession[]
}

const ledger = (): Ledger => ({ opened: [] })

/** An `open` that creates a fresh session and records it. */
const opening = (book: Ledger, name: string): (() => Promise<FakeSession>) => () => {
  const session = new FakeSession(name)
  book.opened.push(session)
  return Promise.resolve(session)
}

/** A promise resolving in `ms`, to prove a turn is waiting. */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fails an assertion if `promise` did not resolve in time.
 *
 * Note: without this bound, a serialisation test that breaks becomes a
 * **hanging test**: `bun test` waits, and the failure is never reported. A
 * forgotten serialisation must read as a clean failure.
 *
 * Note: the timer is **cancelled** as soon as the race is decided, in both
 * directions. A `Promise.race` does not cancel the loser: a timer left armed
 * would reject an already resolved promise, and that rejection would become
 * **orphan** - a test failure with no cause, unrelated to the serialisation
 * being checked.
 */
const within = async <A>(promise: Promise<A>, ms = 1_000, what = "the promise"): Promise<A> => {
  let annuler: (() => void) | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${what} was not satisfied within ${ms} ms`)), ms)
    annuler = () => clearTimeout(id)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    annuler?.()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The session key
// ─────────────────────────────────────────────────────────────────────────────

describe("session key: stable, and distinct when it must be", () => {
  test("the key survives the conversation growing", () => {
    // Note: this is the requirement that makes reuse possible. The key must only
    // change if the conversation **changes in nature**, not when it grows.
    const court = sessionKey(IDENTITY, [user("M1")])
    const long = sessionKey(IDENTITY, CONVERSATION)
    expect(long).toBe(court)
  })

  test("an identical prefix with a divergent tail stays the same key", () => {
    // Both conversations start alike and diverge afterwards: it is the tail that
    // separates them, and `isContinuous` is what must see it. The key cannot
    // tell them apart - hence the continuity requirement.
    expect(sessionKey(IDENTITY, [user("M1"), user("M2")])).toBe(
      sessionKey(IDENTITY, [user("M1"), user("M3")]),
    )
  })

  test("a prepended message changes the key", () => {
    const withoutPrefix = sessionKey(IDENTITY, [assistant("A1")])
    const withPrefix = sessionKey(IDENTITY, [user("M1"), assistant("A1")])
    expect(withPrefix).not.toBe(withoutPrefix)
  })

  test("a model change changes the key", () => {
    // An ACP session applied its model before its first turn: its memory is not
    // that of another model.
    const other: SessionIdentity = { ...IDENTITY, model: "claude-sonnet-5" }
    expect(sessionKey(other, CONVERSATION)).not.toBe(sessionKey(IDENTITY, CONVERSATION))
  })

  test("a different cwd changes the key", () => {
    // Two projects must never share an agent's memory.
    const other: SessionIdentity = { ...IDENTITY, cwd: "/srv/other" }
    expect(sessionKey(other, CONVERSATION)).not.toBe(sessionKey(IDENTITY, CONVERSATION))
  })

  test("a different agent changes the key", () => {
    // Two commands have two memories, even when they look alike.
    const other: SessionIdentity = { ...IDENTITY, agent: "codex --acp" }
    expect(sessionKey(other, CONVERSATION)).not.toBe(sessionKey(IDENTITY, CONVERSATION))
  })

  test("a different first message changes the key", () => {
    expect(sessionKey(IDENTITY, [user("M1"), user("M2")])).not.toBe(
      sessionKey(IDENTITY, [user("AUTRE"), user("M2")]),
    )
  })

  test("an empty conversation has a key, without throwing", () => {
    // `prepare` refuses a message-less request, but the function must stay
    // total: it is a key, not a program entry point.
    expect(typeof sessionKey(IDENTITY, [])).toBe("string")
    expect(sessionKey(IDENTITY, [])).not.toBe(sessionKey(IDENTITY, [user("M1")]))
  })

  test("the family is the identity alone, and it survives the anchor", () => {
    // Two keys of two conversations of the same project: same family, so a
    // session that lost its anchor can still be recognised as theirs.
    expect(conversationKey(IDENTITY)).toBe(conversationKey(IDENTITY))
    expect(conversationKey(IDENTITY)).not.toBe(sessionKey(IDENTITY, CONVERSATION))
    for (const other of [
      { ...IDENTITY, agent: "codex --acp" },
      { ...IDENTITY, cwd: "/srv/other" },
      { ...IDENTITY, model: "claude-sonnet-5" },
    ] satisfies SessionIdentity[]) {
      expect(conversationKey(other)).not.toBe(conversationKey(IDENTITY))
    }
  })

  test("the identity is described in French, for the logs", () => {
    // A diagnostic printing a 64-character digest says nothing: it needs the
    // agent, the directory and the model.
    expect(describeIdentity(IDENTITY)).toBe("copilot --acp [/srv/projet] gpt-5.6-terra")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. The message digest
// ─────────────────────────────────────────────────────────────────────────────

describe("message digest: sensitive to role and tool identity", () => {
  test("two messages with the same text but different roles do not share a digest", () => {
    // Without the role in the digest, rewriting "User : x" as
    // "Assistant : x" would pass for an addition - and the delta would be wrong.
    expect(messageDigest(user("x"))).not.toBe(messageDigest(assistant("x")))
  })

  test("two tool results with the same output do not share a digest", () => {
    // Two `read`s of the same file in the same conversation are indistinguishable
    // by their text: the `id` is what separates them.
    expect(messageDigest(tool("call-1", "# README"))).not.toBe(
      messageDigest(tool("call-2", "# README")),
    )
  })

  test("the tool name is part of the digest", () => {
    const other: NormalizedMessage = { role: "tool", id: "call-1", name: "bash", output: "# README" }
    expect(messageDigest(tool("call-1", "# README"))).not.toBe(messageDigest(other))
  })

  test("two identical messages share the same digest", () => {
    expect(messageDigest(user("x"))).toBe(messageDigest(user("x")))
  })

  test("the digests follow the transcript order", () => {
    const digests = historyDigests([user("A"), assistant("B")])
    expect(digests).toHaveLength(2)
    expect(digests[0]).toBe(messageDigest(user("A")))
    expect(digests[1]).toBe(messageDigest(assistant("B")))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Continuity - the real guard rail
// ─────────────────────────────────────────────────────────────────────────────

describe("continuity: is the received history an extension of the one already sent?", () => {
  test("a strict prefix is a continuity", () => {
    const previous = historyDigests(CONVERSATION.slice(0, 1))
    expect(isContinuous(previous, historyDigests(CONVERSATION))).toBe(true)
  })

  test("an identical history is not a continuity", () => {
    // Replay of the same turn: the delta would be empty, so the prompt would
    // carry no question to the agent.
    const digests = historyDigests(CONVERSATION)
    expect(isContinuous(digests, digests)).toBe(false)
  })

  test("a shrunk history is not a continuity", () => {
    // `/compact`: the summary replaces the tail, and the received history is
    // shorter than the one the session holds.
    expect(isContinuous(historyDigests(CONVERSATION), historyDigests(CONVERSATION.slice(0, 2)))).toBe(
      false,
    )
  })

  test("an edited message breaks continuity at the right rank", () => {
    const previous = historyDigests(CONVERSATION)
    // The tool result is rewritten: same rank, same `id`, different content.
    const edited = [...CONVERSATION.slice(0, 2), tool("call-1", "R1 modified"), at(3)]
    expect(isContinuous(previous, historyDigests(edited))).toBe(false)
  })

  test("a message inserted in the middle breaks continuity", () => {
    const inserted = [at(0), user("inserted"), ...CONVERSATION.slice(1)]
    expect(isContinuous(historyDigests(CONVERSATION), historyDigests(inserted))).toBe(false)
  })

  test("two swapped messages break continuity", () => {
    const permutes = [at(1), at(0)]
    const origine = [at(0), at(1)]
    expect(isContinuous(historyDigests(origine), historyDigests(permutes))).toBe(false)
  })

  test("an extension of the full conversation is a continuity", () => {
    const previous = historyDigests(CONVERSATION)
    const suite = [...CONVERSATION, assistant("A2"), user("M3")]
    expect(isContinuous(previous, historyDigests(suite))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe("shared messages: is this history the one that session was?", () => {
  test("a compaction keeps the recent tail, so the two histories overlap", () => {
    // What OpenCode's `/compact` does: a summary at rank 0, the recent messages
    // verbatim. That is the only thing making the session recognisable.
    const before = historyDigests(CONVERSATION)
    const after = historyDigests([user("summary"), tool("call-1", "R1"), user("M4")])
    expect(sharesMessage(before, after)).toBe(true)
    expect(isContinuous(before, after)).toBe(false)
  })

  test("a fork overlaps the branch it was taken from", () => {
    const before = historyDigests(CONVERSATION)
    const branche = historyDigests([user("other piste"), ...CONVERSATION])
    expect(sharesMessage(before, branche)).toBe(true)
  })

  test("two conversations of the same project share nothing", () => {
    // The false positive that must never happen: a second tab would lose its
    // session on the strength of a coincidence.
    const other = historyDigests([user("Another tab"), assistant("Hello")])
    expect(sharesMessage(historyDigests(CONVERSATION), other)).toBe(false)
  })

  test("an empty history shares nothing, and shares it with an empty one", () => {
    const emptyDigests = historyDigests([])
    expect(sharesMessage(emptyDigests, historyDigests(CONVERSATION))).toBe(false)
    expect(sharesMessage(emptyDigests, emptyDigests)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. The turn plan - resume or fresh session
// ─────────────────────────────────────────────────────────────────────────────

describe("turn plan: what the agent will receive", () => {
  test("first time: fresh session, whole history", () => {
    const plan = planTurn(undefined, historyDigests(CONVERSATION), CONVERSATION)
    expect(plan).toEqual({ reuse: false, reason: "unknown" })
  })

  test("resume: the delta is exactly the remainder, never the history", () => {
    const previous = historyDigests(CONVERSATION.slice(0, 1))
    const plan = planTurn(previous, historyDigests(CONVERSATION), CONVERSATION)
    expect(plan.reuse).toBe(true)
    if (!plan.reuse) return
    // The heart of the work: three messages, the ones missing. The first message
    // does **not** go back out - the duplicate is exactly the trap.
    expect(plan.delta).toEqual(CONVERSATION.slice(1))
  })

  test("rewritten history: fresh session, and the reason is named", () => {
    const previous = historyDigests(CONVERSATION)
    const compacted = [user("summary of the conversation")]
    const plan = planTurn(previous, historyDigests(compacted), compacted)
    expect(plan.reuse).toBe(false)
    if (plan.reuse) return
    expect(plan.reason).toBe("history")
  })

  test("replay of the same turn: never an empty delta", () => {
    // A prompt with neither transcript nor message would produce a mute "ACK:".
    const digests = historyDigests(CONVERSATION)
    const plan = planTurn(digests, digests, CONVERSATION)
    expect(plan.reuse).toBe(false)
    if (plan.reuse) return
    // Note: the reason is `"history"`, not `"empty"`. `isContinuous` requires
    // the history to have **grown**, so a replay at equal length is refused
    // before any delta is computed. Both reasons are a refusal to reuse, and
    // that refusal is what this test checks.
    expect(plan.reason).toBe("history")
  })

  test("every refusal reason has a readable label", () => {
    // A `reason` with no translation never reaches the user: it stays an English
    // keyword in a log.
    const motifs = [
      "unknown",
      "history",
      "empty",
    ] as const satisfies readonly ResumeRefusal[]
    for (const motif of motifs) {
      expect(refusalLabel[motif]).toMatch(/[a-z]{4,}/)
      expect(refusalLabel[motif]).not.toContain("undefined")
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. The pool - reuse
// ─────────────────────────────────────────────────────────────────────────────

describe("session pool: reuse and delta", () => {
  test("two turns of the same conversation open only one session", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const first = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    expect(first.reused).toBe(false)
    // A fresh session receives everything: the plan says so, and the caller uses
    // it.
    expect(first.delta).toEqual([user("M1")])
    first.release()

    const second = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))
    expect(second.reused).toBe(true)
    expect(second.reason).toBeNull()
    expect(second.session).toBe(first.session)
    second.release()

    expect(book.opened).toHaveLength(1)
    expect(pool.size).toBe(1)
  })

  test("the second turn's delta holds only the new messages", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const first = await pool.acquire(IDENTITY, CONVERSATION.slice(0, 1), opening(book, "s1"))
    first.release()
    const second = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))
    expect(second.delta).toEqual(CONVERSATION.slice(1))
    second.release()
  })

  test("a rewritten history opens a fresh session and closes the old one", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const first = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s1"))
    first.release()
    // `/compact`: the history is no longer an extension.
    const compacted = [user("M1"), user("summary")]
    const second = await pool.acquire(IDENTITY, compacted, opening(book, "s2"))

    expect(second.reused).toBe(false)
    if (second.reused) return
    expect(second.reason).toBe("history")
    expect(book.opened).toHaveLength(2)
    // The old one is closed: nobody will reuse it, and keeping it in memory would
    // cost context in the agent for nothing.
    expect(book.opened[0]?.closed).toBe(true)
    second.release()
  })

  test("a model change opens a fresh session", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const first = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    first.release()
    const other: SessionIdentity = { ...IDENTITY, model: "claude-sonnet-5" }
    const second = await pool.acquire(other, CONVERSATION, opening(book, "s2"))

    expect(second.reused).toBe(false)
    expect(second.reason).toBe("unknown")
    expect(book.opened).toHaveLength(2)
    second.release()
  })

  // Note: OpenCode's own `/compact` replaces the **first** message by a summary
  // and keeps the recent tail verbatim (`[summary][recent 15k][pending work]`),
  // so the anchor the key is built on moves while the rest of the history
  // survives: the pool is never handed the key of the session that held the
  // conversation, and that session holds verbatim messages the new history
  // still carries. Without the sweep below, it stays alive under a key nothing
  // will ever ask for again: one live ACP session per compaction.
  describe("a rewritten anchor", () => {
    /** A compaction of {@link CONVERSATION}: summary in, recent tail kept. */
    const COMPACTED: readonly NormalizedMessage[] = [
      user("summary from M1 to M3"),
      tool("call-1", "R1"),
      user("M4"),
    ]

    test("the session the conversation was is closed, and the pool does not grow", async () => {
      const pool = new SessionPool<FakeSession>()
      const book = ledger()

      const first = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s1"))
      first.release()
      const after = await pool.acquire(IDENTITY, COMPACTED, opening(book, "s2"))

      expect(after.reused).toBe(false)
      expect(book.opened).toHaveLength(2)
      expect(book.opened[0]?.closed).toBe(true)
      // The one that carries the compacted conversation is the only one left.
      expect(pool.size).toBe(1)
      expect(pool.keys()).toEqual([sessionKey(IDENTITY, COMPACTED)])
      after.release()
    })

    test("repeating it never accumulates sessions, bound or not", async () => {
      // Every compaction costs a `session/new` but must not cost a live session.
      const pool = new SessionPool<FakeSession>({ max: 2 })
      const book = ledger()
      let history: readonly NormalizedMessage[] = CONVERSATION

      for (let turn = 0; turn < 5; turn += 1) {
        const lease = await pool.acquire(IDENTITY, history, opening(book, `s${String(turn)}`))
        lease.release()
        expect(pool.size).toBe(1)
        // A new summary, the same kept tail, a new pending message.
        history = [user(`summary ${String(turn)}`), tool("call-1", "R1"), user(`M${String(turn)}bis`)]
      }

      expect(book.opened).toHaveLength(5)
      // Every session but the last one has been closed: none is unreachable.
      expect(book.opened.slice(0, 4).map((session) => session.closes)).toEqual([1, 1, 1, 1])
      expect(book.opened[4]?.closed).toBe(false)
    })

    test("another conversation of the same project is not mistaken for it", async () => {
      // Same agent, same directory, same model, and nothing in common: a second
      // tab must keep its session. A shared message is the only thing that
      // makes two histories the same conversation.
      const pool = new SessionPool<FakeSession>()
      const book = ledger()

      const first = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s1"))
      first.release()
      const other = await pool.acquire(IDENTITY, [user("Another tab"), assistant("Hello")], opening(book, "s2"))
      other.release()

      expect(book.opened[0]?.closed).toBe(false)
      expect(pool.size).toBe(2)
    })

    test("a session carrying a turn is never closed by the sweep", async () => {
      // The first conversation is still streaming when the compacted branch of
      // it opens: cutting a response from under its consumer is not a price
      // worth paying for a tidier pool. The orphan survives this turn and is
      // collected by the next rewrite, or by the LRU.
      const pool = new SessionPool<FakeSession>()
      const book = ledger()

      const first = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s1"))
      const after = await pool.acquire(IDENTITY, COMPACTED, opening(book, "s2"))
      expect(book.opened[0]?.closed).toBe(false)
      first.release()
      after.release()
      const next = await pool.acquire(
        IDENTITY,
        [...COMPACTED, assistant("A4")],
        opening(book, "s3"),
      )
      expect(next.reused).toBe(true)
      expect(book.opened).toHaveLength(2)
      expect(book.opened[0]?.closes).toBe(0)
      next.release()
      // A second compaction is a key miss, and now the orphan is collectable.
      const again = await pool.acquire(IDENTITY, [user("summary 2"), tool("call-1", "R1")], opening(book, "s4"))
      expect(book.opened[0]?.closes).toBe(1)
      again.release()
    })

    test("replacing a session closes it exactly once", async () => {
      // The same-key path and the sweep must never both name the same record.
      const pool = new SessionPool<FakeSession>()
      const book = ledger()

      const first = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s1"))
      first.release()
      // Anchor intact, tail rewritten: the key still matches, so this is a
      // **replacement**, and the sweep must not add a second close.
      const reecrit = [user("M1"), assistant("A1"), user("M2 modifie")]
      const second = await pool.acquire(IDENTITY, reecrit, opening(book, "s2"))
      expect(second.reused).toBe(false)
      if (second.reused) return
      expect(second.reason).toBe("history")
      expect(book.opened[0]?.closes).toBe(1)
      second.release()
      // And a later rewrite of the new session closes it once too.
      const third = await pool.acquire(IDENTITY, [user("M1 modifie"), assistant("A1")], opening(book, "s3"))
      third.release()
      expect(book.opened[1]?.closes).toBe(1)
    })

    test("a session that refuses to close does not fail the turn", async () => {
      // An agent that died between the compaction and the sweep: closing it
      // fails, and the turn must go on with the whole compacted history.
      const pool = new SessionPool<FakeSession>()
      const book = ledger()

      const first = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s1"))
      first.release()
      const broken: FakeSession = new FakeSession("broken")
      broken.close = () => Promise.reject(new Error("session already dead"))
      const after = await within(
        pool.acquire(IDENTITY, COMPACTED, () => Promise.resolve(broken)),
        1_000,
        "the turn after compaction",
      )

      expect(after.reused).toBe(false)
      expect(after.delta).toEqual(COMPACTED)
      expect(pool.size).toBe(1)
      after.release()
    })
  })

  test("a different cwd opens a fresh session", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const first = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    first.release()
    const other: SessionIdentity = { ...IDENTITY, cwd: "/srv/other" }
    const second = await pool.acquire(other, CONVERSATION, opening(book, "s2"))

    expect(second.reused).toBe(false)
    second.release()
  })

  test("a replay of the same turn sends no empty delta", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const first = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s1"))
    first.release()
    const rejeu = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))

    expect(rejeu.reused).toBe(false)
    if (rejeu.reused) return
    // Note: `"history"`, not `"empty"`. The history did not grow, so
    // `isContinuous` refuses the resume before any delta is computed. What
    // matters here is the refusal - and above all the complete fallback below.
    expect(rejeu.reason).toBe("history")
    // The fallback must stay **complete**: that is what guarantees the agent
    // receives a whole conversation.
    expect(rejeu.delta).toEqual(CONVERSATION)
    // The refusal is effective: the old session is closed, not reused.
    expect(book.opened[0]?.closed).toBe(true)
    expect(book.opened).toHaveLength(2)
    rejeu.release()
  })

  test("a poisoned agent is never resumed", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const first = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    first.poison()
    first.release()
    // The close happens on release, not before: a stream is not cut from under
    // its consumer.
    const second = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))

    expect(second.reused).toBe(false)
    if (second.reused) return
    // The poisoned session has **already** been removed from the pool on its
    // release, so the next turn is simply a first turn. That is the wanted
    // behaviour: a poisoned session must not haunt the pool, and the whole
    // history goes out again.
    expect(second.reason).toBe("unknown")
    expect(second.delta).toEqual(CONVERSATION)
    expect(book.opened[0]?.closed).toBe(true)
    expect(book.opened).toHaveLength(2)
    second.release()
  })

  test("a poisoned agent still running is not abandoned", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const turn = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    turn.poison()
    // Before the release, the session is still its own: the pool cannot close a
    // session whose turn is running.
    expect(book.opened[0]?.closed).toBe(false)
    expect(pool.size).toBe(1)
    turn.release()
    expect(book.opened[0]?.closed).toBe(true)
  })

  test("release is idempotent", async () => {
    // `effect`'s `Scope` may call a finaliser only once, but a double call must
    // neither close the session twice nor corrupt the queue. A **poisoned**
    // session is therefore observed: it is the only situation where a `release`
    // triggers a close, so a double call would give `closes === 2` if the guard
    // did not exist.
    const pool = new SessionPool<FakeSession>()
    const book = ledger()
    const turn = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    turn.poison()
    turn.release()
    turn.release()
    expect(book.opened[0]?.closes).toBe(1)
    // The key's queue is not corrupted: the next turn goes through.
    const next = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))
    expect(next.reused).toBe(false)
    expect(pool.size).toBe(1)
    next.release()
  })

  test("a normal exit keeps the session in the pool", async () => {
    // That is the whole point of `reuse` mode: releasing a turn **returns** the
    // session to the pool instead of closing it. A close here would cost a
    // `session/new` on the next turn.
    const pool = new SessionPool<FakeSession>()
    const book = ledger()
    const turn = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    turn.release()
    expect(book.opened[0]?.closed).toBe(false)
    expect(book.opened[0]?.closes).toBe(0)
    expect(pool.size).toBe(1)
    // And it is indeed reused, with no session reopened.
    const next = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))
    expect(next.reused).toBe(true)
    expect(next.session).toBe(turn.session)
    expect(book.opened).toHaveLength(1)
    next.release()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. The pool - serialisation queue
// ─────────────────────────────────────────────────────────────────────────────

describe("session pool: one turn at a time per session", () => {
  test("two concurrent requests on the same conversation are queued", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const first = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    // The second one is on the **same** key (same conversation, longer
    // history): it must wait, otherwise `session/prompt` would receive two
    // concurrent turns - the invariant already stated in `acp/agent.ts`.
    const attente = pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))
    await delay(20)
    expect(book.opened).toHaveLength(1)

    first.release()
    const second = await within(attente, 1_000, "the second turn")
    expect(second.reused).toBe(true)
    expect(book.opened).toHaveLength(1)
    second.release()
  })

  test("three concurrent requests come out in arrival order", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const first = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    const twoTurns = pool.acquire(IDENTITY, [user("M1"), user("M2")], opening(book, "s2"))
    const threeTurns = pool.acquire(IDENTITY, [user("M1"), user("M2"), user("M3")], opening(book, "s3"))

    // Each release only frees **the** next one: it is a queue, not a signal. A
    // pool waking everybody at once would leave two concurrent turns on the same
    // session.
    const ordre: number[] = []
    first.release()
    const second = await within(twoTurns, 1_000, "the second turn")
    ordre.push(2)
    second.release()
    const third = await within(threeTurns, 1_000, "the third turn")
    ordre.push(3)
    third.release()

    expect(ordre).toEqual([2, 3])
    // One single session for the three turns: they share the same key.
    expect(book.opened).toHaveLength(1)
  })

  test("two different conversations run in parallel", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const a = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    // Different key (different first message): nothing must block. Were the
    // queues global, this promise would only resolve after `a.release()`.
    const b = await within(
      pool.acquire(IDENTITY, [user("M2")], opening(book, "s2")),
      500,
      "conversation B",
    )
    expect(b.session).not.toBe(a.session)
    expect(pool.size).toBe(2)
    a.release()
    b.release()
  })

  test("an open failure hands the queue to the next turn", async () => {
    // Note: without this rendering, a single failed `session/new` would freeze
    // **every** following turn of the conversation: the worst possible symptom,
    // and one that does not explain itself (the first turn worked just fine). The
    // replay forces the opening, since continuity is refused by construction.
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const first = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s1"))
    first.release()
    await expect(
      pool.acquire(IDENTITY, CONVERSATION, () => Promise.reject(new Error("agent mort"))),
    ).rejects.toThrow("agent mort")

    const next = await within(
      pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2")),
      1_000,
      "the following turn",
    )
    expect(next.reused).toBe(false)
    next.release()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. The pool - bounded LRU and closing
// ─────────────────────────────────────────────────────────────────────────────

describe("session pool: bounded LRU", () => {
  test("beyond the bound, the least recently used session is closed", async () => {
    const pool = new SessionPool<FakeSession>({ max: 2 })
    const book = ledger()

    const a = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    a.release()
    const b = await pool.acquire(IDENTITY, [user("M2")], opening(book, "s2"))
    b.release()
    // A third conversation forces an eviction: `s1`, the least recently used.
    const c = await pool.acquire(IDENTITY, [user("M3")], opening(book, "s3"))
    c.release()

    expect(pool.size).toBe(2)
    expect(book.opened[0]?.closed).toBe(true)
    expect(book.opened[1]?.closed).toBe(false)
    expect(book.opened[2]?.closed).toBe(false)
  })

  test("a busy session is never evicted", async () => {
    // Closing a session mid-turn would interrupt the streaming: the bound is a
    // defensive ceiling, not a kill order.
    const pool = new SessionPool<FakeSession>({ max: 1 })
    const book = ledger()

    const occupe = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    const other = await pool.acquire(IDENTITY, [user("M2")], opening(book, "s2"))
    expect(book.opened[0]?.closed).toBe(false)
    // The ceiling is therefore exceeded by one per in-flight turn - and no more.
    expect(pool.size).toBe(2)
    occupe.release()
    other.release()
  })

  test("a resumed session is not the oldest", async () => {
    const pool = new SessionPool<FakeSession>({ max: 2 })
    const book = ledger()

    const a = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    a.release()
    const b = await pool.acquire(IDENTITY, [user("M2")], opening(book, "s2"))
    b.release()
    // Resuming `s1` makes it more recent than `s2`: it is the one that must stay.
    const a2 = await pool.acquire(IDENTITY, [user("M1"), user("M1bis")], opening(book, "s3"))
    expect(a2.reused).toBe(true)
    a2.release()
    const c = await pool.acquire(IDENTITY, [user("M3")], opening(book, "s4"))
    c.release()

    expect(book.opened[1]?.closed).toBe(true)
    expect(book.opened[0]?.closed).toBe(false)
  })

  test("a null bound is brought back to 1", async () => {
    // A zero ceiling would make the pool unable to retain the session it just
    // opened: every turn would reopen, and the eviction could have killed a
    // turn in flight.
    const pool = new SessionPool<FakeSession>({ max: 0 })
    const book = ledger()
    const turn = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    expect(turn.reused).toBe(false)
    turn.release()
    expect(pool.size).toBe(1)
  })

  test("the default bound is documented and reasonable", () => {
    // Eight simultaneous conversations: beyond that, reopening a session is
    // preferable.
    expect(DEFAULT_MAX_SESSIONS).toBe(8)
  })

  test("keys() lists the sessions from least to most recently used", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()
    const a = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    a.release()
    const b = await pool.acquire(IDENTITY, [user("M2")], opening(book, "s2"))
    b.release()
    const attenduA = sessionKey(IDENTITY, [user("M1")])
    const attenduB = sessionKey(IDENTITY, [user("M2")])
    expect(pool.keys()).toEqual([attenduA, attenduB])
    expect(pool.has(IDENTITY, [user("M1")])).toBe(true)
    expect(pool.has(IDENTITY, [user("M9")])).toBe(false)
    b.release()
  })

  test("closeAll closes everything, busy sessions included", async () => {
    // It is a shutdown, not an eviction: an in-flight turn must not keep the
    // process from dying.
    const pool = new SessionPool<FakeSession>()
    const book = ledger()
    const turn = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    const other = await pool.acquire(IDENTITY, [user("M2")], opening(book, "s2"))

    await pool.closeAll()
    expect(pool.size).toBe(0)
    expect(book.opened.map((session) => session.closed)).toEqual([true, true])
    // The late release must not reopen anything.
    turn.release()
    other.release()
    expect(book.opened.map((session) => session.closes)).toEqual([1, 1])
  })

  test("a failing close does not interrupt an eviction", async () => {
    // An already dead session refuses `session/close`: letting the error through
    // would fail a perfectly healthy turn.
    const pool = new SessionPool<FakeSession>({ max: 1 })
    const livreuse = ledger()
    const premiere = await pool.acquire(IDENTITY, [user("M1")], opening(livreuse, "s1"))
    premiere.release()
    const broken: FakeSession = new FakeSession("broken")
    broken.close = () => Promise.reject(new Error("session already dead"))
    const a = await pool.acquire(IDENTITY, [user("M2")], () => Promise.resolve(broken))
    a.release()
    const c = await within(pool.acquire(IDENTITY, [user("M3")], opening(livreuse, "s3")), 1_000)
    expect(c.reused).toBe(false)
    c.release()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. End to end: the proof that no message is duplicated
// ─────────────────────────────────────────────────────────────────────────────

/** The fake agent's settings; fails loudly if the validation goes wrong. */
const fakeSettings = (
  env: Record<string, string> = {},
  extra: Readonly<Record<string, unknown>> = {},
): AcpProviderSettings => {
  const parsed = parseSettings({
    command: process.execPath,
    args: ["run", FAKE],
    cwd: process.cwd(),
    // `"ignore"`: the agent's stderr is an environment variable, so it stays
    // quiet; otherwise it would pollute the test output.
    stderr: "ignore",
    env,
    ...extra,
  })
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.value
}

/** A `TransportRuntime` that is never called: the ACP transport does no HTTP. */
const NO_HTTP = { http: { execute: () => Effect.die("the ACP transport does no HTTP") } }

/** The prompts deposited by the fake agent, in the order received. */
const readPrompts = async (file: string): Promise<readonly string[]> =>
  (await readFile(file, "utf8")).split(SEPARATOR).slice(1).map((part) => part.replace(/^\n/, "").replace(/\n$/, ""))

/** Runs an end-to-end turn and returns its `LLMEvent`s. */
const runTurn = async (
  settings: AcpProviderSettings,
  modelID: string,
  request: LLMRequest,
): Promise<readonly LLMEvent[]> => {
  const languageModel = model(modelID, settings)
  const route = languageModel.route
  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const body = yield* route.body.from(request)
        const prepared: AcpPrepared = yield* route.prepareTransport(body, request)
        return yield* Stream.runCollect(route.streamPrepared(prepared, request, NO_HTTP))
      }),
    ).pipe(Effect.result),
  )
  if (Result.isFailure(outcome)) throw new Error(`the stream failed: ${outcome.failure.message}`)
  return outcome.success
}

/** One turn of conversation: what the user said, then what they got. */
type Step = { readonly role: "user" | "assistant" | "tool"; readonly text: string }

const requestOf = (languageModel: LanguageModel, steps: readonly Step[]): LLMRequest =>
  new LLMRequest({
    model: languageModel,
    system: [SystemPart.make("You are an assistant.")],
    tools: [
      ToolEntry.make({
        name: "read",
        description: "Reads a project file",
        inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
      }),
    ],
    messages: steps.map((step) => {
      switch (step.role) {
        case "user":
          return Message.user(step.text)
        case "assistant":
          return Message.assistant([
            ToolCallPart.make({ id: "call-1", name: "read", input: { filePath: step.text } }),
          ])
        case "tool":
          return Message.tool(
            ToolResultPart.make({
              id: "call-1",
              name: "read",
              result: { type: "content", value: [{ type: "text", text: step.text }] },
            }),
          )
      }
    }),
  })

/** The three turns of a scripted conversation, with unique markers. */
const TOUR_1: readonly Step[] = [{ role: "user", text: "MARKER-1 PING" }]
const TOUR_2: readonly Step[] = [
  ...TOUR_1,
  { role: "assistant", text: "CALL-1" },
  { role: "tool", text: "RESULT-1" },
  { role: "user", text: "MARKER-2 PING" },
]
const TOUR_3: readonly Step[] = [...TOUR_2, { role: "user", text: "MARKER-3 PING" }]

describe("end to end: resume sends only the delta", () => {
  const temporary: string[] = []

  const promptFile = async (label: string): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), `acp-session-${label}-`))
    temporary.push(directory)
    return join(directory, "prompts.txt")
  }

  afterAll(async () => {
    await closeAllSessions()
    await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("the first turn receives the whole history, and the resume header is absent", async () => {
    const file = await promptFile("first")
    const settings = fakeSettings({ FAKE_PROMPT_FILE: file }, { session: "reuse" })
    const languageModel = model("gpt-5.6-terra", settings)

    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_1))

    const prompts = await readPrompts(file)
    expect(prompts).toHaveLength(1)
    const prompt = prompts[0] ?? ""
    expect(occurrences(prompt, "MARKER-1")).toBe(1)
    expect(prompt).toContain("## Conversation\n")
    expect(prompt).not.toContain("## Conversation - continued")
  })

  test("the second turn receives ONLY the new messages", async () => {
    const file = await promptFile("delta")
    const settings = fakeSettings({ FAKE_PROMPT_FILE: file }, { session: "reuse" })
    const languageModel = model("gpt-5.6-terra", settings)

    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_1))
    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_2))

    const prompts = await readPrompts(file)
    expect(prompts).toHaveLength(2)
    const second = prompts[1] ?? ""

    // Note: **the proof.** "MARKER-1" was already in the first prompt:
    // sending it again would produce a duplicated history, and the agent would
    // see every message twice. Zero occurrences, then.
    expect(occurrences(second, "MARKER-1")).toBe(0)

    // The delta itself is complete: tool call, tool result, new question - each
    // exactly once, in order.
    const conversation = conversationOf(second)
    expect(occurrences(conversation, "CALL-1")).toBe(1)
    expect(occurrences(conversation, "RESULT-1")).toBe(1)
    expect(occurrences(conversation, "MARKER-2")).toBe(1)
    expect(conversation).toContain("## Conversation - continued")
    expect(conversation).toContain("already exchanged")

    // And the prompt stays **complete**: the output contract always closes the
    // message, and the tool catalogue is always there.
    expect(second).toContain("## Available tools")
    expect(second.trimEnd().endsWith("any attempt would be rejected.")).toBe(true)
  })

  test("by the third turn, nothing already said is replayed", async () => {
    const file = await promptFile("third")
    const settings = fakeSettings({ FAKE_PROMPT_FILE: file }, { session: "reuse" })
    const languageModel = model("gpt-5.6-terra", settings)

    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_1))
    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_2))
    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_3))

    const prompts = await readPrompts(file)
    expect(prompts).toHaveLength(3)
    const third = prompts[2] ?? ""
    const conversation = conversationOf(third)
    for (const marqueur of ["MARKER-1", "CALL-1", "RESULT-1", "MARKER-2"]) {
      expect({ marqueur, occurrences: occurrences(conversation, marqueur) }).toEqual({
        marqueur,
        occurrences: 0,
      })
    }
    expect(occurrences(conversation, "MARKER-3")).toBe(1)
  })

  test("the reuse mode keeps one session and does not lose the turn", async () => {
    // The pool is **global to the module**: a known state is the starting point,
    // otherwise the count would depend on the previous tests - and a test that
    // depends on its order is a test that lies.
    await closeAllSessions()
    const file = await promptFile("retained")
    const settings = fakeSettings({ FAKE_PROMPT_FILE: file }, { session: "reuse" })
    const languageModel = model("gpt-5.6-terra", settings)

    const first = await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_1))
    expect(first.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual([
      "PONG",
    ])
    expect(countRetainedSessions()).toBeGreaterThan(0)
    const second = await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_2))
    expect(second.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual([
      "PONG",
    ])
    // The session is closed neither between the turns nor after: that is the
    // whole point.
    expect(countRetainedSessions()).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8 bis. End to end: `reuse` when the agent dies
// ─────────────────────────────────────────────────────────────────────────────

describe("end to end: the reuse mode survives a dead agent", () => {
  const temporary: string[] = []

  const promptFile = async (label: string): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), `acp-reuse-death-${label}-`))
    temporary.push(directory)
    return join(directory, "prompts.txt")
  }

  /**
   * A marker path the fake uses to die **once**, then behave.
   *
   * Note: inside a `mkdtemp` directory, and that is not tidiness. The fake skips
   * its death when the marker already exists, so a path derived from anything
   * reusable - a pid, a label - inherits a stale marker from an earlier run, the
   * agent never dies, and the test asserts against a premise that stopped
   * holding. It fails rarely and for no visible reason.
   */
  const deathMarker = async (label: string): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), `acp-reuse-marker-${label}-`))
    temporary.push(directory)
    return join(directory, "died")
  }

  afterAll(async () => {
    for (const directory of temporary) await rm(directory, { recursive: true, force: true })
  })

  test("a retained session is not handed to the agent that replaces the dead one", async () => {
    // The failure this covers is **silent**, which is why it is worth a test of
    // its own. A pooled session is a live ACP session id, and it only means
    // anything to the process that created it. Evicting the agent without
    // closing its pool would let the next turn resume a session the replacement
    // has never heard of - and that path never goes through `session/new`, so no
    // amount of retrying there would notice.
    //
    // Note: `FAKE_DIE_ONCE_ON_CONFIG` fires on the **first** `set_config_option`,
    // which is turn 1. So turn 2 finds a retained session belonging to a dead
    // process: exactly the state under test.
    await closeAllSessions()
    const file = await promptFile("retained")
    const settings = fakeSettings(
      { FAKE_PROMPT_FILE: file, FAKE_DIE_ONCE_ON_CONFIG: await deathMarker("retained") },
      { session: "reuse" },
    )
    const languageModel = model("claude-sonnet-5", settings)

    // Turn 1 succeeds, and the recovery is invisible: the whole point.
    const first = await runTurn(settings, "claude-sonnet-5", requestOf(languageModel, TOUR_1))
    expect(first.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual([
      "PONG",
    ])

    // Turn 2, same conversation. A session is retained, and the agent that owned
    // it is gone.
    const second = await runTurn(settings, "claude-sonnet-5", requestOf(languageModel, TOUR_2))
    expect(second.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual([
      "PONG",
    ])

    // The proof that the dead session was **dropped** and not handed over is
    // twofold, and both halves matter.
    const prompts = await readPrompts(file)
    // Two prompts, not three: the death happened during turn 1's `initialize`
    // phase, **before** any prompt was sent, so the retry's prompt is the first
    // one recorded. A third would mean the corpse was prompted a second time.
    expect(prompts).toHaveLength(2)
    const last = prompts[1] ?? ""
    // Turn 2 resumed a session - so MARKER-1 is absent - and that session must
    // belong to the **live** agent. Had the dead one's session survived in the
    // pool, `session/prompt` would have named an id the replacement never issued,
    // and the turn would have failed instead of answering.
    expect(occurrences(last, "MARKER-1")).toBe(0)
    expect(occurrences(last, "MARKER-2")).toBe(1)
    expect(last).toContain("## Conversation - continued")

    // One session retained, and it is the live agent's - not the corpse's.
    expect(countRetainedSessions()).toBe(1)
  })

  test("reuse still resumes normally once the agent is healthy again", async () => {
    // The counterpart, and the one that would catch a fix that simply **disabled
    // reuse**: if every death permanently emptied the pool, the delta would stop
    // being a delta and this test would still pass. It has to see MARKER-1
    // *absent* from the second prompt.
    await closeAllSessions()
    const file = await promptFile("healthy")
    const settings = fakeSettings({ FAKE_PROMPT_FILE: file }, { session: "reuse" })
    const languageModel = model("gpt-5.6-terra", settings)

    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_1))
    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_2))

    const prompts = await readPrompts(file)
    expect(prompts).toHaveLength(2)
    // Zero occurrences: the session really was resumed.
    expect(occurrences(prompts[1] ?? "", "MARKER-1")).toBe(0)
    expect(countRetainedSessions()).toBe(1)
  })

  test("a dead agent in reuse mode does not leave the queue stuck", async () => {
    // The pool serialises turns per key. A turn that dies before `acquire`
    // resolves must still free its place in the queue, or **every** later turn of
    // that conversation waits forever - a hang, not an error, which is the worst
    // failure mode this project has.
    await closeAllSessions()
    const settings = fakeSettings(
      { FAKE_DIE_ONCE_ON_CONFIG: await deathMarker("queue") },
      { session: "reuse" },
    )
    const languageModel = model("claude-sonnet-5", settings)

    // Three turns in a row. If the first death wedged the key, this would hang
    // rather than fail - and `bun test` would time out instead of reporting.
    for (const tour of [TOUR_1, TOUR_2, TOUR_3]) {
      const events = await runTurn(settings, "claude-sonnet-5", requestOf(languageModel, tour))
      expect(events.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual([
        "PONG",
      ])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. End to end: the `fresh` fallback stays intact
// ─────────────────────────────────────────────────────────────────────────────

describe("end to end: the fresh mode stays the default and replays everything", () => {
  const temporary: string[] = []

  const promptFile = async (label: string): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), `acp-fresh-${label}-`))
    temporary.push(directory)
    return join(directory, "prompts.txt")
  }

  afterAll(async () => {
    await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("without `session`, the second prompt replays the whole history", async () => {
    // Note: this is the default mode and must stay so. If reuse activated by
    // default, an agent would see a truncated history without asking for it -
    // hence this test, which would fail loudly.
    const file = await promptFile("default")
    const settings = fakeSettings({ FAKE_PROMPT_FILE: file })
    expect(settings.session).toBeUndefined()
    const languageModel = model("gpt-5.6-terra", settings)

    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_1))
    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_2))

    const prompts = await readPrompts(file)
    expect(prompts).toHaveLength(2)
    const second = prompts[1] ?? ""
    expect(occurrences(second, "MARKER-1")).toBe(1)
    expect(occurrences(second, "MARKER-2")).toBe(1)
    expect(second).toContain("## Conversation\n")
    expect(second).not.toContain("## Conversation - continued")
  })

  test("an explicit `session: \"fresh\"` behaves like the default", async () => {
    const file = await promptFile("explicit")
    const settings = fakeSettings({ FAKE_PROMPT_FILE: file }, { session: "fresh" })
    const languageModel = model("gpt-5.6-terra", settings)

    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_1))
    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_2))

    const prompts = await readPrompts(file)
    expect(occurrences(prompts[1] ?? "", "MARKER-1")).toBe(1)
  })

  test("a model change invalidates the session, even in reuse", async () => {
    // The model goes into the session key: one model's memory is not another's,
    // and the fallback must stay "the whole history".
    //
    // Note: the turn's model comes from `request.model.id` (`fromRequest`), not
    // from the `modelID` passed to `runTurn`, so the request has to be built with
    // the other model's `LanguageModel`, otherwise this test would test nothing.
    const file = await promptFile("model")
    const settings = fakeSettings({ FAKE_PROMPT_FILE: file }, { session: "reuse" })
    const terra = model("gpt-5.6-terra", settings)
    const sonnet = model("claude-sonnet-5", settings)

    await runTurn(settings, "gpt-5.6-terra", requestOf(terra, TOUR_1))
    await runTurn(settings, "claude-sonnet-5", requestOf(sonnet, TOUR_2))

    const prompts = await readPrompts(file)
    expect(prompts).toHaveLength(2)
    const second = prompts[1] ?? ""
    expect(occurrences(second, "MARKER-1")).toBe(1)
    expect(second).not.toContain("## Conversation - continued")
  })

  test("another cwd changes the agent, and therefore the session", async () => {
    // Note: `cwd` goes into the **process** key (`agentKey`) as much as into the
    // session one: two projects have two agents. That is the most conservative
    // behaviour, and it is verified here end to end.
    const book = await mkdtemp(join(tmpdir(), "acp-cwd-a-"))
    const otherDir = await mkdtemp(join(tmpdir(), "acp-cwd-b-"))
    temporary.push(book, otherDir)
    const file = join(book, "prompts.txt")
    const settings = fakeSettings({ FAKE_PROMPT_FILE: file }, { session: "reuse" })
    const languageModel = model("gpt-5.6-terra", settings)

    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_1))
    // Same settings, except the directory: the agent is another one, so the
    // session is fresh and the whole history goes out again.
    const other: AcpProviderSettings = { ...settings, cwd: otherDir }
    await runTurn(other, "gpt-5.6-terra", requestOf(languageModel, TOUR_2))

    const prompts = await readPrompts(file)
    expect(prompts).toHaveLength(2)
    expect(occurrences(prompts[1] ?? "", "MARKER-1")).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. Shutdown: no process or session outlives the end
// ─────────────────────────────────────────────────────────────────────────────

describe("shutdown: no session left, no process left", () => {
  test("closeAllSessions empties the pools and closes the sessions", async () => {
    await closeAllSessions()
    const file = await mkdtemp(join(tmpdir(), "acp-close-"))
    const settings = fakeSettings(
      { FAKE_PROMPT_FILE: join(file, "prompts.txt") },
      { session: "reuse" },
    )
    const languageModel = model("gpt-5.6-terra", settings)
    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_1))
    expect(countRetainedSessions()).toBeGreaterThan(0)

    await closeAllSessions()
    expect(countRetainedSessions()).toBe(0)
    await rm(file, { recursive: true, force: true })
  })

  test("after closing the agents, the fake agent's subprocess is dead", async () => {
    // Note: the project's blocker #1. A left-open ACP session does not hold a
    // process, but a **pool** that is not emptied leaves orphan `session/close`
    // calls and, above all, makes it impossible to verify that a single exit
    // path exists. The fake agent's *precise* pid is therefore checked.
    const directory = await mkdtemp(join(tmpdir(), "acp-pid-"))
    const pidFile = join(directory, "pid.txt")
    // `FAKE_PID_FILE` is in `env`, which goes into `agentKey`: this agent is
    // therefore distinct from all the other tests', and the pid is its own.
    const settings = fakeSettings(
      { FAKE_PROMPT_FILE: join(directory, "prompts.txt"), FAKE_PID_FILE: pidFile },
      { session: "reuse" },
    )
    const languageModel = model("gpt-5.6-terra", settings)

    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_1))
    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_2))

    const pid = await readPid(pidFile)
    expect(isAlive(pid)).toBe(true)

    await closeCachedAgents()
    expect(countRetainedSessions()).toBe(0)
    expect(await waitForDeath(pid)).toBe(true)
    await rm(directory, { recursive: true, force: true })
  })
})

/** Waits for the pid to appear in the file (the agent is starting). */
const readPid = async (pidFile: string, timeoutMs = 5_000): Promise<number> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const raw = await readFile(pidFile, "utf8").catch(() => "")
    const pid = Number(raw.trim())
    if (Number.isInteger(pid) && pid > 0) return pid
    if (Date.now() >= deadline) throw new Error(`the fake agent never wrote ${pidFile}`)
    await delay(20)
  }
}

/** `true` as long as the process exists (signal 0 = "are you alive?"). */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits for the process to disappear, or for the delay. */
const waitForDeath = async (pid: number, timeoutMs = 3_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid) && Date.now() < deadline) await delay(25)
  return !isAlive(pid)
}
