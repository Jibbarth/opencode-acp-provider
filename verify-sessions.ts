/**
 * What actually decides the default session mode - measured, not argued.
 *
 * The unit tests prove what we **send** (a delta on resume, the whole history
 * otherwise). They cannot prove what the agent **counts**, because the agent is a
 * subprocess behind a JSON-RPC pipe. This probe is the other half: it runs the
 * real provider against a real `copilot --acp` and measures
 *
 *   1. how many ACP sessions one user exchange opens (and therefore what `fresh`
 *      costs on a tool-using turn);
 *   2. how `input` / `cacheWrite` / the prompt actually put on the wire evolve as
 *      a conversation grows, in both modes, on the same script;
 *   3. whether a rewritten history - what `/compact` leaves behind - really
 *      restarts on a clean session, or whether the agent keeps the pre-compact
 *      memory.
 *
 * The instrument is `acp-tap.mjs`, launched as the agent's own command: it
 * forwards stdio byte for byte and records the JSON-RPC requests that leave. The
 * counts are therefore **wire counts**, not a count of what the provider believes
 * it did - an `inventory()` probe or a retry hidden inside the SDK would show up
 * here and nowhere else.
 *
 *   bun run verify-sessions.ts copilot --acp
 *   ACP_SONDE_PART=2 bun run verify-sessions.ts copilot --acp
 *   ACP_SONDE_TURNS=12 ACP_SONDE_FILLER=20000 bun run verify-sessions.ts copilot --acp
 *
 * Scope of the evidence, stated up front:
 *
 * - The **OpenCode tool loop** is replayed here, not launched: one `LLMRequest`
 *   per model call, a `tool-call` (never `providerExecuted`) answered by a
 *   `tool-result` message, exactly as `session.ts` does. What is measured is
 *   therefore the provider's behaviour under the loop OpenCode implements, not
 *   OpenCode's own scheduling.
 * - The point at which **OpenCode** would run `/compact` is *extrapolated* from
 *   the measured slope and the context limit the plugin declares
 *   (`DEFAULT_LIMITS.context`); it is arithmetic on a measured slope, and is
 *   reported as such.
 * - The agent's own ceiling is never reached in a probe of this size, so the
 *   headroom it leaves is reported as a number and the crossing point as a
 *   projection.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { Effect, Result, Stream } from "effect"
import {
  GenerationOptions,
  LLMRequest,
  Message,
  SystemPart,
  ToolCallPart,
  ToolEntry,
  ToolResultPart,
  Usage,
} from "@opencode/ai/schema/index"
import type { LanguageModel, LLMEvent } from "@opencode/ai/schema/index"
import type { Message as MessageType } from "@opencode/ai/schema/index"

import { model } from "./src/index.js"
import { closeCachedAgents, countRetainedSessions } from "./src/adapters/opencode-transport.js"
import type { AcpPrepared } from "./src/adapters/opencode-transport.js"
import { SessionPool } from "./src/core/session-pool.js"
import type { ManagedSession } from "./src/core/session-pool.js"
import { DEFAULT_LIMITS } from "./src/core/publish.js"
import type { NormalizedMessage } from "./src/core/types.js"
import { parseSettings } from "./src/settings.js"
import type { AcpProviderSettings, SessionMode } from "./src/settings.js"

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const agentCommand = process.argv[2] ?? "copilot"
const agentArgs = process.argv.length > 3 ? process.argv.slice(3) : ["--acp"]
const MODEL = process.env.ACP_PROBE_MODEL ?? "gpt-5.6-terra"
const CWD = process.cwd()
const TAP = fileURLToPath(new URL("./acp-tap.mjs", import.meta.url))
const LOG_DIR = process.env.ACP_SONDE_LOG_DIR ?? "/tmp/opencode"

/** User turns of part 2, per mode. */
const TURNS = Number(process.env.ACP_SONDE_TURNS ?? 6)
/** Characters of filler appended to each user turn of part 2. */
const FILLER_CHARS = Number(process.env.ACP_SONDE_FILLER_CHARS ?? 9000)
/** `varied` (default) or `repeated`: the shape of the padding, not its size. */
const FILLER_MODE = process.env.ACP_SONDE_FILLER ?? "varied"
/** Tool calls part 1 asks for. */
const ASKED_TOOLS = Number(process.env.ACP_SONDE_TOOLS ?? 3)

const line = (text = ""): void => {
  process.stdout.write(`${text}\n`)
}

const title = (text: string): void => {
  line()
  line(`══ ${text}`)
}

/**
 * The JSON contract, demanded in the user turn.
 *
 * Note `renderRequest` already appends it to the system prompt, and both
 * existing probes document the same precaution. Without it in the user turn the
 * agent answers in prose, the parser refuses, and the probe measures the agent's
 * compliance instead of the session mode. It comes **first**: a long turn
 * between the instruction and the question measurably lowers compliance.
 */
const JSON_ONLY = `Answer ONLY with this JSON object, no text around it: {"type":"text","text":"..."}`

/** The fact planted before the compaction, and asked back after it. */
const SECRET = "verglas-7741"

/** Every tap log opened, re-read at the end once the agents are closed. */
const logs: string[] = []

// ─────────────────────────────────────────────────────────────────────────────
// The tap
// ─────────────────────────────────────────────────────────────────────────────

/** A request that left the client, as the tap saw it. */
interface WireRequest {
  readonly method: string
  readonly paramsBytes: number
}

interface Trace {
  readonly requests: readonly WireRequest[]
  /** The raw `session/new` result, the one reply carrying the inventory. */
  readonly newSessionResults: readonly unknown[]
  /** Every `usage_update.used` the agent announced, in order. */
  readonly contextUsed: readonly number[]
}

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

const asRequest = (entry: Record<string, unknown>): WireRequest | undefined => {
  if (entry["dir"] !== "out") return undefined
  const method = entry["method"]
  if (typeof method !== "string") return undefined
  const bytes = entry["paramsBytes"]
  return { method, paramsBytes: typeof bytes === "number" ? bytes : 0 }
}

const readTrace = (path: string): Trace => {
  const requests: WireRequest[] = []
  const newSessionResults: unknown[] = []
  const contextUsed: number[] = []
  // A tap that died mid-run leaves a partial log; that is readable, and the
  // truncation is visible in the counts rather than silent.
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (raw.trim() === "") continue
    const entry: unknown = JSON.parse(raw)
    if (!isRecord(entry)) continue
    const request = asRequest(entry)
    if (request !== undefined) requests.push(request)
    if (entry["dir"] === "in" && entry["result"] !== undefined) newSessionResults.push(entry["result"])
    if (entry["kind"] === "usage_update") {
      const used = entry["used"]
      if (typeof used === "number") contextUsed.push(used)
    }
  }
  return { requests, newSessionResults, contextUsed }
}

const countOf = (trace: Trace, method: string): number =>
  trace.requests.filter((request) => request.method === method).length

/** Prompts seen so far, in wire order: the k-th is the k-th model call. */
const promptSizes = (trace: Trace): readonly number[] =>
  trace.requests.filter((request) => request.method === "session/prompt").map((r) => r.paramsBytes)

/**
 * The context window the agent announces, if it announces one.
 *
 * Note the answer decides how the drift of §2.b can be interpreted. If the agent
 * published a window, "at which turn does it become the limiting factor" is a
 * division; if it publishes none - as `copilot --acp` appears to - the only
 * window in play is the one the **plugin** declares, and the agent's own ceiling
 * can only be bracketed, never computed.
 */
const announcedContextWindow = (trace: Trace): string | undefined => {
  for (const result of trace.newSessionResults) {
    if (!isRecord(result)) continue
    const models = result["models"]
    if (!Array.isArray(models)) continue
    for (const entry of models) {
      if (!isRecord(entry)) continue
      for (const key of ["contextWindow", "context_window", "maxInputTokens", "limit"]) {
        const value = entry[key]
        if (typeof value === "number") return `${key}=${value}`
      }
    }
  }
  return undefined
}

/**
 * Settings whose agent command is the tap, wrapping the real agent.
 *
 * Note the **distinct provider id** per scenario. `agentKey` holds the provider
 * id, so two scenarios get two agent processes, two session pools and two logs -
 * which is what makes the counts independent. Sharing one process would let the
 * first scenario's retained session answer the second one's first turn.
 */
const tappedSettings = (name: string, mode: SessionMode, logPath: string): AcpProviderSettings => {
  const parsed = parseSettings({
    provider: `acp-sonde-${name}`,
    command: process.execPath,
    args: ["run", TAP, logPath, agentCommand, ...agentArgs],
    cwd: CWD,
    stderr: "ignore",
    session: mode,
  })
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.value
}

// ─────────────────────────────────────────────────────────────────────────────
// Driving one model call
// ─────────────────────────────────────────────────────────────────────────────

/** What one model call produced, as seen from outside. */
interface TurnReport {
  readonly text: string
  readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly input: unknown }[]
  readonly usage: { input: number; output: number; cacheWrite: number; cacheRead: number } | undefined
  readonly complaint: string | undefined
  readonly ms: number
}

const readEvents = (events: readonly LLMEvent[]): Omit<TurnReport, "ms"> => {
  let text = ""
  let usage: TurnReport["usage"]
  let complaint: string | undefined
  const toolCalls: { id: string; name: string; input: unknown }[] = []
  for (const event of events) {
    if (event.type === "text-delta") text += event.text
    if (event.type === "tool-call") {
      toolCalls.push({ id: event.id, name: event.name, input: event.input })
    }
    if ((event.type === "step-finish" || event.type === "finish") && event.usage instanceof Usage) {
      usage = {
        input: event.usage.inputTokens ?? 0,
        output: event.usage.outputTokens ?? 0,
        cacheWrite: event.usage.cacheWriteInputTokens ?? 0,
        cacheRead: event.usage.cacheReadInputTokens ?? 0,
      }
    }
    // An unparsable answer is a **result**, not a crash: a turn the parser
    // refused is data about the agent's compliance, and must not be hidden.
    if (event.type === "provider-error") complaint = event.message
  }
  return { text, toolCalls, usage, complaint }
}

/** One tool, the only one the agent is offered: a single call per answer. */
const READ_TOOL = ToolEntry.make({
  name: "read",
  description: "Reads a project file and returns its content",
  inputSchema: {
    type: "object",
    properties: { filePath: { type: "string" } },
    required: ["filePath"],
  },
})

/** The ACP transport does no HTTP: an executor that dies if called says so. */
const NO_HTTP = { http: { execute: () => Effect.die("the ACP transport does no HTTP") } }

const runTurn = async (
  languageModel: LanguageModel,
  messages: readonly MessageType[],
): Promise<TurnReport> => {
  const request = new LLMRequest({
    model: languageModel,
    system: [SystemPart.make("You are a test assistant. Be brief.")],
    tools: [READ_TOOL],
    messages,
    generation: GenerationOptions.make({ maxTokens: 400 }),
  })
  const route = languageModel.route
  const started = Date.now()
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
  return { ...readEvents(outcome.success), ms: Date.now() - started }
}

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= 70 ? flat : `${flat.slice(0, 70)}…`
}

/**
 * The OpenCode tool loop, replayed: call, execute, feed the result back, repeat.
 *
 * Note the tool is executed **here**, not by the agent: a `tool-call` emitted
 * without `providerExecuted` is what makes OpenCode run it, and the resulting
 * `tool-result` message is what the next `LLMRequest` carries. Reproducing those
 * two steps is the whole of the host side of the loop.
 */
const runToolLoop = async (
  languageModel: LanguageModel,
  asked: number,
): Promise<{
  readonly modelCalls: number
  readonly executed: number
  readonly truncated: boolean
  readonly last: TurnReport
}> => {
  const messages: MessageType[] = []
  const wanted = Array.from({ length: asked }, (_, index) => `ticket-${index + 1}.txt`)
  messages.push(
    Message.user(
      `${JSON_ONLY} Call the "read" tool ${asked} times, once per turn, in this order: ` +
        `${wanted.join(", ")}. Once you have read the ${asked} files, answer with "read" as text.`,
    ),
  )
  // The loop is bounded: a runaway agent must not make the probe unbounded, and
  // the cap is reported so a truncated run is never read as a complete one.
  const cap = asked * 3 + 2
  let executed = 0
  let last = await runTurn(languageModel, messages)
  let modelCalls = 1
  while (last.toolCalls.length > 0 && modelCalls < cap) {
    const call = last.toolCalls[0]
    if (call === undefined) break
    const filePath = isRecord(call.input) ? String(call.input["filePath"] ?? "?") : "?"
    executed += 1
    messages.push(Message.assistant([ToolCallPart.make({ id: call.id, name: call.name, input: call.input })]))
    messages.push(
      Message.tool(
        ToolResultPart.make({
          id: call.id,
          name: call.name,
          result: { type: "content", value: [{ type: "text", text: `contenu de ${filePath} : 12 lignes` }] },
        }),
      ),
    )
    last = await runTurn(languageModel, messages)
    modelCalls += 1
  }
  return { modelCalls, executed, truncated: last.toolCalls.length > 0, last }
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 1 - how many ACP sessions does one exchange open?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filler of a known size, so a conversation's growth is a number, not a vibe.
 *
 * Note the **varied** form is the default. A filler made of one sentence repeated
 * a hundred times is degenerate input for a tokeniser and for an agent's prompt
 * cache: the first measurement of this probe was taken with exactly that, and
 * the agent's accounting cannot be trusted on it. `ACP_SONDE_FILLER=repeated`
 * restores it, as the control that says whether a figure depends on the shape of
 * the padding rather than on the session mode.
 */
const filler = (chars: number, seed: number): string => {
  if (FILLER_MODE === "repeated") {
    return `Context note: ticket ${seed} describes an intermittent fault of the billing service. `.repeat(
      Math.ceil(chars / 92),
    ).slice(0, chars)
  }
  const words = [
    "billing", "latency", "index", "switchover", "failover", "cache", "deployment",
    "migration", "queue", "logging", "replica", "scheduler", "token",
    "signature", "rotation", "quorum", "fallback", "rearm", "counter", "clock",
  ]
  const out: string[] = []
  let index = 0
  while (out.join(" ").length < chars) {
    const a = words[(index + seed) % words.length] ?? "ticket"
    const b = words[(index * 7 + seed * 3) % words.length] ?? "service"
    const c = (seed * 131 + index * 17) % 9973
    out.push(`Folder ${c} reports a regression of ${a} raised by ${b} after the switchover.`)
    index += 1
  }
  return out.join(" ").slice(0, chars)
}

const partOne = async (mode: SessionMode): Promise<void> => {
  title(`Part 1 - mode "${mode}" - one exchange with ${ASKED_TOOLS} tools`)
  const logPath = `${LOG_DIR}/acp-sonde-1-${mode}.log`
  const settings = tappedSettings(`p1-${mode}`, mode, logPath)
  const languageModel = model(MODEL, settings)

  const result = await runToolLoop(languageModel, ASKED_TOOLS)
  const trace = readTrace(logPath)
  const sizes = promptSizes(trace)

  line(`  model calls (OpenCode turns)          : ${result.modelCalls}`)
  line(`  tools executed by the host            : ${result.executed}`)
  line(`  session/new on the wire                 : ${countOf(trace, "session/new")}`)
  line(`  session/prompt on the wire             : ${countOf(trace, "session/prompt")}`)
  line(`  session/close on the wire              : ${countOf(trace, "session/close")}`)
  line(`  ratio model + 1 = tools + 1            : ${result.modelCalls === result.executed + 1 ? "YES" : `NO (${result.modelCalls} != ${result.executed + 1})`}`)
  line(`  ratio ACP sessions = model calls        : ${countOf(trace, "session/new") === result.modelCalls ? "YES" : "NO"}`)
  line(`  size of the prompts sent (characters)  : ${sizes.join(", ")}`)
  line(`  final answer                            : ${oneLine(result.last.text)}`)
  if (result.executed === 0) {
    // The agent's willingness to call a tool at all is **not** reproducible: it
    // refuses sometimes, and a run that executed nothing measures a one-turn
    // exchange, not the N-tools exchange the ratio is about.
    line(`  ! no tool requested by the agent: the N+1 relation is not exercised by this run`)
  }
  if (result.truncated) {
    line(`  ! truncated loop: the agent was still asking for a tool after ${result.modelCalls} turns`)
  }
  if (result.last.complaint !== undefined) line(`  parser refusal                          : ${result.last.complaint}`)
  line(`  does the agent announce a window size?  ${announcedContextWindow(trace) ?? "no (no context field in session/new)"}`)
  logs.push(logPath)
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 2 - how the cost drifts as the conversation grows
// ─────────────────────────────────────────────────────────────────────────────

/** One measured turn of a growing conversation. */
interface GrowthPoint {
  readonly turn: number
  readonly input: number
  readonly cacheWrite: number
  readonly cacheRead: number
  /** What the agent itself announced as its context fill (`usage_update`). */
  readonly contextUsed: number
  readonly promptChars: number
  readonly ms: number
}

const growthScenario = async (mode: SessionMode): Promise<readonly GrowthPoint[]> => {
  title(`Part 2 - mode "${mode}" - ${TURNS} turns, +${FILLER_CHARS} characters per turn`)
  const logPath = `${LOG_DIR}/acp-sonde-2-${mode}.log`
  const settings = tappedSettings(`p2-${mode}`, mode, logPath)
  const languageModel = model(MODEL, settings)
  logs.push(logPath)

  const history: MessageType[] = []
  const points: GrowthPoint[] = []
  // `usage_update` arrives mid-turn, so the ones belonging to a turn are the ones
  // logged since the previous turn ended. A cursor, not a global max: the max
  // would keep reporting the first turn's figure if a later turn announced none.
  let contextCursor = 0

  for (let turn = 1; turn <= TURNS; turn += 1) {
    const question =
      turn === 1
        ? `${JSON_ONLY} Summarise in one sentence the context note I give you.`
        : `${JSON_ONLY} Note ${turn}. ${filler(FILLER_CHARS, turn)} Summarise in one sentence note ${turn}.`
    history.push(Message.user(question))
    const report = await runTurn(languageModel, history)
    const usage = report.usage ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
    const trace = readTrace(logPath)
    const sizes = promptSizes(trace)
    const announced = trace.contextUsed.slice(contextCursor)
    contextCursor = trace.contextUsed.length
    const point: GrowthPoint = {
      turn,
      input: usage.input,
      cacheWrite: usage.cacheWrite,
      cacheRead: usage.cacheRead,
      contextUsed: announced.length === 0 ? Number.NaN : Math.max(...announced),
      promptChars: sizes[sizes.length - 1] ?? 0,
      ms: report.ms,
    }
    points.push(point)
    line(
      `  tour ${turn} : input=${String(point.input).padStart(6)} cacheWrite=${String(point.cacheWrite).padStart(6)}` +
        ` cacheRead=${String(point.cacheRead).padStart(6)} contexte=${Number.isNaN(point.contextUsed) ? "     ?" : String(point.contextUsed).padStart(6)}` +
        ` prompt=${String(point.promptChars).padStart(7)} car.` +
        `  ${String(point.ms).padStart(6)} ms   ${oneLine(report.text)}`,
    )
    history.push(Message.assistant(report.text))
  }
  return points
}

/**
 * Per-turn slope of a counter, by least squares on the turn index.
 *
 * Note turn 1 is **excluded**. The first turn of a session is the one where the
 * agent may report no `usage` at all - a `fresh` run measured `input=0` there -
 * and a single such point drags a least-squares slope by thousands of tokens per
 * turn, which is precisely the number the projection is built on.
 */
const slope = (points: readonly GrowthPoint[], pick: (p: GrowthPoint) => number): number => {
  const usable = points.filter((point) => point.input > 0)
  const n = usable.length
  if (n < 2) return Number.NaN
  const meanX = usable.reduce((sum, p) => sum + p.turn, 0) / n
  const meanY = usable.reduce((sum, p) => sum + pick(p), 0) / n
  let num = 0
  let den = 0
  for (const p of usable) {
    num += (p.turn - meanX) * (pick(p) - meanY)
    den += (p.turn - meanX) ** 2
  }
  return den === 0 ? Number.NaN : num / den
}

const reportGrowth = (mode: SessionMode, points: readonly GrowthPoint[]): void => {
  const first = points[0]
  const last = points[points.length - 1]
  if (first === undefined || last === undefined) return
  const inputSlope = slope(points, (p) => p.input)
  const contextSlope = slope(points, (p) => p.contextUsed)
  const promptSlope = slope(points, (p) => p.promptChars)
  const announced = points.filter((p) => !Number.isNaN(p.contextUsed))
  const realContext = announced[announced.length - 1]?.contextUsed ?? Number.NaN
  // What OpenCode sees is the `input` we forward, not the agent's own context
  // fill: `toUsage` maps ACP `inputTokens` to `Usage.inputTokens`, and that is
  // the number a compaction threshold is applied to. The gap between the two is
  // therefore not cosmetic - it is the distance between when OpenCode compacts
  // and when the agent is actually full.
  const gap = Number.isNaN(realContext) ? Number.NaN : last.input / realContext
  const turnsByInput = inputSlope > 0 ? (DEFAULT_LIMITS.context - last.input) / inputSlope : Number.NaN
  const turnsByContext =
    contextSlope > 0 ? (DEFAULT_LIMITS.context - realContext) / contextSlope : Number.NaN

  line()
  line(`  -- summary "${mode}" (filler ${FILLER_MODE}, ${FILLER_CHARS} chars/turn)`)
  line(`  input       : ${first.input} -> ${last.input}   (slope ${inputSlope.toFixed(0)} tokens/turn, turn 1 excluded)`)
  line(`  cacheWrite  : ${first.cacheWrite} -> ${last.cacheWrite}`)
  line(`  cacheRead   : ${first.cacheRead} -> ${last.cacheRead}`)
  line(`  real context announced by the agent: ${announced.map((p) => p.contextUsed).join(" -> ")}  (slope ${contextSlope.toFixed(0)} tokens/turn)`)
  line(`  prompt      : ${first.promptChars} -> ${last.promptChars} chars (slope ${promptSlope.toFixed(0)} chars/turn)`)
  line(`  >>> input / real context on the last turn: ${Number.isNaN(gap) ? "?" : gap.toFixed(2)}x`)
  line(
    `  >>> turns before the limit (context=${DEFAULT_LIMITS.context}), per OpenCode's counter: ` +
      ` ${turnsByInput.toFixed(0)}   |   per the agent's real context: ${turnsByContext.toFixed(0)}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 3 - resynchronisation after a rewritten history
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The same two histories, decided by the core alone.
 *
 * Note: no agent, no network, and a session whose `close` is a no-op. The point
 * is to name **which** refusal fired, which the wire cannot show: a second
 * `session/new` looks the same whether the key moved or the digests diverged.
 */
const decideWithoutAgent = async (): Promise<void> => {
  const identity = { agent: "probe", cwd: CWD, model: MODEL }
  const before: NormalizedMessage[] = [
    { role: "user", text: `Remember the name of my configuration file: it is called ${SECRET}.` },
    { role: "assistant", text: "Noted: verglas-7741." },
  ]
  // What a compaction leaves behind: a summary, and no verbatim earlier turn.
  const after: NormalizedMessage[] = [
    { role: "user", text: "Conversation summary: the user asked for a summary of technical notes." },
    { role: "assistant", text: "Here is the summary." },
    { role: "user", text: `What is the name of the configuration file? ${JSON_ONLY}` },
  ]
  const pool = new SessionPool<ManagedSession>()
  const open = async (): Promise<ManagedSession> => ({ close: async (): Promise<void> => {} })
  const first = await pool.acquire(identity, before, open)
  line(`  before rewrite: reuse=${String(first.reused)} reason=${String(first.reason)}`)
  first.release()
  const second = await pool.acquire(identity, after, open)
  line(`  after rewrite : reuse=${String(second.reused)} reason=${String(second.reason)}`)
  line(`  delta resent     : ${second.delta.length} message(s) out of ${after.length}`)
  second.release()
  await pool.closeAll()
}

/**
 * Everything the agent actually said, contract or not.
 *
 * Note the reducer only emits `text` once it has decoded the JSON output
 * contract, so an answer in prose is visible **only** through the
 * `provider-error` that reports it. Both are the agent's own words, and the
 * amnesia verdict must rest on those alone: a run where the agent declined the
 * contract, or the planted turn was never acknowledged, has to be reported as
 * inconclusive rather than quietly scored as a success.
 */
const said = (turn: TurnReport): string =>
  `${turn.text} ${turn.complaint ?? ""}`.toLowerCase()

const recalls = (turn: TurnReport): boolean => said(turn).includes(SECRET.toLowerCase())

const partThree = async (mode: SessionMode): Promise<void> => {
  title(`Part 3 - mode "${mode}" - history rewrite (the equivalent of /compact)`)
  const logPath = `${LOG_DIR}/acp-sonde-3-${mode}.log`
  const settings = tappedSettings(`p3-${mode}`, mode, logPath)
  const languageModel = model(MODEL, settings)

  // Turn 1 plants the fact, turn 2 is an ordinary turn: the session now holds
  // the whole pre-compaction conversation.
  const before: MessageType[] = [
    Message.user(`${JSON_ONLY} Remember the name of my configuration file: it is called ${SECRET}. ${filler(2000, 1)}`),
  ]
  const planted = await runTurn(languageModel, before)
  line(`  turn 1 (planting)   : ${oneLine(planted.text) || "(empty)"}`)
  if (planted.complaint !== undefined) line(`  refusal turn 1        : ${planted.complaint}`)
  line(`  >>> the name was planted and given back on turn 1: ${recalls(planted) ? "YES" : "NO"}`)
  before.push(Message.assistant(planted.text))
  before.push(Message.user(`${JSON_ONLY} Acknowledge.`))
  const middle = await runTurn(languageModel, before)
  before.push(Message.assistant(middle.text))
  const afterFirstTwo = readTrace(logPath)
  line(`  turn 2 (plain)       : ${oneLine(middle.text) || "(empty)"}`)
  if (middle.complaint !== undefined) line(`  refusal turn 2        : ${middle.complaint}`)
  line(`  after 2 turns        : session/new=${countOf(afterFirstTwo, "session/new")} prompts=${countOf(afterFirstTwo, "session/prompt")}`)
  line(`  retained sessions (all parties)    : ${countRetainedSessions()}`)

  // The compaction: the history is **replaced**, not appended to. A real
  // `/compact` keeps a summary and drops the verbatim turns; the summary
  // deliberately omits the planted name, which is what makes any recall a
  // genuine leak of agent-side memory rather than a leak of the summary.
  const compacted: MessageType[] = [
    Message.user(
      "Conversation summary: the user had the assistant work on technical notes and a configuration file.",
    ),
    Message.assistant("Here is the summary of our exchanges."),
    Message.user(`${JSON_ONLY} What is the name of the configuration file I gave you? Answer with the name only.`),
  ]
  const sizesBefore = promptSizes(afterFirstTwo)
  const lastBefore = sizesBefore[sizesBefore.length - 1] ?? 0

  const asked = await runTurn(languageModel, compacted)
  const trace = readTrace(logPath)
  const sizes = promptSizes(trace)
  const lastAfter = sizes[sizes.length - 1] ?? 0

  line(`  after compact         : session/new=${countOf(trace, "session/new")} (+${countOf(trace, "session/new") - countOf(afterFirstTwo, "session/new")})`)
  line(`  session/close         : ${countOf(trace, "session/close")}`)
  line(`  retained sessions (all parties)    : ${countRetainedSessions()}`)
  line(`  prompt before/after   : ${lastBefore} -> ${lastAfter} chars.`)
  line(`  answer to the question: ${oneLine(asked.text) || "(empty)"}`)
  if (asked.complaint !== undefined) line(`  parser refusal         : ${asked.complaint}`)
  // The verdict is only worth as much as the plant. An agent that never took the
  // name in has nothing to forget, and scoring that as a successful amnesia test
  // would make the probe agree with itself for the wrong reason.
  const verdict = recalls(planted)
    ? recalls(asked)
      ? "YES - LEAK: the name survives the rewrite"
      : "NO - amnesia confirmed, the session really started from zero"
    : "INCONCLUSIVE - the name was never planted (the agent refused turn 1)"
  line(`  >>> the agent remembers the pre-compact name: ${verdict}`)
  line(`  >>> a fresh session was opened for the question: ${countOf(trace, "session/new") > countOf(afterFirstTwo, "session/new") ? "YES" : "NO"}`)
  logs.push(logPath)
}

/**
 * Every log, re-read once the agents are closed.
 *
 * Note it runs **after** `closeCachedAgents`: a session still alive at that point
 * is only ever closed by the shutdown, and the difference between "closed at the
 * right moment" and "closed at exit" is exactly what the retained-session count
 * cannot show on its own.
 */
const postMortem = (): void => {
  title("Wire report (after the agents are closed)")
  for (const logPath of logs) {
    const trace = readTrace(logPath)
    line(
      `  ${logPath.split("/").pop() ?? logPath} : session/new=${countOf(trace, "session/new")}` +
        ` prompt=${countOf(trace, "session/prompt")} close=${countOf(trace, "session/close")}` +
        ` cancel=${countOf(trace, "session/cancel")}`,
    )
  }
  line(`  sessions still retained after closing : ${countRetainedSessions()}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

line(`# agent     : ${agentCommand} ${agentArgs.join(" ")}`)
line(`# model     : ${MODEL}`)
line(`# tap       : ${TAP}`)
line(`# logs      : ${LOG_DIR}`)
line(`# contexte  : limit.context=${DEFAULT_LIMITS.context} limit.output=${DEFAULT_LIMITS.output} (DEFAULT_LIMITS du plugin)`)

const part = process.env.ACP_SONDE_PART ?? "all"
const modes: readonly SessionMode[] = ["fresh", "reuse"]
let failure: string | undefined

const guard = async (label: string, run: () => Promise<void>): Promise<void> => {
  try {
    await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    line(`FAILURE (${label}): ${message}`)
    failure = failure ?? message
  }
}

if (part === "all" || part === "1") {
  for (const mode of modes) {
    await guard(`partie 1 / ${mode}`, () => partOne(mode))
  }
}

if (part === "all" || part === "2") {
  const results = new Map<SessionMode, readonly GrowthPoint[]>()
  for (const mode of modes) {
    await guard(`partie 2 / ${mode}`, async () => {
      results.set(mode, await growthScenario(mode))
    })
  }
  title("Partie 2 — comparaison")
  for (const mode of modes) {
    const points = results.get(mode)
    if (points !== undefined) reportGrowth(mode, points)
  }
}

if (part === "all" || part === "3") {
  await guard("part 3 / core", decideWithoutAgent)
  for (const mode of modes) {
    await guard(`partie 3 / ${mode}`, () => partThree(mode))
  }
}

await closeCachedAgents()
postMortem()
process.exit(failure === undefined ? 0 : 1)
