/**
 * The tool call repetition guard.
 *
 * Three levels, from the innermost to the outermost:
 *
 * 1. **the decision** (`core/tool-repetition.ts`), pure - a call and the call it
 *    may be repeating are two values, so every case the field never shows
 *    (reordered keys, uncomparable arguments, a third attempt) is a plain call;
 * 2. **the memory** (`adapters/tool-loop.ts`), with no host and no subprocess -
 *    the rearm rule, the isolation between conversations and the bound are
 *    proven directly;
 * 3. **end to end**, against `test/fake-acp.ts` - the same prompt sent twice
 *    ends on an explicit error, and the same call proposed again **with** a
 *    result in between goes through. The second case is what keeps the guard
 *    from being a wall: without it, the suite would only prove that refusals
 *    happen.
 *
 * Note: the end-to-end anchors carry a unique marker each (`GUARD-LOOP-A`,
 * `GUARD-LOOP-B`). The memory is process-wide and keyed by conversation, so two
 * tests sharing a first message would share a conversation - and the second one
 * would be refused for the wrong reason, or pass for the wrong one.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import { Effect, Result, Stream } from "effect"
import { LLMRequest, Message, SystemPart, ToolCallPart, ToolEntry, ToolResultPart } from "@opencode/ai/schema/index"
import type { LanguageModel, LLMEvent } from "@opencode/ai/schema/index"

import {
  canonicalArguments,
  carriesToolResult,
  judgeCall,
  loopMessage,
  loopScope,
} from "../src/core/tool-repetition.js"
import type { CallFingerprint } from "../src/core/tool-repetition.js"
import { DEFAULT_MAX_TRACKED, ToolLoopMemory, toolLoop } from "../src/adapters/tool-loop.js"
import { initialState, reduce } from "../src/adapters/opencode-protocol.js"
import type { ReducerState } from "../src/adapters/opencode-protocol.js"
import { closeCachedAgents } from "../src/adapters/opencode-transport.js"
import type { AcpPrepared } from "../src/adapters/opencode-transport.js"
import type { AcpEvent } from "../src/core/types.js"
import { model } from "../src/index.js"
import { parseSettings } from "../src/settings.js"
import type { AcpProviderSettings } from "../src/settings.js"

const FAKE = fileURLToPath(new URL("./fake-acp.ts", import.meta.url))

afterAll(async () => {
  // Agents **and** sessions are cached at module level: without this close,
  // `bun test` kills the test process leaving live children.
  await closeCachedAgents()
})

// ─────────────────────────────────────────────────────────────────────────────
// Utilities - level 1
// ─────────────────────────────────────────────────────────────────────────────

/** A call, spelled the way the agent would propose it. */
const call = (name: string, args: unknown): { readonly name: string; readonly arguments: unknown } => ({
  name,
  arguments: args,
})

/** What the memory holds after a call has been accepted. */
const memoryOf = (previous: CallFingerprint | undefined, name: string, args: unknown): CallFingerprint =>
  judgeCall(previous, call(name, args)).memory

/** A transcript holding no tool result: the state of a turn OpenCode has not answered. */
const NO_RESULT = [{ role: "user", text: "read the README" }] as const

/** The same transcript, once the tool has answered. */
const ANSWERED = [...NO_RESULT, { role: "tool", id: "call-1", name: "read", output: "# README" }] as const

/** A circular argument list: the case where identity cannot be established. */
const circular = (): unknown => {
  const value: Record<string, unknown> = { filePath: "README.md" }
  value["self"] = value
  return value
}

/** The event types, to compare a whole sequence at a glance. */
const types = (events: readonly LLMEvent[]): string[] => events.map((event) => event.type)

/** The first event of this type, failing loudly rather than on `undefined`. */
const first = <T extends LLMEvent["type"]>(
  events: readonly LLMEvent[],
  type: T,
): Extract<LLMEvent, { type: T }> => {
  const found = events.find((event): event is Extract<LLMEvent, { type: T }> => event.type === type)
  if (found === undefined) throw new Error(`no ${type} in ${types(events).join(", ")}`)
  return found
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The decision
// ─────────────────────────────────────────────────────────────────────────────

describe("the canonical rendering: the same arguments, whatever their key order", () => {
  test("two objects with the same keys in another order render identically", () => {
    expect(canonicalArguments({ a: 1, b: 2 })).toBe(canonicalArguments({ b: 2, a: 1 }))
  })

  test("arrays keep their order: a reordering is a different argument", () => {
    expect(canonicalArguments([1, 2])).not.toBe(canonicalArguments([2, 1]))
  })

  test("nested objects are sorted too", () => {
    expect(canonicalArguments({ a: { x: 1, y: 2 } })).toBe(canonicalArguments({ a: { y: 2, x: 1 } }))
  })

  test("an absent argument list renders as nothing at all", () => {
    // `JSON.stringify(undefined)` is `undefined`, and a tool with no argument
    // must not be compared against a tool whose argument is the string "null".
    expect(canonicalArguments(undefined)).toBeNull()
  })

  test("a cycle is not renderable, and does not throw", () => {
    expect(canonicalArguments(circular())).toBeNull()
  })

  test("a BigInt is not renderable either, and does not throw", () => {
    expect(canonicalArguments({ size: 1n })).toBeNull()
  })
})

describe("the verdict: only an EXACT repetition is refused", () => {
  test("the first call of a conversation is never refused", () => {
    expect(judgeCall(undefined, call("read", { filePath: "README.md" })).verdict).toEqual({ repeat: false })
  })

  test("the very same call, with no result since, is refused", () => {
    const memory = memoryOf(undefined, "read", { filePath: "README.md" })
    const verdict = judgeCall(memory, call("read", { filePath: "README.md" })).verdict
    expect(verdict).toEqual({ repeat: true, name: "read", times: 2 })
  })

  test("reordered keys do not make it a different call", () => {
    // The false negative this test exists for: a text comparison would call these
    // two different, and the loop would keep running.
    const memory = memoryOf(undefined, "read", { filePath: "README.md", offset: 0 })
    expect(judgeCall(memory, call("read", { offset: 0, filePath: "README.md" })).verdict).toEqual({
      repeat: true,
      name: "read",
      times: 2,
    })
  })

  test("another tool with the same arguments is not a repetition", () => {
    const memory = memoryOf(undefined, "read", { filePath: "README.md" })
    expect(judgeCall(memory, call("grep", { filePath: "README.md" })).verdict).toEqual({ repeat: false })
  })

  test("the same tool with different arguments is not a repetition", () => {
    // Reading another file is ordinary work, and refusing it would break a
    // working session.
    const memory = memoryOf(undefined, "read", { filePath: "README.md" })
    expect(judgeCall(memory, call("read", { filePath: "package.json" })).verdict).toEqual({ repeat: false })
  })

  test("arguments that cannot be rendered never refuse", () => {
    // Neither the previous call nor the proposed one can be compared: an
    // identity that cannot be established is not an identity, and a wrong
    // refusal is worse than the loop the guard is here to cut.
    const memory = memoryOf(undefined, "read", circular())
    expect(memory.args).toBeNull()
    expect(judgeCall(memory, call("read", circular())).verdict).toEqual({ repeat: false })
  })

  test("the count grows with every attempt, for a host that retries the turn", () => {
    // The memory stores what the agent proposed, refused or not, so the figure
    // the user is given on a retry is the one that matters: how much has been
    // burned.
    let memory = memoryOf(undefined, "read", { filePath: "README.md" })
    memory = judgeCall(memory, call("read", { filePath: "README.md" })).memory
    expect(judgeCall(memory, call("read", { filePath: "README.md" })).verdict).toEqual({
      repeat: true,
      name: "read",
      times: 3,
    })
  })

  test("a different call resets the count", () => {
    const first1 = memoryOf(undefined, "read", { filePath: "README.md" })
    // Another file: the memory now holds `a`, and the count starts over.
    const second = judgeCall(first1, call("read", { filePath: "a" }))
    expect(second.verdict).toEqual({ repeat: false })
    const third = judgeCall(second.memory, call("read", { filePath: "b" }))
    expect(third.verdict).toEqual({ repeat: false })
    expect(judgeCall(third.memory, call("read", { filePath: "b" })).verdict).toEqual({
      repeat: true,
      name: "read",
      times: 2,
    })
  })
})

describe("the rearm trigger: does the incoming request carry a result?", () => {
  test("a transcript without a tool message is a conversation waiting for one", () => {
    expect(carriesToolResult(NO_RESULT)).toBe(false)
  })

  test("a tool message is a result, and re-arms the guard", () => {
    expect(carriesToolResult(ANSWERED)).toBe(true)
  })
})

describe("the refusal message: it says what happened and what to do", () => {
  test("it names the tool, the number of times, and the remedy", () => {
    const message = loopMessage({ repeat: true, name: "read", times: 2 })
    expect(message).toContain('"read"')
    expect(message).toContain("2 times")
    expect(message).toContain("Rephrase the request")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. The memory
// ─────────────────────────────────────────────────────────────────────────────

describe("tool loop memory: one conversation, one pending call", () => {
  test("nothing is pending before the first call of a conversation", () => {
    expect(new ToolLoopMemory().arm("a", false)).toBeUndefined()
  })

  test("a sent call is what the next turn finds pending", () => {
    const memory = new ToolLoopMemory()
    memory.remember("a", memoryOf(undefined, "read", { filePath: "README.md" }))
    expect(memory.arm("a", false)).toEqual({
      name: "read",
      args: '{"filePath":"README.md"}',
      times: 1,
    })
  })

  test("a result re-arms: the previous call is forgotten", () => {
    const memory = new ToolLoopMemory()
    memory.remember("a", memoryOf(undefined, "read", { filePath: "README.md" }))
    // The turn arrives carrying the result: the agent may legitimately propose
    // the very same call again, and must find nothing pending.
    expect(memory.arm("a", true)).toBeUndefined()
    expect(memory.arm("a", false)).toBeUndefined()
    expect(memory.size).toBe(0)
  })

  test("two conversations never share a pending call", () => {
    // The scope of the guard is the conversation, and nothing else: a loop in
    // one chat must not refuse a call in another.
    const memory = new ToolLoopMemory()
    memory.remember("a", memoryOf(undefined, "read", { filePath: "README.md" }))
    expect(memory.arm("b", false)).toBeUndefined()
    expect(memory.arm("a", false)).toEqual({ name: "read", args: '{"filePath":"README.md"}', times: 1 })
  })

  test("a rearm in one conversation leaves the others alone", () => {
    const memory = new ToolLoopMemory()
    memory.remember("a", memoryOf(undefined, "read", { filePath: "a" }))
    memory.remember("b", memoryOf(undefined, "read", { filePath: "b" }))
    expect(memory.arm("a", true)).toBeUndefined()
    expect(memory.arm("b", false)).toEqual({ name: "read", args: '{"filePath":"b"}', times: 1 })
  })

  test("an empty scope is inert: the reducer's own tests are not a conversation", () => {
    const memory = new ToolLoopMemory()
    memory.remember("", memoryOf(undefined, "read", { filePath: "README.md" }))
    expect(memory.arm("", false)).toBeUndefined()
    expect(memory.size).toBe(0)
  })

  test("the memory is bounded, and the oldest conversation is the one forgotten", () => {
    const memory = new ToolLoopMemory({ max: 2 })
    memory.remember("a", memoryOf(undefined, "read", { filePath: "a" }))
    memory.remember("b", memoryOf(undefined, "read", { filePath: "b" }))
    memory.remember("c", memoryOf(undefined, "read", { filePath: "c" }))
    expect(memory.size).toBe(2)
    // "b" and "c" are still held; "a" was evicted, so its call is proposed again
    // as if nothing had happened. That is the price of the bound: a missed cut,
    // never a wrong refusal.
    expect(memory.arm("b", false)).toEqual({ name: "read", args: '{"filePath":"b"}', times: 1 })
    expect(memory.arm("a", false)).toBeUndefined()
  })

  test("the eviction follows the last use, never the age of the entry", () => {
    // An active conversation must not be sacrificed for an idle one, and the
    // bound must not be defeated by a conversation that keeps proposing.
    const memory = new ToolLoopMemory({ max: 2 })
    memory.remember("a", memoryOf(undefined, "read", { filePath: "a" }))
    memory.remember("b", memoryOf(undefined, "read", { filePath: "b" }))
    // "a" proposes again: its rank is refreshed, and nothing is evicted.
    memory.remember("a", memoryOf(undefined, "read", { filePath: "c" }))
    expect(memory.size).toBe(2)
    // "c" makes room: the **idle** "b" is the one that goes, not the active "a".
    memory.remember("c", memoryOf(undefined, "read", { filePath: "c" }))
    expect(memory.arm("b", false)).toBeUndefined()
    expect(memory.arm("a", false)).toEqual({ name: "read", args: '{"filePath":"c"}', times: 1 })
    expect(memory.size).toBe(2)
  })

  test("a null bound is brought back to 1, and the default is documented", () => {
    const memory = new ToolLoopMemory({ max: 0 })
    memory.remember("a", memoryOf(undefined, "read", { filePath: "a" }))
    expect(memory.size).toBe(1)
    expect(DEFAULT_MAX_TRACKED).toBeGreaterThan(1)
  })
})

describe("the scope: two conversations are told apart before anything runs", () => {
  const identity = { agent: "copilot --acp", cwd: "/srv/projet", model: "gpt-5.6-terra" }

  test("the same identity and the same first message are the same conversation", () => {
    expect(loopScope(identity, "M1")).toBe(loopScope(identity, "M1"))
  })

  test("a different first message is another conversation", () => {
    expect(loopScope(identity, "M1")).not.toBe(loopScope(identity, "M2"))
  })

  test("another agent, cwd or model is another conversation", () => {
    expect(loopScope(identity, "M1")).not.toBe(loopScope({ ...identity, agent: "other --acp" }, "M1"))
    expect(loopScope(identity, "M1")).not.toBe(loopScope({ ...identity, cwd: "/srv/autre" }, "M1"))
    expect(loopScope(identity, "M1")).not.toBe(loopScope({ ...identity, model: "claude-sonnet-5" }, "M1"))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. The reducer, wired to the memory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A turn of the `scope` conversation, built the way `initialStateFor` builds it.
 *
 * Note: written out rather than reached through the protocol, so the wiring
 * (state in, store written, next turn finds it) is observable without a host.
 */
const turnOf = (scope: string, answered = false): ReducerState => ({
  ...initialState,
  catalog: [{ name: "read", description: "", schema: {} }],
  loopScope: scope,
  pending: toolLoop.arm(scope, answered),
})

/** An ACP `tool_call`: the agent proposing a tool natively, as copilot does. */
const proposes = (id: string, input: unknown): AcpEvent => ({
  type: "tool",
  id,
  name: "read",
  title: "Read README.md",
  kind: "read",
  status: "pending",
  input,
})

/** The contract's proposal, as the agent's `text` carries it before the `done`. */
const contract = (input: unknown): readonly AcpEvent[] => [
  { type: "text", text: JSON.stringify({ type: "tool", name: "read", arguments: input }) },
  { type: "done", stopReason: "end_turn" },
]

/** Replays a sequence through the reducer, the way a turn streams. */
const replay = (state: ReducerState, events: readonly AcpEvent[]): LLMEvent[] => {
  let next = state
  const emitted: LLMEvent[] = []
  for (const event of events) {
    const step = reduce(next, event)
    emitted.push(...step.events)
    next = step.state
  }
  return emitted
}

describe("the reducer: a repetition ends the turn on an explicit error", () => {
  test("an ACP tool call, then the identical one with no result between", () => {
    const scope = "wiring-native"
    const first1 = replay(turnOf(scope), [proposes("call-1", { filePath: "README.md" })])
    expect(types(first1)).toContain("tool-call")

    const second = replay(turnOf(scope), [proposes("call-2", { filePath: "README.md" })])
    expect(types(second)).toEqual(["step-start", "step-finish", "provider-error"])
    expect(first(second, "provider-error").message).toContain('"read"')
  })

  test("the same through the output contract, and no finish behind the error", () => {
    const scope = "wiring-contract"
    expect(types(replay(turnOf(scope), contract({ filePath: "README.md" })))).toContain("tool-call")

    // The `done` would have emitted a `step-finish` and a `finish` after the
    // refusal: the core rejects anything following a terminal event, so the
    // reducer must not.
    const second = replay(turnOf(scope), contract({ filePath: "README.md" }))
    expect(types(second)).toEqual(["step-start", "step-finish", "provider-error"])
  })

  test("a tool_call_update is not a new proposal: one call, one decision", () => {
    // ACP sends several events for one call. Only the first carries an id the
    // turn has not seen, and only it is judged: a `completed` update repeating
    // the same input must not be read as a repetition of the proposal.
    const scope = "wiring-updates"
    const update: AcpEvent = {
      type: "tool",
      id: "call-1",
      name: "read",
      title: "Read README.md",
      kind: "read",
      status: "completed",
      input: { filePath: "README.md" },
    }
    const events = replay(turnOf(scope), [proposes("call-1", { filePath: "README.md" }), update])
    expect(types(events).filter((type) => type === "tool-call")).toEqual(["tool-call"])
  })

  test("another call in between re-arms nothing: only an exact repetition is cut", () => {
    const scope = "wiring-other"
    replay(turnOf(scope), [proposes("call-1", { filePath: "README.md" })])
    const other = replay(turnOf(scope), [proposes("call-2", { filePath: "package.json" })])
    expect(types(other)).toContain("tool-call")
  })

  test("a result in the request forgets the previous call", () => {
    const scope = "wiring-rearm"
    replay(turnOf(scope), [proposes("call-1", { filePath: "README.md" })])
    const answered = replay(turnOf(scope, true), [proposes("call-2", { filePath: "README.md" })])
    expect(types(answered)).toContain("tool-call")
    expect(types(answered)).not.toContain("provider-error")
  })

  test("a refused call is remembered with its count: the retry says 3 times", () => {
    // The memory holds what the agent proposed, refused or not, and only a
    // result clears it. A host that retries therefore meets the same answer -
    // and is told how much has already been spent.
    const scope = "wiring-retry"
    replay(turnOf(scope), [proposes("call-1", { filePath: "README.md" })])
    expect(types(replay(turnOf(scope), [proposes("call-2", { filePath: "README.md" })]))).toContain(
      "provider-error",
    )
    expect(toolLoop.arm(scope, false)).toEqual({
      name: "read",
      args: '{"filePath":"README.md"}',
      times: 2,
    })
    const retry = replay(turnOf(scope), [proposes("call-3", { filePath: "README.md" })])
    expect(types(retry)).toContain("provider-error")
    expect(first(retry, "provider-error").message).toContain("3 times")
  })

  test("a state without a conversation is untouched by the guard", () => {
    // What `initialState` is: the reducer's own tests replay a `tool` event
    // without any conversation, and must keep emitting it - twice included.
    const once = replay(initialState, [proposes("call-1", { filePath: "README.md" })])
    const twice = replay(initialState, [proposes("call-1", { filePath: "README.md" })])
    expect(types(once)).toContain("tool-call")
    expect(types(twice)).toContain("tool-call")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. End to end
// ─────────────────────────────────────────────────────────────────────────────

/** The fake agent's settings; fails loudly if the validation goes wrong. */
const fakeSettings = (): AcpProviderSettings => {
  const parsed = parseSettings({
    command: process.execPath,
    args: ["run", FAKE],
    cwd: process.cwd(),
    // `"ignore"`: the agent's stderr is an environment variable, so it stays
    // quiet; otherwise it would pollute the test output.
    stderr: "ignore",
  })
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.value
}

/** A `TransportRuntime` that is never called: the ACP transport does no HTTP. */
const NO_HTTP = { http: { execute: () => Effect.die("the ACP transport does no HTTP") } }

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

/** A conversation opening on `text`, with the `read` tool in the catalogue. */
const opening = (languageModel: LanguageModel, text: string): LLMRequest =>
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
    messages: [Message.user(text)],
  })

describe("end to end: the same prompt twice ends on an explicit error", () => {
  const settings = fakeSettings()

  test("the first turn proposes the tool, as it always did", async () => {
    // The control: without this, the next test would prove nothing - a turn that
    // never proposes a tool cannot be refused twice.
    const languageModel = model("gpt-5.6-terra", settings)
    const events = await runTurn(settings, "gpt-5.6-terra", opening(languageModel, "GUARD-LOOP-A TOOL_PROPOSAL"))
    expect(first(events, "tool-call")).toMatchObject({ name: "read", input: { filePath: "README.md" } })
    expect(types(events)).toContain("finish")
  })

  test("the identical prompt a second time is refused, with a message naming the tool", async () => {
    // This is the measured failure: OpenCode re-sends the same request before it
    // has validated the agent's message, and a deterministic agent proposes the
    // same call. The second one is refused rather than paid for.
    const languageModel = model("gpt-5.6-terra", settings)
    const events = await runTurn(settings, "gpt-5.6-terra", opening(languageModel, "GUARD-LOOP-A TOOL_PROPOSAL"))
    expect(types(events)).toEqual(["step-start", "step-finish", "provider-error"])
    const message = first(events, "provider-error").message
    expect(message).toContain('"read"')
    expect(message).toContain("2 times")
    // No second `tool-call`, and no `finish` behind the terminal event.
    expect(types(events)).not.toContain("tool-call")
    expect(types(events)).not.toContain("finish")
  })

  test("the same call with a result in between goes through untouched", async () => {
    // The other half, and the one that keeps the guard from being a wall: the
    // agent re-reading the file it just read is ordinary, well-behaved work.
    const languageModel = model("gpt-5.6-terra", settings)
    const first1 = opening(languageModel, "GUARD-LOOP-B TOOL_PROPOSAL")
    const events1 = await runTurn(settings, "gpt-5.6-terra", first1)
    expect(types(events1)).toContain("tool-call")

    const answered = new LLMRequest({
      model: first1.model,
      system: first1.system,
      tools: first1.tools,
      messages: [
        ...first1.messages,
        Message.assistant([ToolCallPart.make({ id: "call-1", name: "read", input: { filePath: "README.md" } })]),
        Message.tool(
          ToolResultPart.make({
            id: "call-1",
            name: "read",
            result: { type: "content", value: [{ type: "text", text: "# README" }] },
          }),
        ),
      ],
    })
    const events2 = await runTurn(settings, "gpt-5.6-terra", answered)
    expect(first(events2, "tool-call")).toMatchObject({ name: "read", input: { filePath: "README.md" } })
    expect(types(events2)).toContain("finish")
    expect(types(events2)).not.toContain("provider-error")
  })
})
