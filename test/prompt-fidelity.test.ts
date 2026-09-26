/**
 * Fidelity of the prompt reconstruction.
 *
 * A real run reports `tokens=2/24` where the agent, called directly, declares
 * ~15 000 input tokens. Two explanations are possible: "the agent only counts
 * what is not cached" (benign) **or** "our `LLMRequest` reconstruction loses the
 * system prompt, the tools or the transcript" (a serious bug, invisible on a
 * short answer).
 *
 * **Verdict, measured on `copilot --acp` v1.0.88**: no loss. The real capture is
 * `input=25811 cacheWrite=25809 nonCached=2` with a minimal prompt, and
 * `input=36002 cacheWrite=22434 nonCached=2` with ~4 000 more tokens in the
 * system: `input` **grows** by exactly what is added to the prompt, and the `2`
 * does not move. So it is `2` that OpenCode displays as input - the rest is
 * `cacheWrite`, which the agent pays once and which OpenCode does not count as
 * the turn's input tokens. See the `usage` describe below, which locks that
 * decoding down.
 *
 * This file does not rest on reasoning: it brings the **proof**.
 *
 * 1. `renderRequest` is **pure**: its result can be compared character by
 *    character, with no agent. That is what proves the order, the uniqueness and
 *    the absence of truncation.
 * 2. `FAKE_PROMPT_FILE` makes the fake agent deposit the prompt **exactly as it
 *    received it on the wire**. A realistic `LLMRequest` is replayed - a
 *    multi-part system prompt, three tools with JSON schemas, a transcript with
 *    a tool call and its result - and what reached the agent is checked to be
 *    exactly what `fromRequest` + `renderRequest` produced. Nothing more,
 *    nothing less.
 *
 * Note: why not settle for the fake agent's "ACK: <prompt>" echo, already
 * covered elsewhere. That echo goes through the **output contract** and its
 * tolerant extractor: a prompt truncated in the middle of a brace would still
 * be "valid" on the extraction side, and the test would pass on a real
 * regression. Here the comparison is at the byte level, before any
 * interpretation.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Effect, Result, Stream } from "effect"
import {
  GenerationOptions,
  LLMRequest,
  Message,
  SystemPart,
  ToolCallPart,
  ToolEntry,
  ToolNamespace,
  ToolResultPart,
} from "@opencode/ai/schema/index"
import type { LanguageModel, LLMEvent } from "@opencode/ai/schema/index"

import { fromRequest, halt, initialState, reduce } from "../src/adapters/opencode-protocol.js"
import { closeCachedAgents } from "../src/adapters/opencode-transport.js"
import type { AcpPrepared } from "../src/adapters/opencode-transport.js"
import type { NormalizedMessage, NormalizedRequest, NormalizedTool } from "../src/core/types.js"
import { renderRequest } from "../src/core/prompt.js"
import { model } from "../src/index.js"
import { parseSettings } from "../src/settings.js"
import type { AcpProviderSettings } from "../src/settings.js"

const FAKE = fileURLToPath(new URL("./fake-acp.ts", import.meta.url))

/** Must stay in sync with `PROMPT_SEPARATOR` in `test/fake-acp.ts`. */
const SEPARATOR = "-----8<-- PROMPT RECEIVED --8<-----"

afterAll(async () => {
  await closeCachedAgents()
})

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** The ACP transport never does HTTP: the executor must therefore die loudly. */
const NO_HTTP = { http: { execute: () => Effect.die("the ACP transport does no HTTP") } }

/** The fake agent's settings; fails loudly if the validation goes wrong. */
function fakeSettings(env: Record<string, string> = {}): AcpProviderSettings {
  const parsed = parseSettings({
    command: process.execPath,
    args: ["run", FAKE],
    cwd: process.cwd(),
    stderr: "ignore",
    env,
  })
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.value
}

/** Number of **non-overlapping** occurrences of `needle` in `haystack`. */
const countOf = (haystack: string, needle: string): number => {
  if (needle === "") return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

/** Index of the first occurrence, or an error naming the missing excerpt. */
const indexOfOrFail = (prompt: string, needle: string, what: string): number => {
  const at = prompt.indexOf(needle)
  if (at === -1) {
    throw new Error(`${what} is absent from the prompt: ${JSON.stringify(needle)}`)
  }
  return at
}

// ─────────────────────────────────────────────────────────────────────────────
// The reference dataset
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Three tools with deliberately different shapes.
 *
 * Note: an `enum` in the second and a nested object in the third: those are the
 * two shapes whose serialisation breaks most easily (a badly closed `enum`, an
 * `undefined` key dropped by `JSON.stringify`), hence the first two things to
 * check.
 */
const TOOLS: readonly NormalizedTool[] = [
  {
    name: "read",
    description: "Reads a project file",
    schema: {
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
    },
  },
  {
    name: "grep",
    description: "Searches for a pattern in the repository",
    schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        glob: { type: "string" },
        mode: { type: "string", enum: ["content", "files", "commit"] },
      },
      required: ["pattern"],
    },
  },
  {
    name: "edit",
    description: "Replaces a chunk of a file",
    schema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { oldString: { type: "string" }, newString: { type: "string" } },
            required: ["oldString", "newString"],
          },
        },
      },
      required: ["filePath", "edits"],
    },
  },
]

/** The same three tools as `ToolEntry`: the shape the adapter receives. */
const TOOL_ENTRIES = [
  ToolEntry.make({
    name: "read",
    description: "Reads a project file",
    inputSchema: TOOLS[0]?.schema as Record<string, unknown>,
  }),
  ToolEntry.make({
    name: "grep",
    description: "Searches for a pattern in the repository",
    inputSchema: TOOLS[1]?.schema as Record<string, unknown>,
  }),
  ToolEntry.make({
    name: "edit",
    description: "Replaces a chunk of a file",
    inputSchema: TOOLS[2]?.schema as Record<string, unknown>,
  }),
]

/** The system parts, deliberately **multiple**: OpenCode's real case. */
const SYSTEM_PARTS = [
  "You are a programming assistant.",
  "AGENTS.md: a generated file is never modified.",
  "Answer in English, without preamble.",
]

/** The reference transcript: a tool call, its result, then a follow-up. */
const MESSAGES: readonly NormalizedMessage[] = [
  { role: "user", text: "review the file config.json" },
  { role: "assistant", text: 'Tool call read : {"filePath":"config.json"}' },
  { role: "tool", id: "call-1", name: "read", output: '{ "port": 4096 }' },
  { role: "user", text: "and the port?" },
]

/**
 * The reference normalised request.
 *
 * Note: it is written **by hand**, independently of `fromRequest`: that is what
 * gives the character equality below all its meaning. If the adapter invents,
 * loses or moves anything, the equality fails - and the failure names the
 * section concerned.
 */
const NORMALIZED: NormalizedRequest = {
  system: SYSTEM_PARTS,
  tools: TOOLS,
  messages: MESSAGES,
  maxOutputTokens: 512,
}

/** Builds the realistic `LLMRequest` used as the reference. */
const buildRequest = (languageModel: LanguageModel, tools: LLMRequest["tools"] = TOOL_ENTRIES): LLMRequest =>
  new LLMRequest({
    model: languageModel,
    system: SYSTEM_PARTS.map((text) => SystemPart.make(text)),
    tools: [...tools],
    messages: [
      Message.user("review the file config.json"),
      Message.assistant([
        ToolCallPart.make({ id: "call-1", name: "read", input: { filePath: "config.json" } }),
      ]),
      Message.tool(
        ToolResultPart.make({
          id: "call-1",
          name: "read",
          result: { type: "content", value: [{ type: "text", text: '{ "port": 4096 }' }] },
        }),
      ),
      Message.user("and the port?"),
    ],
    generation: GenerationOptions.make({ maxTokens: 512 }),
  })

/**
 * The normalised request produced by the adapter, without going through the
 * network.
 *
 * Note: the `LanguageModel` is **not** a parameter. `fromRequest` only needs the
 * request, and binding it here would make every call needlessly depend on a
 * route built for the occasion.
 */
const normalizedOf = (request: LLMRequest): NormalizedRequest =>
  Effect.runSync(fromRequest(request, fakeSettings())).request

// ─────────────────────────────────────────────────────────────────────────────
// The rendering invariants
// ─────────────────────────────────────────────────────────────────────────────

/** The five expected sections, in this order. */
const SECTION_ORDER = [
  "## Role",
  "## System instructions",
  "## Available tools",
  "## Conversation",
  "## Output format - mandatory",
] as const

/** The contract's last line: the prompt must end with it. */
const LAST_RULE =
  "- Do not call any native tool: you have none, and any attempt would be rejected."

/**
 * The rendering invariants, applied to any prompt.
 *
 * **Pure** function: that is what lets it run on the local rendering as well as
 * on the prompt the agent actually received. A regression losing the system
 * prompt, duplicating a tool or truncating the end fails here.
 */
const assertIntact = (prompt: string): void => {
  // 1. The five sections are present, once each, **in order**.
  const positions = SECTION_ORDER.map((header) =>
    indexOfOrFail(prompt, header, `the section "${header}"`),
  )
  for (let i = 1; i < positions.length; i += 1) {
    const previous = positions[i - 1] ?? 0
    const current = positions[i] ?? 0
    if (current <= previous) {
      throw new Error(
        `section order broken: "${SECTION_ORDER[i - 1]}" before "${SECTION_ORDER[i]}"`,
      )
    }
  }
  for (const header of SECTION_ORDER) {
    expect(countOf(prompt, header)).toBe(1)
  }

  // 2. Every system part is there, **once**, in the request's order.
  let previous = -1
  for (const part of SYSTEM_PARTS) {
    const at = indexOfOrFail(prompt, part, "a system part")
    if (at <= previous) throw new Error(`system part out of order: ${part}`)
    previous = at
    expect(countOf(prompt, part)).toBe(1)
  }

  // 3. Every tool is there with its **serialised schema** - the proof that no
  //    tool was reduced to its name, nor to a fallback `{}`.
  const toolsAt = positions[2] ?? 0
  const conversationAt = positions[3] ?? Number.MAX_SAFE_INTEGER
  for (const tool of TOOLS) {
    const heading = indexOfOrFail(prompt, `### ${tool.name}\n`, `the tool "${tool.name}"`)
    expect(countOf(prompt, `### ${tool.name}\n`)).toBe(1)
    expect(heading).toBeGreaterThan(toolsAt)
    expect(heading).toBeLessThan(conversationAt)
    expect(prompt).toContain(tool.description)
    const schema = JSON.stringify(tool.schema)
    expect(prompt).toContain(schema)
    // The schema is rendered **exactly once**: neither lost nor duplicated.
    expect(countOf(prompt, schema)).toBe(1)
  }

  // 4. Every message is there with its role, once, in order.
  const lines: readonly string[] = [
    "User : review the file config.json",
    'Assistant : Tool call read : {"filePath":"config.json"}',
    'Tool read : { "port": 4096 }',
    "User : and the port?",
  ]
  previous = -1
  for (const line of lines) {
    const at = indexOfOrFail(prompt, line, "a transcript message")
    if (at <= previous) throw new Error(`message out of order: ${line}`)
    previous = at
    expect(countOf(prompt, line)).toBe(1)
  }

  // 5. Nothing is truncated: the output contract **closes** the prompt, and its
  //    last line really is the prompt's last line.
  expect(prompt.endsWith(LAST_RULE)).toBe(true)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The pure rendering
// ─────────────────────────────────────────────────────────────────────────────

describe("renderRequest: nothing lost, nothing duplicated", () => {
  const prompt = renderRequest(NORMALIZED)

  test("system, tools, transcript and contract are intact and ordered", () => {
    assertIntact(prompt)
  })

  test("the rendering is deterministic", () => {
    // A pure function makes the test reproducible: two renderings of the same
    // request are identical, character for character.
    expect(renderRequest(NORMALIZED)).toBe(prompt)
  })

  test("a tool without a schema invents no JSON", () => {
    // The fallback must stay **readable**: "undefined" or an exception would
    // build a prompt telling the agent nothing.
    const rendered = renderRequest({
      system: [],
      tools: [{ name: "mystere", description: "", schema: undefined }],
      messages: [{ role: "user", text: "test" }],
    })
    expect(rendered).toContain("### mystere")
    expect(rendered).toContain("no schema")
    expect(rendered).not.toContain("undefined")
  })

  test("an empty transcript and an empty catalogue do not lie", () => {
    const rendered = renderRequest({ system: [], tools: [], messages: [] })
    expect(rendered).toContain("(no tool is available for this request)")
    expect(rendered).toContain("(no previous message)")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. `fromRequest`: the reconstruction from a real `LLMRequest`
// ─────────────────────────────────────────────────────────────────────────────

describe("fromRequest: the reconstruction is complete", () => {
  test("system, tools and transcript are taken over entirely", () => {
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    const normalized = normalizedOf(buildRequest(languageModel))

    expect(normalized.system).toEqual(SYSTEM_PARTS)
    expect(normalized.messages).toEqual(MESSAGES)
    expect(normalized.maxOutputTokens).toBe(512)
    // The three tools, and **only** them: a tool lost here is a tool the agent
    // will never be able to propose.
    expect(normalized.tools.map((t) => t.name)).toEqual(["read", "grep", "edit"])
    for (const tool of normalized.tools) {
      const reference = TOOLS.find((entry) => entry.name === tool.name)
      if (reference === undefined) throw new Error(`outil inattendu : ${tool.name}`)
      expect(tool.description).toBe(reference.description)
      // Note: the schema is compared **after re-serialisation**: that is the
      // shape that goes on the wire, and the one the agent will read.
      expect(JSON.stringify(tool.schema)).toBe(JSON.stringify(reference.schema))
    }
    // A top-level tool has no namespace: inventing one would put an empty
    // `namespace` on the `tool-call`.
    expect(normalized.tools.every((tool) => tool.namespace === undefined)).toBe(true)
  })

  test("the end-to-end prompt is exactly the one of the pure rendering", () => {
    // Note: the test that settles the question. If `fromRequest` lost a system
    // part, a tool, a message or its role, the equality would fail here.
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    const normalized = normalizedOf(buildRequest(languageModel))
    assertIntact(renderRequest(normalized))
  })

  test("an operator instruction mid-conversation joins the system prompt", () => {
    // A `Message.system` is an operator instruction: ACP has no "system" field,
    // so it must land in the system section, not in the transcript - otherwise
    // the agent would take it for a line from a past turn.
    const languageModel = model("gpt-5.6-terra", fakeSettings())
    const request = new LLMRequest({
      model: languageModel,
      system: [SystemPart.make("Base system.")],
      tools: [],
      messages: [
        Message.user("first"),
        Message.system("Reminder: never overwrite a locked file."),
        Message.user("second"),
      ],
    })
    const body = Effect.runSync(fromRequest(request, fakeSettings()))
    expect(body.request.system).toEqual([
      "Base system.",
      "Reminder: never overwrite a locked file.",
    ])
    expect(body.request.messages).toEqual([
      { role: "user", text: "first" },
      { role: "user", text: "second" },
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. The prompt **actually received** by the agent
// ─────────────────────────────────────────────────────────────────────────────

describe("the prompt received on the wire is byte for byte the rendered prompt", () => {
  const temporary: string[] = []

  const temporaryDirectory = async (label: string): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), `acp-prompt-${label}-`))
    temporary.push(directory)
    return join(directory, "prompt.txt")
  }

  afterAll(async () => {
    await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("a full turn loses neither system, nor tool, nor transcript", async () => {
    const promptFile = await temporaryDirectory("full")
    const settings = fakeSettings({ FAKE_PROMPT_FILE: promptFile })
    const languageModel = model("gpt-5.6-terra", settings)

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const route = languageModel.route
          const request = buildRequest(languageModel)
          const body = yield* route.body.from(request)
          const prepared: AcpPrepared = yield* route.prepareTransport(body, request)
          return yield* Stream.runCollect(route.streamPrepared(prepared, request, NO_HTTP))
        }),
      ).pipe(Effect.result),
    )
    expect(Result.isSuccess(outcome)).toBe(true)
    if (Result.isFailure(outcome)) return

    // The **file** is read: it is the only source saying what really reached the
    // subprocess, not what our code believes it sent.
    const raw = await readFile(promptFile, "utf8")
    expect(raw.startsWith(`${SEPARATOR}\n`)).toBe(true)
    const received = raw.slice(`${SEPARATOR}\n`.length).replace(/\n$/, "")

    // 1. The agent received a usable prompt, section by section.
    assertIntact(received)

    // 2. And it is **identical** to what the core produces for this request:
    //    no loss, no addition, no displacement.
    const normalized = normalizedOf(buildRequest(languageModel))
    expect(received).toBe(renderRequest(normalized))

    // 3. The turn itself ended normally: the capture must not have disturbed the
    //    protocol.
    const events: readonly LLMEvent[] = outcome.success
    expect(events.map((e) => e.type)).toEqual([
      "step-start",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
      "finish",
    ])
  })

  test("the prompt is longer when the request is richer", async () => {
    // The opposite of asking "does it lose things?": a prompt that shrinks when
    // an instruction is added would prove a truncation. So the **size** of the
    // file the agent deposited is measured.
    const rich = await temporaryDirectory("rich")
    const poor = await temporaryDirectory("poor")
    const extra = "Extra rule: never cite a file you have not read."

    for (const [file, system] of [
      [rich, [...SYSTEM_PARTS, extra]],
      [poor, SYSTEM_PARTS],
    ] as const) {
      const settings = fakeSettings({ FAKE_PROMPT_FILE: file })
      const languageModel = model("gpt-5.6-terra", settings)
      const request = new LLMRequest({
        model: languageModel,
        system: system.map((text) => SystemPart.make(text)),
        tools: [...TOOL_ENTRIES],
        messages: [Message.user("hello")],
      })
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
      expect(Result.isSuccess(outcome)).toBe(true)
    }

    const richPrompt = await readFile(rich, "utf8")
    const poorPrompt = await readFile(poor, "utf8")
    // The gap is exactly the added line: nothing was normalised, nothing was
    // absorbed, and the prompt is not capped.
    expect(richPrompt.length).toBe(poorPrompt.length + extra.length + 2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. The `tokens=2/24` of the real run: decoding the counters
// ─────────────────────────────────────────────────────────────────────────────

describe("usage: why the recipe shows 2/24", () => {
  /**
   * Replays the reducer and returns the end-of-turn `usage`.
   *
   * It goes through the reducer - rather than a plain object - because that is
   * what builds the core's `Usage` class, and therefore what OpenCode reads to
   * display its counters.
   */
  const usageOf = (input: number, output: number, cacheWrite: number, cacheRead = 0) => {
    const events: LLMEvent[] = []
    let state = initialState
    const feed = (event: Parameters<typeof reduce>[1]) => {
      const step = reduce(state, event)
      events.push(...step.events)
      state = step.state
    }
    feed({ type: "text", text: JSON.stringify({ type: "text", text: "pong" }) })
    feed({ type: "usage", kind: "turn", input, output, total: input + output, cacheWrite, cacheRead })
    feed({ type: "done", stopReason: "end_turn" })
    const finish = events.find((e) => e.type === "finish")
    if (finish?.type !== "finish") throw new Error("no finish")
    return finish.usage
  }

  test("the ~26 000 incoming tokens are not lost: they are cacheWrite", () => {
    // Note: **real capture on `copilot --acp`** (the `verify-real` probe):
    //   `input=25811 output=50 cacheWrite=25809` with a minimal prompt, and
    //   `input=36002 cacheWrite=22434` with ~4 000 more system tokens.
    // Two findings, and the second settles the question:
    //
    //   1. `inputTokens` really does carry the whole of the received tokens - it
    //      **grows** by what is added to the prompt, so the prompt is not lost;
    //   2. the `2` the interface displays is `nonCachedInputTokens`, the rest
    //      being `cacheWrite` that the agent pays once.
    const usage = usageOf(25_811, 50, 25_809)
    expect(usage?.inputTokens).toBe(25_811)
    expect(usage?.cacheWriteInputTokens).toBe(25_809)
    expect(usage?.outputTokens).toBe(50)
    // The "2" of `tokens=2/24`: the uncached input.
    expect(usage?.nonCachedInputTokens).toBe(2)
  })

  test("an agent declaring no cache is unaffected by the decoding", () => {
    // The computation must change nothing for an agent that does no caching:
    // that is the case of most local ACP agents.
    const usage = usageOf(1_500, 24, 0)
    expect(usage?.nonCachedInputTokens).toBe(1_500)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Namespaced tools: the only loss found
// ─────────────────────────────────────────────────────────────────────────────

describe("namespaced tools: the flat name is not enough to execute", () => {
  /** Two tools in a namespace, plus one top-level tool. */
  const namespaced = [
    ToolEntry.make({ name: "read", description: "Lit", inputSchema: { type: "object" } }),
    ToolNamespace.make({
      name: "search",
      description: "Recherche",
      tools: [
        ToolEntry.make({
          name: "grep",
          description: "Cherche",
          inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
        }),
      ],
    }),
  ]

  test("the prompt asks for the flat name, per @opencode/ai's convention", () => {
    const languageModel = model("gpt-5.6-terra", fakeSettings())
    const normalized = normalizedOf(buildRequest(languageModel, namespaced))
    expect(normalized.tools.map((t) => t.name)).toEqual(["read", "search_grep"])
    // A dot would be more readable, but `@opencode/ai` refuses `.` in tool names
    // with most providers ("not broadly accepted in provider tool names"), so it
    // is `_` everywhere, without exception.
    expect(renderRequest(normalized)).toContain("### search_grep")
  })

  test("the tool-call carries the namespace, otherwise the runtime cannot find the tool", () => {
    // Note: **the loss the investigation found.** `@opencode/ai`'s
    // `ToolRuntime.dispatch` indexes its registry by `namespace.name`, and
    // OpenCode's core does the same (`tools.set(dotted_name, tool)`). A
    // `tool-call` carrying only `search_grep` would fail with "No tool named
    // "search_grep" is currently available" - the call would be lost, and "the
    // agent **proposed** a non-existent tool" would be the only visible sign.
    const languageModel = model("gpt-5.6-terra", fakeSettings())
    const normalized = normalizedOf(buildRequest(languageModel, namespaced))

    const proposal = JSON.stringify({ type: "tool", name: "search_grep", arguments: { pattern: "x" } })
    const events: LLMEvent[] = []
    let state = { ...initialState, catalog: normalized.tools }
    for (const event of [
      { type: "text", text: proposal },
      { type: "done", stopReason: "end_turn" },
    ] as const) {
      const step = reduce(state, event)
      events.push(...step.events)
      state = step.state
    }
    const call = events.find((e) => e.type === "tool-call")
    expect(call?.name).toBe("search_grep")
    expect(call?.namespace).toBe("search")
    // And `halt` remains a no-op: the `tool-call` already went out, exactly once.
    expect(halt(state).events).toEqual([])
  })

  test("a top-level tool invents no namespace", () => {
    // Without this test, defaulting `namespace` to `""` would put an empty
    // namespace on the `tool-call`, and the runtime would look up `"." + name`.
    const languageModel = model("gpt-5.6-terra", fakeSettings())
    const normalized = normalizedOf(buildRequest(languageModel, namespaced))

    const events: LLMEvent[] = []
    let state = { ...initialState, catalog: normalized.tools }
    for (const event of [
      { type: "text", text: JSON.stringify({ type: "tool", name: "read", arguments: {} }) },
      { type: "done", stopReason: "end_turn" },
    ] as const) {
      const step = reduce(state, event)
      events.push(...step.events)
      state = step.state
    }
    const call = events.find((e) => e.type === "tool-call")
    expect(call?.name).toBe("read")
    expect(call?.namespace).toBeUndefined()
  })
})
