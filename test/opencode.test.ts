/**
 * The OpenCode adapter.
 *
 * Three levels, from the innermost to the outermost:
 *
 * 1. **the reducer**, pure - the cases a real agent produces too rarely to
 *    trigger on demand (a delta without a start, an agent dying mid-block) are
 *    here plain function calls;
 * 2. **the settings** - invalid JSON must produce a message naming the field,
 *    not a `TypeError` inside the OpenCode server;
 * 3. **end to end** - the real route, built by `model(...)`, against
 *    `test/fake-acp.ts` spawned as a real subprocess. This is the only level
 *    that proves the `LLMEvent` sequence is accepted by the real pipeline: a
 *    malformed sequence fails with "The provider response ended
 *    unexpectedly.", indistinguishable from a truncation.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { Effect, Result, Stream } from "effect"
import { Usage } from "@opencode/ai/schema/index"
import {
  GenerationOptions,
  LLMRequest,
  Message,
  ProviderConfigurationError,
  SystemPart,
  ToolCallPart,
  ToolEntry,
  ToolResultPart,
} from "@opencode/ai/schema/index"
import type { LLMEvent, LanguageModel } from "@opencode/ai/schema/index"

import { halt, initialState, reduce } from "../src/adapters/opencode-protocol.js"
import type { ReducerState } from "../src/adapters/opencode-protocol.js"
import { acquireAgent, closeCachedAgents } from "../src/adapters/opencode-transport.js"
import type { AcpPrepared } from "../src/adapters/opencode-transport.js"
import type { AcpEvent } from "../src/core/types.js"
import { renderRequest } from "../src/core/prompt.js"
import { model } from "../src/index.js"
import { agentKey, parseSettings } from "../src/settings.js"
import type { AcpProviderSettings } from "../src/settings.js"

const FAKE = fileURLToPath(new URL("./fake-acp.ts", import.meta.url))

afterAll(async () => {
  // ACP agents are cached at module level: without this close, `bun test` kills
  // the test process leaving live children.
  await closeCachedAgents()
})

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
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
    // quiet; otherwise `FAKE_NOISY_STDOUT` would pollute the test output.
    stderr: "ignore",
    env,
    ...extra,
  })
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.value
}

/** Replays a sequence of ACP events through the reducer. */
const replay = (
  events: readonly AcpEvent[],
  from: ReducerState = initialState,
): { readonly state: ReducerState; readonly events: LLMEvent[] } => {
  const emitted: LLMEvent[] = []
  let state = from
  for (const event of events) {
    const step = reduce(state, event)
    emitted.push(...step.events)
    state = step.state
  }
  return { state, events: emitted }
}

/** A reducer state carrying a tool catalogue, the way `initial(request)` does. */
const withTools = (
  ...names: readonly string[]
): ReducerState => ({
  ...initialState,
  catalog: names.map((name) => ({ name, description: "", schema: {} })),
})

/** The event types, to compare a whole sequence at a glance. */
const types = (events: readonly LLMEvent[]): string[] => events.map((event) => event.type)

/**
 * An agent answer **conforming to the contract** of `core/prompt.ts`.
 *
 * Note: an ACP `text` is no longer the answer but the contract object: the
 * reducer decodes it at the `done`. These shorthands avoid writing literal JSON
 * in every test, and above all make the constraint visible: a hard-coded `text`
 * would now fail as `provider-error`.
 */
const say = (text: string): AcpEvent => ({
  type: "text",
  text: JSON.stringify({ type: "text", text }),
})

/** A **raw** ACP `text`, that is an agent that does not obey the contract. */
const raw = (text: string): AcpEvent => ({ type: "text", text })

/** The index of an event of this type, or -1. */
const indexOfType = (events: readonly LLMEvent[], type: string): number =>
  events.findIndex((event) => event.type === type)

/** The first event of this type; the test assumes it exists. */
const first = <T extends LLMEvent["type"]>(
  events: readonly LLMEvent[],
  type: T,
): Extract<LLMEvent, { type: T }> => {
  const found = events.find((event): event is Extract<LLMEvent, { type: T }> => event.type === type)
  if (found === undefined) throw new Error(`no "${type}" event in ${types(events).join(", ")}`)
  return found
}

/**
 * The test's `TransportRuntime`.
 *
 * The ACP transport **never** does HTTP, so this executor is never called. It is
 * nevertheless built (the type demands it) and it dies loudly: a silent
 * `Effect.succeed` would hide the day someone wires a real HTTP endpoint by
 * accident.
 */
const NO_HTTP = { http: { execute: () => Effect.die("the ACP transport does no HTTP") } }

// ─────────────────────────────────────────────────────────────────────────────
// 1. The reducer, pure
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpEvent -> LLMEvent reducer", () => {
  test("the text is buffered, then rendered as a single block at the done", () => {
    // Note: **a deliberate behaviour change.** The text is no longer streamed
    // delta by delta: it cannot be, since until the whole answer has been read
    // there is no way to know whether it is text or a tool call.
    const before = replay([
      { type: "text", text: '{"type":"text","text":"he' },
      { type: "text", text: 'llo"}' },
    ])
    // Nothing is emitted before the `done`: that is the heart of the trade-off.
    expect(before.events).toEqual([])

    const { events } = replay(
      [
        { type: "text", text: '{"type":"text","text":"he' },
        { type: "text", text: 'llo"}' },
        { type: "done", stopReason: "end_turn" },
      ],
      before.state,
    )
    expect(types(events)).toEqual([
      "step-start",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
      "finish",
    ])
    // A **single** delta, carrying the answer and not the contract's JSON.
    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual(["hello"])
  })

  test("a reasoning block is closed before the rendered text", () => {
    const { events } = replay([
      { type: "thought", text: "I am thinking" },
      say("answer"),
      { type: "done", stopReason: "end_turn" },
    ])
    expect(types(events)).toEqual([
      "step-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
      "finish",
    ])
    // `reasoning-end` **before** `text-start`: one open block at a time.
    expect(indexOfType(events, "reasoning-end")).toBeLessThan(indexOfType(events, "text-start"))
  })

  test("reasoning keeps streaming live while the text accumulates", () => {
    // What stays live is exactly what the user needs to see while the buffer
    // fills: the agent's activity.
    const { events } = replay([
      raw('{"type":"text","text":"ans'),
      { type: "thought", text: "I am searching" },
      { type: "plan", entries: [{ content: "Analyze", priority: "high", status: "pending" }] },
      { type: "text", text: 'wer"}' },
      { type: "done", stopReason: "end_turn" },
    ])
    expect(types(events)).toEqual([
      "step-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
      "finish",
    ])
    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual(["answer"])
  })

  test("a done with nothing still produces a valid sequence", () => {
    // An agent writing nothing is not a malformed output: there is simply nothing
    // to decode, and it ends cleanly.
    const { events } = replay([{ type: "done", stopReason: "end_turn" }])
    expect(types(events)).toEqual(["step-start", "step-finish", "finish"])
  })

  test("a plan becomes reasoning, not visible text", () => {
    const { events } = replay([
      {
        type: "plan",
        entries: [{ content: "Analyser", priority: "high", status: "pending" }],
      },
      say("it is done"),
      { type: "done", stopReason: "end_turn" },
    ])
    expect(types(events)).toEqual([
      "step-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
      "finish",
    ])
    expect(first(events, "reasoning-delta").text).toContain("Analyser")
  })

  test("an ACP tool call is emitted only once, with no tool-result", () => {
    // The real case: ACP sends `tool_call`, then `in_progress`, then `completed`
    // for **one** call. The provider proposes, OpenCode executes - so no
    // `tool-result`, and above all not three `tool-call`s for a single id.
    const tool: AcpEvent = {
      type: "tool",
      id: "call-1",
      name: "read_file",
      title: "Lire README.md",
      kind: "read",
      status: "pending",
      input: { path: "README.md" },
    }
    const { state, events } = replay([
      tool,
      { ...tool, status: "in_progress" },
      { ...tool, status: "completed", output: { bytes: 12 } },
      { type: "done", stopReason: "end_turn" },
    ])
    expect(types(events)).toEqual([
      "step-start",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "step-finish",
      "finish",
    ])
    expect(first(events, "tool-call")).toMatchObject({
      id: "call-1",
      name: "read_file",
      input: { path: "README.md" },
    })
    // `providerExecuted` absent => OpenCode is the one executing.
    expect(first(events, "tool-call").providerExecuted).toBeUndefined()
    expect(state.tools.has("call-1")).toBe(true)
  })

  test("a tool call with no name falls back to the title", () => {
    const { events } = replay([
      {
        type: "tool",
        id: "call-2",
        name: "",
        title: "Write the file",
        kind: "edit",
        status: "pending",
        input: {},
      },
      { type: "done", stopReason: "end_turn" },
    ])
    expect(first(events, "tool-call").name).toBe("Write the file")
  })

  test("an ACP tool call precedes the text rendered at the done", () => {
    // The text is buffered: it can no longer "close" a text block opened by a
    // `tool-input-start`. The order is simply: tool call first (it arrived
    // earlier), text after.
    const { events } = replay([
      say("je regarde"),
      { type: "tool", id: "c", name: "read", title: "Lire", kind: "read", status: "pending", input: {} },
      { type: "done", stopReason: "end_turn" },
    ])
    expect(types(events)).toEqual([
      "step-start",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
      "finish",
    ])
  })

  test("two distinct tool calls give two tool-calls", () => {
    const { events } = replay([
      { type: "tool", id: "a", name: "read", title: "Lire", kind: "read", status: "pending", input: {} },
      { type: "tool", id: "b", name: "bash", title: "ls", kind: "execute", status: "pending", input: {} },
      { type: "done", stopReason: "end_turn" },
    ])
    expect(events.filter((e) => e.type === "tool-call").map((e) => e.id)).toEqual(["a", "b"])
    expect(first(events, "finish").reason.normalized).toBe("tool-calls")
  })

  test.each([
    ["end_turn", "stop"],
    ["max_tokens", "length"],
    ["refusal", "content-filter"],
    ["cancelled", "stop"],
    ["max_turn_requests", "stop"],
  ] as const)("stopReason %s → finishReason %s", (stopReason, expected) => {
    const { events } = replay([say("there you go"), { type: "done", stopReason }])
    expect(first(events, "finish").reason.normalized).toBe(expected)
    expect(first(events, "step-finish").reason.normalized).toBe(expected)
  })

  test('a tool call forces "tool-calls", even with an "end_turn" stopReason', () => {
    // Without that, the OpenCode loop would stop and the proposed tool call
    // would never be executed.
    const { events } = replay([
      {
        type: "tool",
        id: "call-3",
        name: "bash",
        title: "ls",
        kind: "execute",
        status: "pending",
        input: { command: "ls" },
      },
      { type: "done", stopReason: "end_turn" },
    ])
    expect(first(events, "finish").reason.normalized).toBe("tool-calls")
    expect(first(events, "step-finish").reason.normalized).toBe("tool-calls")
  })

  test("an error ends the stream with provider-error, and the following done is ignored", () => {
    // Note: the buffer is **abandoned**. On error, what it holds is truncated
    // JSON, and rendering it would produce a half-eaten transcript, so the
    // agent's error passes alone, as the terminal event.
    const { state, events } = replay([
      raw('{"type":"text","text":"partial'),
      { type: "error", message: "the agent is dead" },
      { type: "done", stopReason: "cancelled" },
    ])
    expect(types(events)).toEqual(["step-start", "step-finish", "provider-error"])
    expect(first(events, "provider-error").message).toBe("the agent is dead")
    // No `finish` **after** the terminal: the core would refuse it.
    expect(indexOfType(events, "finish")).toBe(-1)
    expect(state.terminal).toBe(true)
  })

  test("a turn usage is a Usage instance, and a near-by context changes nothing", () => {
    const { events } = replay([
      { type: "usage", kind: "context", used: 12_345 },
      say("x"),
      {
        type: "usage",
        kind: "turn",
        input: 40,
        output: 2,
        total: 42,
        reasoning: 1,
        cacheRead: 7,
        cacheWrite: 9,
      },
      { type: "done", stopReason: "end_turn" },
    ])
    const usage = first(events, "finish").usage
    // Note: an **instance**, not a plain object - that is the trap.
    expect(usage).toBeInstanceOf(Usage)
    expect(usage?.inputTokens).toBe(40)
    expect(usage?.outputTokens).toBe(2)
    expect(usage?.totalTokens).toBe(42)
    expect(usage?.reasoningTokens).toBe(1)
    expect(usage?.cacheReadInputTokens).toBe(7)
    expect(usage?.cacheWriteInputTokens).toBe(9)
    // `Usage` invariant: nonCached + cacheRead + cacheWrite = input.
    expect(usage?.nonCachedInputTokens).toBe(24)
    // Both `step-finish` and `finish` carry the same usage.
    expect(first(events, "step-finish").usage).toBe(usage)
  })

  test("an empty usage is not invented", () => {
    const { events } = replay([
      { type: "usage", kind: "turn" },
      say("x"),
      { type: "done", stopReason: "end_turn" },
    ])
    expect(first(events, "finish").usage).toBeUndefined()
  })

  test("a computed nonCached never goes below zero", () => {
    const { events } = replay([
      { type: "usage", kind: "turn", input: 10, cacheRead: 8, cacheWrite: 8 },
      { type: "done", stopReason: "end_turn" },
    ])
    expect(first(events, "finish").usage?.nonCachedInputTokens).toBe(0)
  })

  // Note: the figures below are the ones `verify:sessions` measured on
  // `copilot --acp` at turn 6, and they are the whole justification for the
  // threshold: the two modes disagree by a factor of four on `input` while
  // their real context windows differ by 10%.
  describe("the context window contradicts a cumulative counter", () => {
    test("fresh mode: the counter is the turn, and it stays", () => {
      const { events } = replay([
        { type: "usage", kind: "context", used: 27_591 },
        { type: "usage", kind: "turn", input: 26_645, output: 412, total: 27_057, cacheWrite: 26_500 },
        { type: "done", stopReason: "end_turn" },
      ])
      const usage = first(events, "finish").usage
      // 0.97x the window: the gap between "tokens sent" and "tokens reserved",
      // which is why the correction needs a threshold and not a blind override.
      expect(usage?.inputTokens).toBe(26_645)
      expect(usage?.cacheWriteInputTokens).toBe(26_500)
      expect(usage?.nonCachedInputTokens).toBe(145)
    })

    test("reuse mode: the window replaces a counter 4.4x too high", () => {
      const { events } = replay([
        { type: "usage", kind: "context", used: 30_812 },
        {
          type: "usage",
          kind: "turn",
          input: 136_867,
          output: 431,
          total: 137_298,
          cacheRead: 106_805,
          cacheWrite: 29_962,
        },
        { type: "done", stopReason: "end_turn" },
      ])
      const usage = first(events, "finish").usage
      // 30 812 instead of 136 867: the figure OpenCode compares to its
      // `/compact` threshold, and the one it displays as a context window.
      expect(usage?.inputTokens).toBe(30_812)
      // The cached share is rescaled, not dropped: left as it was it would sit
      // above the window it is a part of, and break the invariant.
      const read = usage?.cacheReadInputTokens ?? 0
      const write = usage?.cacheWriteInputTokens ?? 0
      expect(read + write).toBeLessThanOrEqual(30_812)
      expect(usage?.nonCachedInputTokens).toBe(30_812 - read - write)
      // The turn's own cost is untouched: the context event says nothing about
      // what the turn spent.
      expect(usage?.outputTokens).toBe(431)
      expect(usage?.totalTokens).toBe(137_298)
    })

    test("the last context of the turn is the one that counts", () => {
      const { events } = replay([
        { type: "usage", kind: "context", used: 20_000 },
        say("x"),
        { type: "usage", kind: "context", used: 30_812 },
        { type: "usage", kind: "turn", input: 136_867 },
        { type: "done", stopReason: "end_turn" },
      ])
      expect(first(events, "finish").usage?.inputTokens).toBe(30_812)
    })

    test("a silent agent keeps the counter: there is nothing to compare it with", () => {
      const { events } = replay([
        { type: "usage", kind: "turn", input: 136_867, cacheRead: 106_805, cacheWrite: 29_962 },
        { type: "done", stopReason: "end_turn" },
      ])
      const usage = first(events, "finish").usage
      expect(usage?.inputTokens).toBe(136_867)
      expect(usage?.cacheReadInputTokens).toBe(106_805)
      expect(usage?.cacheWriteInputTokens).toBe(29_962)
      expect(usage?.nonCachedInputTokens).toBe(100)
    })

    test("a window above the counter is not a contradiction", () => {
      // The `Usage` invariant is deliberately one-directional: `input` is the
      // precise figure for a turn, and a window reserving more than the turn
      // spent is ordinary. Substituting the larger number would inflate the
      // context OpenCode believes is filled.
      const { events } = replay([
        { type: "usage", kind: "context", used: 200_000 },
        { type: "usage", kind: "turn", input: 30_812, cacheWrite: 12_000 },
        { type: "done", stopReason: "end_turn" },
      ])
      const usage = first(events, "finish").usage
      expect(usage?.inputTokens).toBe(30_812)
      expect(usage?.nonCachedInputTokens).toBe(18_812)
    })

    test("an over-cached agent is rescaled without ever going negative", () => {
      // More cached tokens than sent ones already breaks the invariant on the
      // counter itself; rescaling must not turn that into a negative term.
      const { events } = replay([
        { type: "usage", kind: "context", used: 1_000 },
        { type: "usage", kind: "turn", input: 5_000, cacheRead: 4_000, cacheWrite: 4_000 },
        { type: "done", stopReason: "end_turn" },
      ])
      const usage = first(events, "finish").usage
      const read = usage?.cacheReadInputTokens ?? 0
      const write = usage?.cacheWriteInputTokens ?? 0
      expect(usage?.inputTokens).toBe(1_000)
      expect(usage?.nonCachedInputTokens).toBe(1_000 - read - write)
      expect(usage?.nonCachedInputTokens).toBe(0)
    })

    test("a window that only doubles the counter is not enough to override", () => {
      // Exactly at the ratio: the correction must not fire on the boundary from
      // below, or a single noisy turn would move the context OpenCode believes.
      const { events } = replay([
        { type: "usage", kind: "context", used: 10_000 },
        { type: "usage", kind: "turn", input: 20_000 },
        { type: "done", stopReason: "end_turn" },
      ])
      expect(first(events, "finish").usage?.inputTokens).toBe(20_000)
    })

    test("an empty window is not a context", () => {
      // An agent that announces nothing but zeros would otherwise convince
      // OpenCode the conversation is empty, and `/compact` would never fire.
      const { events } = replay([
        { type: "usage", kind: "context", used: 0 },
        { type: "usage", kind: "turn", input: 90_000 },
        { type: "done", stopReason: "end_turn" },
      ])
      expect(first(events, "finish").usage?.inputTokens).toBe(90_000)
    })
  })

  test("a permission is counted but produces no LLMEvent", () => {
    const { state, events } = replay([
      {
        type: "permission",
        request: {
          sessionId: "s",
          toolCallId: "c",
          title: "Write",
          kind: "edit",
          options: [{ id: "reject", name: "Refuser", kind: "reject_once" }],
        },
        decision: { action: "select", optionId: "reject" },
      },
      { type: "done", stopReason: "cancelled" },
    ])
    expect(state.permissions).toBe(1)
    expect(types(events)).toEqual(["step-start", "step-finish", "finish"])
  })

  test("halt fills in an empty stream", () => {
    // The core's edge case: a stream with not a single event must still produce
    // a terminal event, otherwise "ended unexpectedly".
    expect(types(halt(initialState).events)).toEqual(["step-start", "step-finish", "finish"])
  })

  test("halt closes the open blocks before finishing", () => {
    // Only reasoning can stay open from one `reduce` to the next: the text is
    // buffered, and the reasoning block must be closed before the `step-finish`.
    const { state } = replay([say("a"), { type: "thought", text: "b" }])
    const flushed = halt(state)
    expect(types(flushed.events)).toEqual([
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
      "finish",
    ])
    expect(indexOfType(flushed.events, "reasoning-end")).toBeLessThan(
      indexOfType(flushed.events, "text-start"),
    )
  })

  test("halt shows the buffer when complete, and drops it when truncated", () => {
    // An answer that arrived whole, then a dead stream: it is shown. An answer cut
    // in the middle of the JSON: dropping it beats rendering mangled JSON.
    const complete = replay([say("already done")])
    expect(types(halt(complete.state).events)).toEqual([
      "step-start",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
      "finish",
    ])

    const truncated = replay([raw('{"type":"text","text":"jamais')])
    expect(types(halt(truncated.state).events)).toEqual(["step-start", "step-finish", "finish"])
  })

  test("halt has no effect after a done", () => {
    const { state } = replay([say("a"), { type: "done", stopReason: "end_turn" }])
    expect(halt(state).events).toEqual([])
  })

  test('halt keeps "tool-calls" when a tool was proposed', () => {
    const { state } = replay([
      { type: "tool", id: "c", name: "bash", title: "ls", kind: "execute", status: "pending", input: {} },
    ])
    expect(first(halt(state).events, "finish").reason.normalized).toBe("tool-calls")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 1bis. The core mechanism: the output contract, at the reducer level
// ─────────────────────────────────────────────────────────────────────────────

describe("the core mechanism: the output contract becomes a tool-call", () => {
  test('a conforming "tool" answer becomes a tool-call WITHOUT tool-result', () => {
    // The test that carries the project's value: the agent **proposes**,
    // OpenCode **executes**. Without `providerExecuted` nor `tool-result`, that
    // is exactly what the OpenCode loop does (permissions, snapshots, undo).
    const proposal = JSON.stringify({
      type: "tool",
      name: "read",
      arguments: { filePath: "README.md" },
    })
    const { state, events } = replay([raw(proposal), { type: "done", stopReason: "end_turn" }], withTools("read", "bash"))

    expect(types(events)).toEqual([
      "step-start",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "step-finish",
      "finish",
    ])
    expect(first(events, "tool-call")).toMatchObject({
      name: "read",
      input: { filePath: "README.md" },
    })
    expect(first(events, "tool-call").providerExecuted).toBeUndefined()
    expect(indexOfType(events, "tool-result")).toBe(-1)
    expect(indexOfType(events, "tool-error")).toBe(-1)
    // It is that reason which makes the OpenCode loop continue.
    expect(first(events, "finish").reason.normalized).toBe("tool-calls")
    expect(first(events, "step-finish").reason.normalized).toBe("tool-calls")
    // The call enters the registry: it will not be emitted again.
    expect(state.tools.size).toBe(1)
    expect(first(events, "tool-input-delta").text).toBe('{"filePath":"README.md"}')
  })

  test("two tool requests cannot be rendered in the same turn", () => {
    // The contract forbids sending two, and `parseAgentOutput` only reads the
    // first usable object: the second is silently ignored rather than producing
    // a sequence the core would refuse.
    const both = `{"type":"tool","name":"read","arguments":{}}${JSON.stringify({
      type: "tool",
      name: "bash",
      arguments: {},
    })}`
    const { events } = replay([raw(both), { type: "done", stopReason: "end_turn" }], withTools("read", "bash"))
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(1)
    expect(first(events, "tool-call").name).toBe("read")
  })

  test("a tool missing from the catalogue fails naming the tool and the accepted names", () => {
    // Never a silent degradation into text: the user must see that the requested
    // work is lost, not believe the agent answered normally.
    const { events } = replay(
      [raw('{"type":"tool","name":"shell","arguments":{}}'), { type: "done", stopReason: "end_turn" }],
      withTools("read", "bash"),
    )
    expect(types(events)).toEqual(["step-start", "step-finish", "provider-error"])
    const message = first(events, "provider-error").message
    expect(message).toContain("shell")
    expect(message).toContain("read, bash")
    // Never a `finish` behind a terminal event.
    expect(indexOfType(events, "finish")).toBe(-1)
  })

  test.each([
    ["plain prose", "Hello, I can help you."],
    ["invalid JSON", '{"type":"text","text":'],
    ["an unknown type", '{"type":"response","text":"hello"}'],
    ["an empty text", '{"type":"text","text":""}'],
  ])("%s finit en provider-error, jamais en troncature", (_label, output) => {
    const { events } = replay([raw(output), { type: "done", stopReason: "end_turn" }], withTools("read"))
    expect(types(events)).toEqual(["step-start", "step-finish", "provider-error"])
    // The message carries an excerpt of the output: the only thing that makes it
    // possible to understand *what* the agent got wrong.
    expect(first(events, "provider-error").message.length).toBeGreaterThan(20)
  })

  test("an object escaped in a ``` block stays readable", () => {
    // The extraction's tolerance does not stop at the first `{`: a brace inside
    // a string closes nothing, otherwise the agent's text would be cut.
    const output = 'Here: ```json\n{"type":"text","text":"here is {a} brace"}\n```'
    const { events } = replay([raw(output), { type: "done", stopReason: "end_turn" }], withTools("read"))
    expect(first(events, "text-delta").text).toBe("here is {a} brace")
  })

  test("`arguments` that are not an object are refused, not swallowed", () => {
    for (const arguments_ of ['"read"', "[1,2]", "42", "null"]) {
      const { events } = replay(
        [raw(`{"type":"tool","name":"read","arguments":${arguments_}}`), { type: "done", stopReason: "end_turn" }],
        withTools("read"),
      )
      expect(types(events)).toEqual(["step-start", "step-finish", "provider-error"])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. The settings
// ─────────────────────────────────────────────────────────────────────────────

describe("provider settings", () => {
  test("a minimal configuration is accepted", () => {
    const parsed = parseSettings({ command: "copilot", args: ["--acp"] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.command).toBe("copilot")
    expect(parsed.value.args).toEqual(["--acp"])
    expect(parsed.value.cwd).toBeUndefined()
  })

  test("command is mandatory, and the message names the field", () => {
    const parsed = parseSettings({ args: ["--acp"] })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain("settings.command")
  })

  test.each([
    [{ command: "copilot", args: "--acp" }, "settings.args"],
    [{ command: "copilot", args: [1] }, "settings.args"],
    [{ command: "copilot", cwd: 12 }, "settings.cwd"],
    [{ command: "copilot", env: { A: 1 } }, "settings.env.A"],
    [{ command: "copilot", stderr: "verbose" }, "settings.stderr"],
    [{ command: "copilot", session: "keep" }, "settings.session"],
    [{ command: "copilot", allowedTools: "bash" }, "settings.allowedTools"],
    ["copilot", "settings must be a JSON object"],
  ])("refuse %o", (input, fragment) => {
    const parsed = parseSettings(input)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain(fragment)
  })

  test("an unknown key is ignored, not rejected", () => {
    // OpenCode may add its own keys: bringing the provider down for that would
    // be worse than ignoring a key.
    const parsed = parseSettings({ command: "copilot", baseURL: "https://exemple" })
    expect(parsed.ok).toBe(true)
  })

  test("the process key includes the policy, otherwise two providers contaminate each other", () => {
    const strict = fakeSettings()
    const loose = fakeSettings({ FAKE_BOOLEAN_OPTION: "1" })
    // `env` changes the key: two different fake agents, two processes.
    expect(agentKey(strict)).not.toBe(agentKey(loose))
    const withTools = parseSettings({ command: "copilot", allowedTools: ["*"] })
    const without = parseSettings({ command: "copilot" })
    if (!withTools.ok || !without.ok) throw new Error("parseSettings failed")
    // `allowedTools` changes the **ACP client policy**: a difference that must
    // yield two distinct agents.
    expect(agentKey(withTools.value)).not.toBe(agentKey(without.value))
  })
  test("the process key includes the provider id, otherwise two agents share a session", () => {
    // The credentials are per agent. Two providers configured with the same
    // command would otherwise share one process - hence one authentication
    // session, and one pool of ACP sessions: the second provider's first turn
    // could be handed a session the first one had filled.
    const first = fakeSettings({}, { provider: "acp-copilot" })
    const second = fakeSettings({}, { provider: "acp-codex" })
    expect(agentKey(first)).not.toBe(agentKey(second))
    // And the default id is not a key of its own: a hand-written
    // `providers.acp.settings` and the published one must land on the same agent.
    const anonymous = fakeSettings()
    const explicit = fakeSettings({}, { provider: "acp" })
    expect(agentKey(anonymous)).toBe(agentKey(explicit))
  })

  test("an empty `provider` is refused: the id names the provider in every error", () => {
    const parsed = parseSettings({ command: "copilot", provider: "  " })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain("settings.provider")
  })

  test("the route declares the configured provider, one agent after another", () => {
    // `Route.make`'s `provider` is the id OpenCode sees on the `LanguageModel`.
    // Freezing it would make `acp-copilot/x` and `acp-codex/x` the same model.
    for (const id of ["acp-copilot", "acp-codex"]) {
      const languageModel = model("claude-sonnet-5", fakeSettings({}, { provider: id }))
      expect({ id, provider: String(languageModel.provider) }).toEqual({ id, provider: id })
    }
    // Absent, it is the default: the configuration written before several
    // agents were possible keeps working untouched.
    expect(String(model("claude-sonnet-5", fakeSettings()).provider)).toBe("acp")
  })

  test("a rejected configuration is still named after its provider", () => {
    // `parseSettings` fails before the identity could be read from its result,
    // so the raw settings are the only place left to find it - and the message
    // the user reads has to say which of his two providers is misconfigured.
    try {
      model("x", { provider: "acp-codex" })
      throw new Error("should have thrown")
    } catch (error) {
      if (!(error instanceof ProviderConfigurationError)) throw error
      expect(String(error.provider)).toBe("acp-codex")
      expect(error.message).toContain("settings.command")
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. End to end against the fake agent
// ─────────────────────────────────────────────────────────────────────────────

/** Builds a realistic `LLMRequest`: system, tools, transcript. */
const buildRequest = (languageModel: LanguageModel, userText: string): LLMRequest =>
  new LLMRequest({
    model: languageModel,
    system: [
      SystemPart.make("You are an assistant."),
      SystemPart.make("Answer in English."),
    ],
    tools: [
      ToolEntry.make({
        name: "read",
        description: "Reads a project file",
        inputSchema: {
          type: "object",
          properties: { filePath: { type: "string" } },
          required: ["filePath"],
        },
      }),
    ],
    messages: [
      Message.user(userText),
      Message.assistant([
        ToolCallPart.make({ id: "call-9", name: "read", input: { filePath: "README.md" } }),
      ]),
      Message.tool(
        ToolResultPart.make({
          id: "call-9",
          name: "read",
          result: { type: "content", value: [{ type: "text", text: "# README" }] },
        }),
      ),
    ],
    generation: GenerationOptions.make({ maxTokens: 512 }),
  })

/**
 * Runs a request end to end and returns the `LLMEvent`s **without** an
 * initialisation failure, exactly as OpenCode's core does.
 */
const runTurn = async (
  settings: AcpProviderSettings,
  modelID: string,
  request: LLMRequest,
): Promise<LLMEvent[]> => {
  const languageModel = model(modelID, settings)
  // `@opencode/ai` types `LanguageModel.route` as `AnyRoute`: that is the erased
  // view it exposes, so `body`/`prepared` are opaque at this level. The same
  // path as `compileRequest` is taken: `body.from`, then `prepareTransport`,
  // then `streamPrepared`.
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
  if (Result.isFailure(outcome)) {
    throw new Error(`the stream failed: ${outcome.failure.message}`)
  }
  return outcome.success
}

describe("end to end: the real route against the ACP agent", () => {
  test("a text turn produces the expected sequence", async () => {
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    // `PING` makes the fake agent answer, obeying the contract: a single `text`
    // carrying the JSON object, decoded into one `text-delta` at the `done`.
    const request = buildRequest(languageModel, "PING")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    expect(types(events)).toEqual([
      "step-start",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
      "finish",
    ])
    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual(["PONG"])
    expect(first(events, "finish").reason.normalized).toBe("stop")
  })

  test("the prompt holds the system, the tool catalogue and the transcript", async () => {
    // The fake agent returns the prompt **it received** in its single text
    // chunk: the only way to check `fromRequest` end to end.
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    // No fake-agent keyword: it takes its default branch, which "echoes" the
    // prompt.
    const request = buildRequest(languageModel, "hello")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    const echoed = events
      .filter((e) => e.type === "text-delta")
      .map((e) => e.text)
      .join("")
    const expected = renderRequest({
      system: ["You are an assistant.", "Answer in English."],
      tools: [
        {
          name: "read",
          description: "Reads a project file",
          schema: {
            type: "object",
            properties: { filePath: { type: "string" } },
            required: ["filePath"],
          },
        },
      ],
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: `Tool call read : {"filePath":"README.md"}` },
        { role: "tool", id: "call-9", name: "read", output: "# README" },
      ],
      maxOutputTokens: 512,
    })
    expect(echoed).toBe(`ACK: ${expected}`)
  })

  test("a tool call becomes a tool-call WITHOUT tool-result, and ends in tool-calls", async () => {
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "TOOL")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    // The fake agent emits `tool_call`, `in_progress` **then** `completed`: the
    // reducer makes a single `tool-call` out of them, with no `tool-result`.
    expect(types(events)).toEqual([
      "step-start",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
      "finish",
    ])
    expect(first(events, "tool-call")).toMatchObject({
      id: "call-tool-1",
      name: "read_file",
      input: { path: "README.md" },
    })
    expect(first(events, "tool-call").providerExecuted).toBeUndefined()
    expect(indexOfType(events, "tool-result")).toBe(-1)
    expect(indexOfType(events, "tool-error")).toBe(-1)
    // That is what makes the OpenCode loop continue.
    expect(first(events, "finish").reason.normalized).toBe("tool-calls")
  })

  test('a conforming "tool" answer becomes a tool-call WITHOUT tool-result, and ends in tool-calls', async () => {
    // Note: **the test that carries the value of this mechanism.** The fake agent
    // produces `core/prompt.ts`'s output contract - a single JSON `text` - and the
    // reducer turns it into a `tool-call` that **OpenCode** will execute. That is
    // the whole mechanism: prompt -> parse -> `LLMEvent` -> OpenCode loop.
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "TOOL_PROPOSAL")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    expect(types(events)).toEqual([
      "step-start",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "step-finish",
      "finish",
    ])
    // The name comes from the **catalogue transmitted in the prompt** (here
    // `read`), never from an ACP tool name: that removes any mapping problem.
    expect(first(events, "tool-call")).toMatchObject({
      name: "read",
      input: { filePath: "README.md" },
    })
    expect(first(events, "tool-call").providerExecuted).toBeUndefined()
    expect(indexOfType(events, "tool-result")).toBe(-1)
    expect(indexOfType(events, "tool-error")).toBe(-1)
    expect(first(events, "finish").reason.normalized).toBe("tool-calls")
  })

  test("an agent answering in raw prose fails as provider-error, with no truncation", async () => {
    // `FAKE_OUTPUT=raw`: the agent ignores the contract. That is the case a
    // third-party agent produces, and it must above all not look like a
    // truncation.
    const settings = fakeSettings({ FAKE_OUTPUT: "raw" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "hello")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    expect(types(events)).toEqual(["step-start", "step-finish", "provider-error"])
    expect(first(events, "provider-error").message).toContain("hello")
    expect(indexOfType(events, "finish")).toBe(-1)
  })

  test("a hallucinated tool fails naming the transmitted catalogue", async () => {
    // `FAKE_OUTPUT=hallucinated`: the agent proposes a tool that does not exist.
    // The message must name the tool **and** the accepted names, otherwise the
    // user can do nothing with the turn.
    const settings = fakeSettings({ FAKE_OUTPUT: "hallucinated" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "hello")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    const message = first(events, "provider-error").message
    expect(message).toContain("outil_qui_nexiste_pas")
    expect(message).toContain("read")
    expect(types(events)).toEqual(["step-start", "step-finish", "provider-error"])
  })

  test("an answer fenced in a ``` block is accepted", async () => {
    // `FAKE_OUTPUT=fenced`: many agents bury their JSON in a markdown block.
    // `parseAgentOutput`'s tolerance must absorb that.
    const settings = fakeSettings({ FAKE_OUTPUT: "fenced" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "PING")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual(["PONG"])
  })

  test("the turn usage is an instance of the Usage class", async () => {
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "PING")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    const usage = first(events, "finish").usage
    expect(usage).toBeInstanceOf(Usage)
    // Capture from the fake agent (`USAGE` in `fake-acp.ts`).
    expect(usage?.inputTokens).toBe(40)
    expect(usage?.outputTokens).toBe(2)
    expect(usage?.totalTokens).toBe(42)
    expect(usage?.reasoningTokens).toBe(1)
    expect(usage?.cacheReadInputTokens).toBe(7)
    expect(usage?.cacheWriteInputTokens).toBe(9)
    expect(usage?.nonCachedInputTokens).toBe(24)
  })

  test("a cumulative counter is replaced by the context window the agent announced", async () => {
    // `FAKE_CUMULATIVE_USAGE` makes the fake account for the turn the way a
    // resumed session does - session cache, not turn - while `FAKE_EMIT_USAGE_UPDATE`
    // has it announce its real window. Only the whole chain proves the two reach
    // the same reducer: the reducer tests give the events directly.
    const settings = fakeSettings({ FAKE_CUMULATIVE_USAGE: "1", FAKE_EMIT_USAGE_UPDATE: "1" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "PING")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    const usage = first(events, "finish").usage
    expect(usage?.inputTokens).toBe(12_345)
    const read = usage?.cacheReadInputTokens ?? 0
    const write = usage?.cacheWriteInputTokens ?? 0
    // The turn's own cost is untouched, and the split still adds up.
    expect(usage?.outputTokens).toBe(2)
    expect(usage?.nonCachedInputTokens).toBe(12_345 - read - write)
    expect(usage?.nonCachedInputTokens).toBeGreaterThan(0)
  })

  test("a cumulative counter is forwarded as-is when the agent is silent", async () => {
    // No `usage_update`: there is nothing to compare the counter with, and
    // forwarding it is the only honest thing left.
    const settings = fakeSettings({ FAKE_CUMULATIVE_USAGE: "1" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "PING")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    expect(first(events, "finish").usage?.inputTokens).toBe(136_867)
  })

  test("an interrupted stream does not hang and emits no orphan finish", async () => {
    // `TICK`: an immediate `thought`, then a long interruptible latency.
    // Reasoning is what still streams live (the text is buffered until the
    // `done`), so it is what we wait for. Only the first events are taken: the
    // request's `Scope` closes, the session closes, the agent receives
    // `session/cancel`.
    const settings = fakeSettings({ FAKE_SLOW_MS: "30000" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "TICK")

    const started = Date.now()
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const route = languageModel.route
          const body = yield* route.body.from(request)
          const prepared: AcpPrepared = yield* route.prepareTransport(body, request)
          return yield* Stream.runCollect(
            route.streamPrepared(prepared, request, NO_HTTP).pipe(Stream.take(2)),
          )
        }),
      ).pipe(Effect.result),
    )
    const elapsed = Date.now() - started

    expect(Result.isSuccess(outcome)).toBe(true)
    if (Result.isFailure(outcome)) return
    // 30 s of agent-side latency: if cancellation did not work, this test would
    // take 30 s.
    expect(elapsed).toBeLessThan(10_000)
    const seen = outcome.success.map((event) => event.type)
    expect(seen).toEqual(["step-start", "reasoning-start"])
    // No terminal event, so above all **no** `finish` without `step-finish`:
    // that would be exactly the truncation the core reports as "The provider
    // response ended unexpectedly.".
    expect(indexOfType(outcome.success, "finish")).toBe(-1)
  })

  test("an agent dying mid-turn ends in provider-error, not in a truncation", async () => {
    const settings = fakeSettings({ FAKE_DIE_ON_PROMPT: "1" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "DIE")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    expect(first(events, "provider-error").message).toBeTruthy()
    expect(indexOfType(events, "finish")).toBe(-1)
    // A `step-finish` **before** the terminal: that is what stops the core from
    // reading a truncation.
    expect(indexOfType(events, "step-finish")).toBeLessThan(indexOfType(events, "provider-error"))
  })

  test("the effort variant is applied before the prompt, after the model", async () => {
    // `effort` comes from a `Model.Info` variant: the plugin publishes
    // `{ effort: "high" }`, OpenCode merges it into the settings, and the adapter
    // must translate it into `set_config_option("reasoning_effort")`. Without
    // this test that wiring could disappear without any failure:
    // `set_config_option` is a JSON-RPC round trip with no counterpart.
    const settings = fakeSettings({ FAKE_ECHO_CONFIG: "1" }, { effort: "high" })
    const languageModel = model("claude-sonnet-5", settings)
    const request = buildRequest(languageModel, "PING")

    const events = await runTurn(settings, "claude-sonnet-5", request)

    // The fake agent answers with what it **applied**: both options were
    // therefore taken into account, in order.
    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual([
      "PONG claude-sonnet-5 high",
    ])
  })

  test("the effort is applied by the agent's real option id, not by its category", async () => {
    // The regression this pins: a `ConfigOption` carries a **category**
    // (`thought_level`) and an `id` (`reasoning_effort` on copilot, `effort` on
    // `opencode acp`), and only the `id` is a valid `configId` - no measured
    // agent accepts its own category. The fake refuses an unknown `configId`
    // like the real ones, so a category reaching the wire fails this test
    // instead of being silently ignored.
    const settings = fakeSettings({ FAKE_ECHO_CONFIG: "1", FAKE_EFFORT_ID: "effort" }, { effort: "high" })
    const languageModel = model("claude-sonnet-5", settings)
    const request = buildRequest(languageModel, "PING")

    const events = await runTurn(settings, "claude-sonnet-5", request)

    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual([
      "PONG claude-sonnet-5 high",
    ])
  })

  test("an agent that publishes no `permissions` category still works", async () => {
    // `opencode acp` has none. The default policy pins permissions to `off`
    // where the agent offers them, and must simply have nothing to do otherwise.
    const settings = fakeSettings({ FAKE_ECHO_CONFIG: "1", FAKE_NO_PERMISSIONS: "1" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "PING")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual([
      "PONG gpt-5.6-terra medium",
    ])
  })

  test("without a variant, the agent keeps the value it announces itself", async () => {
    const settings = fakeSettings({ FAKE_ECHO_CONFIG: "1" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "PING")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual([
      "PONG gpt-5.6-terra medium",
    ])
  })

  test("an effort outside the list fails naming the accepted values", async () => {
    // An effort can be valid for the current model and invalid for another
    // (`none` does not exist for `claude-sonnet-5` on `copilot --acp`), so it
    // fails by naming the list rather than letting the agent silently refuse a
    // value.
    const settings = fakeSettings({}, { effort: "absent" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "PING")

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const route = languageModel.route
          const body = yield* route.body.from(request)
          const prepared: AcpPrepared = yield* route.prepareTransport(body, request)
          return yield* Stream.runCollect(route.streamPrepared(prepared, request, NO_HTTP))
        }),
      ).pipe(Effect.result),
    )

    expect(Result.isFailure(outcome)).toBe(true)
    if (Result.isSuccess(outcome)) return
    expect(outcome.failure.message).toContain("absent")
    expect(outcome.failure.message).toContain("none, medium, high")
    // The message names the requested **thing**: 'model "absent"' would be
    // unreadable.
    expect(outcome.failure.message).toContain("the effort level")
  })

  test("a model the agent does not offer fails naming the accepted values", async () => {
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "PING")
    // The request is built with one model, then another is asked for: it is
    // `execute` that applies the request's model (`set_config_option`).
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const route = languageModel.route
          const body = yield* route.body.from(request)
          const prepared: AcpPrepared = yield* route.prepareTransport(body, request)
          const bogus = { ...prepared, model: "not-a-model" }
          return yield* Stream.runCollect(route.streamPrepared(bogus, request, NO_HTTP))
        }),
      ).pipe(Effect.result),
    )
    expect(Result.isFailure(outcome)).toBe(true)
    if (Result.isSuccess(outcome)) return
    expect(outcome.failure.message).toContain("not-a-model")
    expect(outcome.failure.message).toContain("gpt-5.6-terra")
  })

  test("a message-less request is refused before any spawn", async () => {
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    const empty = new LLMRequest({ model: languageModel, system: [], messages: [], tools: [] })
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const route = languageModel.route
          const body = yield* route.body.from(empty)
          const prepared: AcpPrepared = yield* route.prepareTransport(body, empty)
          return yield* Stream.runCollect(route.streamPrepared(prepared, empty, NO_HTTP))
        }),
      ).pipe(Effect.result),
    )
    expect(Result.isFailure(outcome)).toBe(true)
    if (Result.isSuccess(outcome)) return
    expect(outcome.failure.message).toContain("without a single message")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. The provider package contract
// ─────────────────────────────────────────────────────────────────────────────
describe("provider package contract", () => {
  test("model(id, settings) returns a LanguageModel attached to the route", () => {
    const languageModel = model("claude-sonnet-5", fakeSettings())
    expect(String(languageModel.id)).toBe("claude-sonnet-5")
    expect(String(languageModel.provider)).toBe("acp")
    expect(languageModel.route.id).toBe("acp-stdio")
    expect(languageModel.route.protocol).toBe("acp")
    expect(languageModel.route.transport.id).toBe("acp-stdio/transport")
  })

  test("invalid settings throw a ProviderConfigurationError, not an AIError", () => {
    // `@opencode/ai`'s contract: a configuration error is thrown **before** any
    // request, never in the middle of a stream.
    expect(() => model("x", { args: ["--acp"] })).toThrow(ProviderConfigurationError)
    try {
      model("x", { args: ["--acp"] })
      throw new Error("should have thrown")
    } catch (error) {
      if (!(error instanceof ProviderConfigurationError)) throw error
      expect(error.message).toContain("settings.command")
    }
  })

  test("the process is shared between two requests with the same settings", async () => {
    const settings = fakeSettings()
    // Without that cache, every turn of a conversation would restart an
    // `initialize`.
    expect(acquireAgent(settings)).toBe(acquireAgent(settings))
  })

  test("`@opencode/ai` is aligned with the version the host embeds", async () => {
    // Note: **the double-instance risk.** Our provider builds a `LanguageModel`
    // and a `Usage` with **our** instance of `@opencode/ai`; the host reads them
    // with **its own**. Two distinct instances mean two different `Usage`
    // classes - hence a false `instanceof` host-side, and the failure mode
    // described above ("The provider response ended unexpectedly."),
    // indistinguishable from a truncation.
    //
    // The reference is not the project's `package.json` (which could lie): it is
    // the dependency declared by `@opencode/plugin`, that is, the package the
    // OpenCode server provides at load time.
    const read = async (relative: string): Promise<Record<string, unknown>> => {
      const path = fileURLToPath(new URL(relative, import.meta.url))
      return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    }
    const asRecord = (value: unknown): Record<string, unknown> =>
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

    const ours = await read("../node_modules/@opencode/ai/package.json")
    const plugin = await read("../node_modules/@opencode/plugin/package.json")
    const hostDeps = asRecord(plugin["dependencies"])

    expect(ours["version"]).toBe("2.0.16")
    expect(hostDeps["@opencode/ai"]).toBe(ours["version"])
    // `@opencode/schema` must follow: that is where `LLMEvent` and `Usage` come
    // from, and both packages are resolved through the same path.
    const schema = await read("../node_modules/@opencode/schema/package.json")
    expect(schema["version"]).toBe(hostDeps["@opencode/schema"])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. The core's portability invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("invariant: the core imports nothing from the host", () => {
  // This is the first phase to introduce `@opencode/ai` and `effect` into the
  // repository, and therefore the phase where it would be most tempting to use
  // them as a shortcut in `core/` ("just a type"). This test is the only thing
  // preventing that, and it costs three lines.
  test("core/ imports neither @opencode/ai, nor effect, nor the ACP SDK", async () => {
    const directory = fileURLToPath(new URL("../src/core/", import.meta.url))
    const files = [...new Bun.Glob("*.ts").scanSync(directory)]
    expect(files.length).toBeGreaterThan(0)
    const forbidden = /from\s+"(effect|@opencode\/ai|@opencode\/schema|@agentclientprotocol\/sdk)[^"]*"/
    for (const file of files) {
      const source = await Bun.file(`${directory}/${file}`).text()
      expect({ file, match: source.match(forbidden)?.[0] ?? null }).toEqual({
        file,
        match: null,
      })
    }
  })
})
