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
  describeIdentity,
  historyDigests,
  isContinuous,
  messageDigest,
  planTurn,
  refusalLabel,
  sessionKey,
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
const SEPARATOR = "-----8<-- PROMPT REÇU --8<-----"

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
  if (message === undefined) throw new Error(`CONVERSATION[${String(index)}] est absent`)
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
const within = async <A>(promise: Promise<A>, ms = 1_000, what = "la promesse"): Promise<A> => {
  let annuler: (() => void) | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${what} n'a pas été satisfaite en ${ms} ms`)), ms)
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
    const sans = sessionKey(IDENTITY, [assistant("A1")])
    const avec = sessionKey(IDENTITY, [user("M1"), assistant("A1")])
    expect(avec).not.toBe(sans)
  })

  test("a model change changes the key", () => {
    // An ACP session applied its model before its first turn: its memory is not
    // that of another model.
    const autre: SessionIdentity = { ...IDENTITY, model: "claude-sonnet-5" }
    expect(sessionKey(autre, CONVERSATION)).not.toBe(sessionKey(IDENTITY, CONVERSATION))
  })

  test("a different cwd changes the key", () => {
    // Two projects must never share an agent's memory.
    const autre: SessionIdentity = { ...IDENTITY, cwd: "/srv/autre" }
    expect(sessionKey(autre, CONVERSATION)).not.toBe(sessionKey(IDENTITY, CONVERSATION))
  })

  test("a different agent changes the key", () => {
    // Two commands have two memories, even when they look alike.
    const autre: SessionIdentity = { ...IDENTITY, agent: "codex --acp" }
    expect(sessionKey(autre, CONVERSATION)).not.toBe(sessionKey(IDENTITY, CONVERSATION))
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
    // Without the role in the digest, rewriting "Utilisateur : x" as
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
    const autre: NormalizedMessage = { role: "tool", id: "call-1", name: "bash", output: "# README" }
    expect(messageDigest(tool("call-1", "# README"))).not.toBe(messageDigest(autre))
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
    const edite = [...CONVERSATION.slice(0, 2), tool("call-1", "R1 modifié"), at(3)]
    expect(isContinuous(previous, historyDigests(edite))).toBe(false)
  })

  test("a message inserted in the middle breaks continuity", () => {
    const insere = [at(0), user("interposé"), ...CONVERSATION.slice(1)]
    expect(isContinuous(historyDigests(CONVERSATION), historyDigests(insere))).toBe(false)
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
// 4. The turn plan - resume or fresh session
// ─────────────────────────────────────────────────────────────────────────────

describe("turn plan: what the agent will receive", () => {
  test("first time: fresh session, whole history", () => {
    const plan = planTurn(undefined, historyDigests(CONVERSATION), CONVERSATION)
    expect(plan).toEqual({ reuse: false, reason: "inconnue" })
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
    const compacte = [user("résumé de la conversation")]
    const plan = planTurn(previous, historyDigests(compacte), compacte)
    expect(plan.reuse).toBe(false)
    if (plan.reuse) return
    expect(plan.reason).toBe("historique")
  })

  test("replay of the same turn: never an empty delta", () => {
    // A prompt with neither transcript nor message would produce a mute "ACK:".
    const digests = historyDigests(CONVERSATION)
    const plan = planTurn(digests, digests, CONVERSATION)
    expect(plan.reuse).toBe(false)
    if (plan.reuse) return
    // Note: the reason is `"historique"`, not `"vide"`. `isContinuous` requires
    // the history to have **grown**, so a replay at equal length is refused
    // before any delta is computed. Both reasons are a refusal to reuse, and
    // that refusal is what this test checks.
    expect(plan.reason).toBe("historique")
  })

  test("every refusal reason has a French label", () => {
    // A `reason` with no translation never reaches the user: it stays an English
    // keyword in a log.
    const motifs = [
      "inconnue",
      "historique",
      "vide",
    ] as const satisfies readonly ResumeRefusal[]
    for (const motif of motifs) {
      expect(refusalLabel[motif]).toMatch(/[a-zà-ÿ]{4,}/)
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

    const premier = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    expect(premier.reused).toBe(false)
    // A fresh session receives everything: the plan says so, and the caller uses
    // it.
    expect(premier.delta).toEqual([user("M1")])
    premier.release()

    const second = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))
    expect(second.reused).toBe(true)
    expect(second.reason).toBeNull()
    expect(second.session).toBe(premier.session)
    second.release()

    expect(book.opened).toHaveLength(1)
    expect(pool.size).toBe(1)
  })

  test("the second turn's delta holds only the new messages", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const premier = await pool.acquire(IDENTITY, CONVERSATION.slice(0, 1), opening(book, "s1"))
    premier.release()
    const second = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))
    expect(second.delta).toEqual(CONVERSATION.slice(1))
    second.release()
  })

  test("a rewritten history opens a fresh session and closes the old one", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const premier = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s1"))
    premier.release()
    // `/compact`: the history is no longer an extension.
    const compacte = [user("M1"), user("résumé")]
    const second = await pool.acquire(IDENTITY, compacte, opening(book, "s2"))

    expect(second.reused).toBe(false)
    if (second.reused) return
    expect(second.reason).toBe("historique")
    expect(book.opened).toHaveLength(2)
    // The old one is closed: nobody will reuse it, and keeping it in memory would
    // cost context in the agent for nothing.
    expect(book.opened[0]?.closed).toBe(true)
    second.release()
  })

  test("a model change opens a fresh session", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const premier = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    premier.release()
    const autre: SessionIdentity = { ...IDENTITY, model: "claude-sonnet-5" }
    const second = await pool.acquire(autre, CONVERSATION, opening(book, "s2"))

    expect(second.reused).toBe(false)
    expect(second.reason).toBe("inconnue")
    expect(book.opened).toHaveLength(2)
    second.release()
  })

  test("a different cwd opens a fresh session", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const premier = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    premier.release()
    const autre: SessionIdentity = { ...IDENTITY, cwd: "/srv/autre" }
    const second = await pool.acquire(autre, CONVERSATION, opening(book, "s2"))

    expect(second.reused).toBe(false)
    second.release()
  })

  test("a replay of the same turn sends no empty delta", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const premier = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s1"))
    premier.release()
    const rejeu = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))

    expect(rejeu.reused).toBe(false)
    if (rejeu.reused) return
    // Note: `"historique"`, not `"vide"`. The history did not grow, so
    // `isContinuous` refuses the resume before any delta is computed. What
    // matters here is the refusal - and above all the complete fallback below.
    expect(rejeu.reason).toBe("historique")
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

    const premier = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    premier.poison()
    premier.release()
    // The close happens on release, not before: a stream is not cut from under
    // its consumer.
    const second = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))

    expect(second.reused).toBe(false)
    if (second.reused) return
    // The poisoned session has **already** been removed from the pool on its
    // release, so the next turn is simply a first turn. That is the wanted
    // behaviour: a poisoned session must not haunt the pool, and the whole
    // history goes out again.
    expect(second.reason).toBe("inconnue")
    expect(second.delta).toEqual(CONVERSATION)
    expect(book.opened[0]?.closed).toBe(true)
    expect(book.opened).toHaveLength(2)
    second.release()
  })

  test("a poisoned agent still running is not abandoned", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const tour = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    tour.poison()
    // Before the release, the session is still its own: the pool cannot close a
    // session whose turn is running.
    expect(book.opened[0]?.closed).toBe(false)
    expect(pool.size).toBe(1)
    tour.release()
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
    const tour = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    tour.poison()
    tour.release()
    tour.release()
    expect(book.opened[0]?.closes).toBe(1)
    // The key's queue is not corrupted: the next turn goes through.
    const suivant = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))
    expect(suivant.reused).toBe(false)
    expect(pool.size).toBe(1)
    suivant.release()
  })

  test("a normal exit keeps the session in the pool", async () => {
    // That is the whole point of `reuse` mode: releasing a turn **returns** the
    // session to the pool instead of closing it. A close here would cost a
    // `session/new` on the next turn.
    const pool = new SessionPool<FakeSession>()
    const book = ledger()
    const tour = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    tour.release()
    expect(book.opened[0]?.closed).toBe(false)
    expect(book.opened[0]?.closes).toBe(0)
    expect(pool.size).toBe(1)
    // And it is indeed reused, with no session reopened.
    const suivant = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))
    expect(suivant.reused).toBe(true)
    expect(suivant.session).toBe(tour.session)
    expect(book.opened).toHaveLength(1)
    suivant.release()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. The pool - serialisation queue
// ─────────────────────────────────────────────────────────────────────────────

describe("session pool: one turn at a time per session", () => {
  test("two concurrent requests on the same conversation are queued", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const premier = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    // The second one is on the **same** key (same conversation, longer
    // history): it must wait, otherwise `session/prompt` would receive two
    // concurrent turns - the invariant already stated in `acp/agent.ts`.
    const attente = pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2"))
    await delay(20)
    expect(book.opened).toHaveLength(1)

    premier.release()
    const second = await within(attente, 1_000, "le second tour")
    expect(second.reused).toBe(true)
    expect(book.opened).toHaveLength(1)
    second.release()
  })

  test("three concurrent requests come out in arrival order", async () => {
    const pool = new SessionPool<FakeSession>()
    const book = ledger()

    const premier = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    const deux = pool.acquire(IDENTITY, [user("M1"), user("M2")], opening(book, "s2"))
    const trois = pool.acquire(IDENTITY, [user("M1"), user("M2"), user("M3")], opening(book, "s3"))

    // Each release only frees **the** next one: it is a queue, not a signal. A
    // pool waking everybody at once would leave two concurrent turns on the same
    // session.
    const ordre: number[] = []
    premier.release()
    const second = await within(deux, 1_000, "le deuxième tour")
    ordre.push(2)
    second.release()
    const troisieme = await within(trois, 1_000, "le troisième tour")
    ordre.push(3)
    troisieme.release()

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
      "la conversation B",
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

    const premier = await pool.acquire(IDENTITY, CONVERSATION, opening(book, "s1"))
    premier.release()
    await expect(
      pool.acquire(IDENTITY, CONVERSATION, () => Promise.reject(new Error("agent mort"))),
    ).rejects.toThrow("agent mort")

    const suivant = await within(
      pool.acquire(IDENTITY, CONVERSATION, opening(book, "s2")),
      1_000,
      "le tour suivant",
    )
    expect(suivant.reused).toBe(false)
    suivant.release()
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
    const autre = await pool.acquire(IDENTITY, [user("M2")], opening(book, "s2"))
    expect(book.opened[0]?.closed).toBe(false)
    // The ceiling is therefore exceeded by one per in-flight turn - and no more.
    expect(pool.size).toBe(2)
    occupe.release()
    autre.release()
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
    const tour = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    expect(tour.reused).toBe(false)
    tour.release()
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
    const tour = await pool.acquire(IDENTITY, [user("M1")], opening(book, "s1"))
    const autre = await pool.acquire(IDENTITY, [user("M2")], opening(book, "s2"))

    await pool.closeAll()
    expect(pool.size).toBe(0)
    expect(book.opened.map((session) => session.closed)).toEqual([true, true])
    // The late release must not reopen anything.
    tour.release()
    autre.release()
    expect(book.opened.map((session) => session.closes)).toEqual([1, 1])
  })

  test("a failing close does not interrupt an eviction", async () => {
    // An already dead session refuses `session/close`: letting the error through
    // would fail a perfectly healthy turn.
    const pool = new SessionPool<FakeSession>({ max: 1 })
    const livreuse = ledger()
    const premiere = await pool.acquire(IDENTITY, [user("M1")], opening(livreuse, "s1"))
    premiere.release()
    const cassee: FakeSession = new FakeSession("cassee")
    cassee.close = () => Promise.reject(new Error("session déjà morte"))
    const a = await pool.acquire(IDENTITY, [user("M2")], () => Promise.resolve(cassee))
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
const NO_HTTP = { http: { execute: () => Effect.die("le transport ACP ne fait pas de HTTP") } }

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
  if (Result.isFailure(outcome)) throw new Error(`le flux a échoué : ${outcome.failure.message}`)
  return outcome.success
}

/** One turn of conversation: what the user said, then what they got. */
type Step = { readonly role: "user" | "assistant" | "tool"; readonly text: string }

const requestOf = (languageModel: LanguageModel, steps: readonly Step[]): LLMRequest =>
  new LLMRequest({
    model: languageModel,
    system: [SystemPart.make("Tu es un assistant.")],
    tools: [
      ToolEntry.make({
        name: "read",
        description: "Lit un fichier du projet",
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
const TOUR_1: readonly Step[] = [{ role: "user", text: "MARQUEUR-1 PING" }]
const TOUR_2: readonly Step[] = [
  ...TOUR_1,
  { role: "assistant", text: "APPEL-1" },
  { role: "tool", text: "RESULTAT-1" },
  { role: "user", text: "MARQUEUR-2 PING" },
]
const TOUR_3: readonly Step[] = [...TOUR_2, { role: "user", text: "MARQUEUR-3 PING" }]

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
    expect(occurrences(prompt, "MARQUEUR-1")).toBe(1)
    expect(prompt).toContain("## Conversation\n")
    expect(prompt).not.toContain("## Conversation — suite")
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

    // Note: **the proof.** "MARQUEUR-1" was already in the first prompt:
    // sending it again would produce a duplicated history, and the agent would
    // see every message twice. Zero occurrences, then.
    expect(occurrences(second, "MARQUEUR-1")).toBe(0)

    // The delta itself is complete: tool call, tool result, new question - each
    // exactly once, in order.
    const conversation = conversationOf(second)
    expect(occurrences(conversation, "APPEL-1")).toBe(1)
    expect(occurrences(conversation, "RESULTAT-1")).toBe(1)
    expect(occurrences(conversation, "MARQUEUR-2")).toBe(1)
    expect(conversation).toContain("## Conversation — suite")
    expect(conversation).toContain("déjà échangés")

    // And the prompt stays **complete**: the output contract always closes the
    // message, and the tool catalogue is always there.
    expect(second).toContain("## Outils disponibles")
    expect(second.trimEnd().endsWith("toute tentative serait rejetée.")).toBe(true)
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
    for (const marqueur of ["MARQUEUR-1", "APPEL-1", "RESULTAT-1", "MARQUEUR-2"]) {
      expect({ marqueur, occurrences: occurrences(conversation, marqueur) }).toEqual({
        marqueur,
        occurrences: 0,
      })
    }
    expect(occurrences(conversation, "MARQUEUR-3")).toBe(1)
  })

  test("the reuse mode keeps one session and does not lose the turn", async () => {
    // The pool is **global to the module**: a known state is the starting point,
    // otherwise the count would depend on the previous tests - and a test that
    // depends on its order is a test that lies.
    await closeAllSessions()
    const file = await promptFile("retained")
    const settings = fakeSettings({ FAKE_PROMPT_FILE: file }, { session: "reuse" })
    const languageModel = model("gpt-5.6-terra", settings)

    const premier = await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_1))
    expect(premier.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual([
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
    expect(occurrences(second, "MARQUEUR-1")).toBe(1)
    expect(occurrences(second, "MARQUEUR-2")).toBe(1)
    expect(second).toContain("## Conversation\n")
    expect(second).not.toContain("## Conversation — suite")
  })

  test("an explicit `session: \"fresh\"` behaves like the default", async () => {
    const file = await promptFile("explicit")
    const settings = fakeSettings({ FAKE_PROMPT_FILE: file }, { session: "fresh" })
    const languageModel = model("gpt-5.6-terra", settings)

    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_1))
    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_2))

    const prompts = await readPrompts(file)
    expect(occurrences(prompts[1] ?? "", "MARQUEUR-1")).toBe(1)
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
    expect(occurrences(second, "MARQUEUR-1")).toBe(1)
    expect(second).not.toContain("## Conversation — suite")
  })

  test("another cwd changes the agent, and therefore the session", async () => {
    // Note: `cwd` goes into the **process** key (`agentKey`) as much as into the
    // session one: two projects have two agents. That is the most conservative
    // behaviour, and it is verified here end to end.
    const book = await mkdtemp(join(tmpdir(), "acp-cwd-a-"))
    const autre = await mkdtemp(join(tmpdir(), "acp-cwd-b-"))
    temporary.push(book, autre)
    const file = join(book, "prompts.txt")
    const settings = fakeSettings({ FAKE_PROMPT_FILE: file }, { session: "reuse" })
    const languageModel = model("gpt-5.6-terra", settings)

    await runTurn(settings, "gpt-5.6-terra", requestOf(languageModel, TOUR_1))
    // Same settings, except the directory: the agent is another one, so the
    // session is fresh and the whole history goes out again.
    const other: AcpProviderSettings = { ...settings, cwd: autre }
    await runTurn(other, "gpt-5.6-terra", requestOf(languageModel, TOUR_2))

    const prompts = await readPrompts(file)
    expect(prompts).toHaveLength(2)
    expect(occurrences(prompts[1] ?? "", "MARQUEUR-1")).toBe(1)
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
    if (Date.now() >= deadline) throw new Error(`le faux agent n'a jamais écrit ${pidFile}`)
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
