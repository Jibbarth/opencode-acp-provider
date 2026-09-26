/**
 * Does `session: "reuse"` actually buy **memory**?
 *
 * Everything the test suite proves about resume is about **what we send**: that
 * the second prompt holds the delta and not the history. That is necessary and
 * it is not sufficient. The question this probe answers is the one the unit
 * tests cannot: does `copilot --acp` *use* the session it was given, and does it
 * forget on a `fresh` session as the design assumes?
 *
 * Two phases, because the two questions need two different vantage points.
 *
 *   - **A — through the provider** (`model()`, the real `Transport`, the real
 *     agent): what does the agent answer, and what does it cost? This is the
 *     whole chain, exactly as OpenCode drives it.
 *   - **B — through the core** (`createAcpAgent` + `SessionPool`): the same
 *     reuse decision, the same delta, but the probe owns the `prompt()` call and
 *     can therefore **print the prompt the agent really receives**. Phase A
 *     cannot: the agent is a black box once spawned, and its `usage` counts its
 *     context window, which is nearly the same size whether the history was
 *     replayed as prompt text or is already in its own memory. A difference in
 *     the *request* is therefore not observable through the ACP accounting -
 *     only through the request itself.
 *
 * Scenario, identical in both modes: turn 1 hands over a file name to remember,
 * turn 2 asks for it back. The expected result in `fresh` is the whole point of
 * the exercise: `fresh` replays the **whole transcript**, so the answer is in
 * the prompt. If the agent answers anyway, the design's premise - "a fresh
 * session makes the agent forget everything" - is wrong, and the honest report
 * is that reuse buys cost and latency, not memory.
 *
 *   bun verify-resume.ts copilot --acp
 *   bun verify-resume.ts npx -y @agentclientprotocol/codex-acp
 */

import { Effect, Result, Stream } from "effect"
import { GenerationOptions, LLMRequest, Message, SystemPart, ToolEntry, Usage } from "@opencode/ai/schema/index"
import type { LanguageModel, LLMEvent } from "@opencode/ai/schema/index"

import { createAcpAgent } from "./src/acp/agent.js"
import { SessionPool } from "./src/core/session-pool.js"
import type { AcpAgent, AcpSession, NormalizedMessage, NormalizedRequest } from "./src/core/types.js"
import { renderRequest } from "./src/core/prompt.js"
import { closeCachedAgents } from "./src/adapters/opencode-transport.js"
import type { AcpPrepared } from "./src/adapters/opencode-transport.js"
import { model } from "./src/index.js"
import { parseSettings } from "./src/settings.js"
import type { AcpProviderSettings } from "./src/settings.js"

const command = process.argv[2] ?? "copilot"
const args = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ["--acp"]
const MODEL = process.env.ACP_PROBE_MODEL ?? "gpt-5.6-terra"
const CWD = process.cwd()

/** The fact planted in turn 1, and asked back in turn 2. */
const SECRET = "verglas-7741"

/**
 * Filler in turn 1, so that "the history was replayed" is a **size** and not an
 * assumption. `fresh` must carry it again on turn 2; `reuse` must not.
 */
const FILLER = `extrait d'un ticket : ${"l'anomalie reproduite est intermittente. ".repeat(200)}`

/**
 * The output contract, demanded in the user turn.
 *
 * Note: `renderRequest` already appends it to the system prompt, and
 * `verify-real.ts` documents the same precaution. Without it the agent simply
 * answers in prose, the parser refuses it, and the probe would be measuring the
 * agent's compliance instead of its memory.
 *
 * Note: it comes **first**. A long pasted document between the instruction and
 * the question measurably lowers compliance, and a turn the parser refuses is a
 * turn that produces no data at all.
 */
const JSON_ONLY = `Réponds UNIQUEMENT par cet objet JSON, sans texte autour : {"type":"text","text":"..."}`

const TOUR_1 = `${JSON_ONLY} Retiens le nom de mon fichier de configuration : il s'appelle ${SECRET}. ${FILLER}`
const TOUR_2 = `${JSON_ONLY} Comment s'appelle le fichier de configuration que je viens de te donner ? Réponds par le nom seul.`

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

const line = (text = ""): void => {
  process.stdout.write(`${text}\n`)
}

const title = (text: string): void => {
  line()
  line(`══ ${text}`)
}

/** One turn, as observed from outside. */
interface TurnReport {
  readonly text: string
  readonly usage: { input: number; output: number; cacheWrite: number } | undefined
  /** An answer the parser refused, or an error the agent reported. */
  readonly complaint: string | undefined
  readonly ms: number
}

const report = (label: string, turn: TurnReport): void => {
  line(`  ${label} : ${turn.ms} ms`)
  line(`  ${label} réponse : ${turn.text.trim() || "(vide)"}`)
  if (turn.complaint !== undefined) line(`  ${label} refus : ${turn.complaint}`)
  if (turn.usage === undefined) {
    line(`  ${label} usage : absent`)
    return
  }
  line(
    `  ${label} usage : input=${turn.usage.input} output=${turn.usage.output} ` +
      `cacheWrite=${turn.usage.cacheWrite}`,
  )
}

/**
 * `true` when the agent gave the planted fact back.
 *
 * Note: case-insensitive on purpose. A follow-up that asks for the name "en
 * majuscules" gets `VERGLAS-7741`, and a case-sensitive test would report that
 * correct answer as an amnesia - the kind of measurement error that decides a
 * question wrongly.
 */
const recalls = (answer: string): boolean => answer.toLowerCase().includes(SECRET.toLowerCase())

const settingsOf = (extra: Readonly<Record<string, unknown>>): AcpProviderSettings => {
  const parsed = parseSettings({ command, args, cwd: CWD, stderr: "ignore", ...extra })
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.value
}

/** The two message kinds this scenario uses; no tool call is involved. */
type Step = { readonly role: "user" | "assistant"; readonly text: string }

/** A request with a system prompt and one tool, like a real OpenCode turn. */
const requestOf = (languageModel: LanguageModel, steps: readonly Step[]): LLMRequest =>
  new LLMRequest({
    model: languageModel,
    system: [SystemPart.make("Tu es un assistant de test. Sois bref.")],
    tools: [
      ToolEntry.make({
        name: "read",
        description: "Lit un fichier du projet",
        inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
      }),
    ],
    messages: steps.map((step) => (step.role === "user" ? Message.user(step.text) : Message.assistant(step.text))),
    generation: GenerationOptions.make({ maxTokens: 200 }),
  })

/** The ACP transport does no HTTP: an executor that dies if called says so. */
const NO_HTTP = { http: { execute: () => Effect.die("le transport ACP ne fait pas de HTTP") } }

/** Runs one turn through the provider and reads the answer back. */
const runTurn = async (settings: AcpProviderSettings, steps: readonly Step[]): Promise<TurnReport> => {
  const languageModel = model(MODEL, settings)
  const request = requestOf(languageModel, steps)
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
  const ms = Date.now() - started
  if (Result.isFailure(outcome)) throw new Error(`le flux a échoué : ${outcome.failure.message}`)
  return { ...readEvents(outcome.success), ms }
}

/** The visible answer, the last `usage`, and anything the turn complained about. */
const readEvents = (events: readonly LLMEvent[]): Omit<TurnReport, "ms"> => {
  let text = ""
  let usage: TurnReport["usage"]
  let complaint: string | undefined
  for (const event of events) {
    if (event.type === "text-delta") text += event.text
    if ((event.type === "step-finish" || event.type === "finish") && event.usage instanceof Usage) {
      usage = {
        input: event.usage.inputTokens ?? 0,
        output: event.usage.outputTokens ?? 0,
        cacheWrite: event.usage.cacheWriteInputTokens ?? 0,
      }
    }
    // An unparsable answer is a **result**, not a crash: the agent was asked a
    // question about its memory, and "it answered but not in the contract" is
    // part of what there is to learn. Throwing here would hide the very case
    // worth reporting.
    if (event.type === "provider-error") complaint = event.message
  }
  return { text, usage, complaint }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase A - through the provider, the real chain
// ─────────────────────────────────────────────────────────────────────────────

/** One `reuse` or `fresh` run: turn 1 plants the fact, turn 2 asks for it. */
const scenario = async (mode: "reuse" | "fresh"): Promise<void> => {
  title(`Phase A — mode « ${mode} » — OpenCode → Transport → agent`)
  const settings = settingsOf({ session: mode })

  const first = await runTurn(settings, [{ role: "user", text: TOUR_1 }])
  report("tour 1", first)

  const second = await runTurn(settings, [
    { role: "user", text: TOUR_1 },
    { role: "assistant", text: first.text },
    { role: "user", text: TOUR_2 },
  ])
  report("tour 2", second)

  line(`  >>> l'agent se souvient du tour 1 : ${recalls(second.text) ? "OUI" : "NON"}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase B - the prompt the agent really receives
// ─────────────────────────────────────────────────────────────────────────────

/** The core's own view of a turn: the pool decides, the probe prints. */
const wireScenario = async (agent: AcpAgent, mode: "reuse" | "fresh"): Promise<void> => {
  title(`Phase B — mode « ${mode} » — le prompt reçu sur le fil`)
  const pool = new SessionPool<AcpSession>()
  const system = ["Tu es un assistant de test. Sois bref."]
  const tools = [
    {
      name: "read",
      description: "Lit un fichier du projet",
      schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
    },
  ]
  const identity = { agent: command, cwd: CWD, model: MODEL }
  const open = () => agent.open({ cwd: CWD })

  let previous: readonly NormalizedMessage[] = [{ role: "user", text: TOUR_1 }]
  for (const [index, history] of [
    previous,
    [...previous, { role: "assistant" as const, text: "(réponse du tour 1)" }, { role: "user" as const, text: TOUR_2 }],
  ].entries()) {
    // `fresh` never consults the pool: it opens a session and sends everything.
    const lease =
      mode === "reuse"
        ? await pool.acquire(identity, history, open)
        : await (async () => {
            const session = await open()
            return { session, reused: false, delta: history, release: () => {}, poison: () => {} }
          })()
    const sent: NormalizedRequest = {
      system,
      tools,
      messages: lease.delta,
      ...(lease.reused ? { resume: true } : {}),
    }
    const prompt = renderRequest(sent)
    line(`  tour ${index + 1} : ${lease.reused ? "session reprise" : "session neuve"}`)
    line(`    messages envoyés : ${lease.delta.length} (historique : ${history.length})`)
    line(`    prompt : ${prompt.length} caractères`)
    line(`    le prompt contient-il le nom du fichier du tour 1 : ${prompt.includes(`il s'appelle ${SECRET}`) ? "OUI" : "NON"}`)
    line(`    le prompt contient-il le remplissage du tour 1 : ${prompt.includes("anomalie reproduite") ? "OUI" : "NON"}`)
    previous = history
    if (mode === "reuse") {
      lease.release()
    } else {
      await lease.session.close()
    }
  }
  await pool.closeAll()
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase C - what reuse costs, and what it saves, as the conversation grows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Three extra questions, all about the same planted fact.
 *
 * Note: each one asks for the **name** back, not a property of it. A follow-up
 * whose answer is a derived value ("7 lettres") would be scored by a predicate
 * looking for the name, and a correct answer would read as an amnesia.
 */
const FOLLOW_UPS: readonly string[] = [
  "Rappelle-moi le nom du fichier, en majuscules.",
  "Combien de lettres compte le nom de ce fichier ? Redonne-moi le nom ensuite.",
  "Redonne-moi le nom du fichier, sans autre mot.",
]

/**
 * Four turns, same script in both modes, one line per turn.
 *
 * Note: this is the question the design is really asking. `reuse` promises a
 * prompt that "stops growing linearly"; the promise is only worth its complexity
 * if the **per-turn cost stops growing with the conversation**. A flat cost is
 * what makes a long session bearable, and a cost that grows is what would make
 * `reuse` the wrong default.
 */
const growthScenario = async (mode: "reuse" | "fresh"): Promise<void> => {
  title(`Phase C — mode « ${mode} » — coût par tour, sur ${FOLLOW_UPS.length + 1} tours`)
  const settings = settingsOf({ session: mode })
  const history: Step[] = [{ role: "user", text: TOUR_1 }]

  const first = await runTurn(settings, history)
  line(`  tour 1 : ${pad(first)}   se souvient : ${recalls(first.text) ? "OUI" : "non"}   ${flaw(first)}`)
  history.push({ role: "assistant", text: first.text })

  for (const [index, question] of FOLLOW_UPS.entries()) {
    history.push({ role: "user", text: `${question} ${JSON_ONLY}` })
    const turn = await runTurn(settings, history)
    line(
      `  tour ${index + 2} : ${pad(turn)}   se souvient : ${recalls(turn.text) ? "OUI" : "non"}` +
        `   ${flaw(turn)}« ${oneLine(turn.text)} »`,
    )
    history.push({ role: "assistant", text: turn.text })
  }
}

/**
 * A turn the parser refused, said out loud.
 *
 * Note: without it a refusal is indistinguishable from a wrong answer - both
 * leave `text` empty - and the probe would quietly report "the agent forgot"
 * for a turn the agent actually answered in prose.
 */
const flaw = (turn: TurnReport): string => (turn.complaint === undefined ? "" : "REFUS ")

/**
 * `1234 ms   input=18090   cacheWrite=18084   cacheRead=0`, `absent` where the
 * agent said nothing.
 *
 * Note: `cacheWrite` is the number that explains the latency gap. A `fresh`
 * session rebuilds the whole conversation as a **new** text every turn, so the
 * agent pays to write it into its prompt cache again and again; a resumed
 * session keeps the very same prefix in its own memory and hits that cache.
 */
const pad = (turn: TurnReport): string => {
  const usage = turn.usage
  if (usage === undefined) return `${String(turn.ms).padStart(6)} ms   usage absent`
  return (
    `${String(turn.ms).padStart(6)} ms   input=${usage.input}` +
    `   cacheWrite=${usage.cacheWrite}`
  )
}

/** The answer on one line, truncated - the point is the shape, not the prose. */
const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= 90 ? flat : `${flat.slice(0, 90)}…`
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

line(`# agent    : ${command} ${args.join(" ")}`)
line(`# modèle   : ${MODEL}`)
line(`# secret   : ${SECRET}`)
line(`# tour 1   : ${TOUR_1.length} caractères (dont ${FILLER.length} de remplissage)`)

let failure: string | undefined
try {
  await scenario("reuse")
  await scenario("fresh")
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
  line(`ECHEC (phase A) : ${failure}`)
}

try {
  await growthScenario("reuse")
  await growthScenario("fresh")
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  line(`ECHEC (phase C) : ${message}`)
  failure = failure ?? message
}

// Phase B gets its own agent: a fresh process, so a phase A failure cannot take
// the wire-level evidence down with it.
try {
  const agent = await createAcpAgent({ command, args, cwd: CWD, stderr: "ignore" })
  line(`# agent    : ${agent.info.name} v${agent.info.version} (protocole ${agent.protocolVersion})`)
  await wireScenario(agent, "reuse")
  await wireScenario(agent, "fresh")
  await agent.close()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  line(`ECHEC (phase B) : ${message}`)
  failure = failure ?? message
}

await closeCachedAgents()
process.exit(failure === undefined ? 0 : 1)
