/**
 * Tests de la phase P1 : l'adaptateur OpenCode.
 *
 * Trois niveaux, du plus interne au plus externe :
 *
 * 1. **le réducteur**, en pur (§4.0) — les cas qu'un vrai agent produit trop
 *    rarement pour les déclencher à volonté (un delta sans start, un agent mort
 *    au milieu d'un bloc) sont ici des appels de fonction ;
 * 2. **les settings** — un JSON invalide doit produire un message qui nomme le
 *    champ, pas un `TypeError` dans le serveur d'OpenCode ;
 * 3. **le bout-en-bout** — la vraie route, construite par `model(...)`, contre
 *    `test/fake-acp.ts` lancé comme un vrai sous-processus. C'est le seul niveau
 *    qui prouve que la séquence `LLMEvent` est acceptée par le pipeline réel :
 *    une séquence mal formée échoue avec « The provider response ended
 *    unexpectedly. », indiscernable d'une troncature.
 */

import { afterAll, describe, expect, test } from "bun:test"
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
  // Les agents ACP sont mis en cache au niveau module : sans cette fermeture,
  // `bun test` tue le process de test en laissant des enfants vivants.
  await closeCachedAgents()
})

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────────────────────────────────────

/** Settings du faux agent ; échoue bruyamment si la validation se trompe. */
const fakeSettings = (
  env: Record<string, string> = {},
  extra: Readonly<Record<string, unknown>> = {},
): AcpProviderSettings => {
  const parsed = parseSettings({
    command: process.execPath,
    args: ["run", FAKE],
    cwd: process.cwd(),
    // `"ignore"` : le stderr de l'agent est une variable d'environnement, donc
    // il ne parle pas ; sans ça, `FAKE_NOISY_STDOUT` polluerait la sortie du test.
    stderr: "ignore",
    env,
    ...extra,
  })
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.value
}

/** Rejoue une suite d'événements ACP dans le réducteur. */
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

/** Un état de réducteur portant un catalogue d'outils, comme `initial(request)` le fait. */
const withTools = (
  ...names: readonly string[]
): ReducerState => ({
  ...initialState,
  catalog: names.map((name) => ({ name, description: "", schema: {} })),
})

/** Les types d'événements, pour comparer une séquence entière d'un coup d'œil. */
const types = (events: readonly LLMEvent[]): string[] => events.map((event) => event.type)

/**
 * Une réponse d'agent **conforme au contrat** de `core/prompt.ts` — §7.3.
 *
 * ⚠️ Depuis P2b, un `text` ACP n'est plus la réponse mais l'objet du contrat : le
 * réducteur le décode au `done`. Ces raccourcis évitent d'écrire du JSON littéral
 * dans chaque test, et surtout rendent visible la contrainte : un `text` en dur
 * échouerait désormais en `provider-error`.
 */
const say = (text: string): AcpEvent => ({
  type: "text",
  text: JSON.stringify({ type: "text", text }),
})

/** Un `text` ACP **brut**, c'est-à-dire un agent qui n'obéit pas au contrat. */
const raw = (text: string): AcpEvent => ({ type: "text", text })

/** L'index d'un événement de ce type, ou -1. */
const indexOfType = (events: readonly LLMEvent[], type: string): number =>
  events.findIndex((event) => event.type === type)

/** Le premier événement de ce type ; le test suppose qu'il existe. */
const first = <T extends LLMEvent["type"]>(
  events: readonly LLMEvent[],
  type: T,
): Extract<LLMEvent, { type: T }> => {
  const found = events.find((event): event is Extract<LLMEvent, { type: T }> => event.type === type)
  if (found === undefined) throw new Error(`aucun événement « ${type} » dans ${types(events).join(", ")}`)
  return found
}

/**
 * `TransportRuntime` du test.
 *
 * Le transport ACP ne fait **jamais** de HTTP : cet exécuteur n'est donc jamais
 * appelé. Il est nevertheless construit (le type l'exige) et il `die` bruyamment
 * — un `Effect.succeed` silencieux masquerait le jour où quelqu'un brancherait un
 * vrai endpoint HTTP par accident.
 */
const NO_HTTP = { http: { execute: () => Effect.die("le transport ACP ne fait pas de HTTP") } }

// ─────────────────────────────────────────────────────────────────────────────
// 1. Le réducteur, en pur
// ─────────────────────────────────────────────────────────────────────────────

describe("réducteur AcpEvent → LLMEvent", () => {
  test("le texte est tamponné, puis rendu d'un seul bloc au done", () => {
    // ⚠️ **Changement de comportement voulu (P2b).** Le texte n'est plus streamé
    // delta par delta : il ne peut pas l'être, car tant qu'on n'a pas lu la
    // réponse entière on ignore si c'est du texte ou un appel d'outil (§7.3).
    const before = replay([
      { type: "text", text: '{"type":"text","text":"bon' },
      { type: "text", text: 'jour"}' },
    ])
    // Rien n'est émis avant le `done` : c'est le cœur du compromis.
    expect(before.events).toEqual([])

    const { events } = replay(
      [
        { type: "text", text: '{"type":"text","text":"bon' },
        { type: "text", text: 'jour"}' },
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
    // Un **seul** delta, qui porte la réponse et non le JSON du contrat.
    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual(["bonjour"])
  })

  test("un bloc de raisonnement est fermé avant le texte rendu", () => {
    const { events } = replay([
      { type: "thought", text: "je réfléchis" },
      say("réponse"),
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
    // `reasoning-end` **avant** `text-start` : un seul bloc ouvert à la fois.
    expect(indexOfType(events, "reasoning-end")).toBeLessThan(indexOfType(events, "text-start"))
  })

  test("le raisonnement reste streamé en direct pendant que le texte s'accumule", () => {
    // Ce qui reste en direct, c'est exactement ce que l'utilisateur a besoin de
    // voir pendant que le tampon se remplit : l'activité de l'agent.
    const { events } = replay([
      raw('{"type":"text","text":"ré'),
      { type: "thought", text: "je cherche" },
      { type: "plan", entries: [{ content: "Analyser", priority: "high", status: "pending" }] },
      { type: "text", text: 'ponse"}' },
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
    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual(["réponse"])
  })

  test("un done sans rien produit malgré tout une séquence valide", () => {
    // Un agent qui n'écrit rien n'est pas une sortie non conforme : il n'y a
    // simplement rien à décoder, et on finit proprement.
    const { events } = replay([{ type: "done", stopReason: "end_turn" }])
    expect(types(events)).toEqual(["step-start", "step-finish", "finish"])
  })

  test("un plan devient du raisonnement, pas du texte visible", () => {
    const { events } = replay([
      {
        type: "plan",
        entries: [{ content: "Analyser", priority: "high", status: "pending" }],
      },
      say("c'est fait"),
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

  test("un appel d'outil ACP n'est émis qu'une fois, sans tool-result", () => {
    // Le cas réel : ACP envoie `tool_call`, puis `in_progress`, puis `completed`
    // pour **un** appel. §7.3 : le provider propose, OpenCode exécute — donc
    // aucun `tool-result`, et surtout pas trois `tool-call` pour un seul id.
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
    // `providerExecuted` absent ⇒ c'est OpenCode qui exécute.
    expect(first(events, "tool-call").providerExecuted).toBeUndefined()
    expect(state.tools.has("call-1")).toBe(true)
  })

  test("un tool-call sans nom retombe sur le titre", () => {
    const { events } = replay([
      {
        type: "tool",
        id: "call-2",
        name: "",
        title: "Écrire le fichier",
        kind: "edit",
        status: "pending",
        input: {},
      },
      { type: "done", stopReason: "end_turn" },
    ])
    expect(first(events, "tool-call").name).toBe("Écrire le fichier")
  })

  test("un appel d'outil ACP précède le texte rendu au done", () => {
    // Le texte est tamponné : il ne peut plus « fermer » un bloc de texte ouvert
    // par un `tool-input-start`. L'ordre reste simplement : appel d'outil d'abord
    // (il est arrivé avant), texte ensuite.
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

  test("deux appels d'outils distincts donnent deux tool-call", () => {
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
    const { events } = replay([say("voilà"), { type: "done", stopReason }])
    expect(first(events, "finish").reason.normalized).toBe(expected)
    expect(first(events, "step-finish").reason.normalized).toBe(expected)
  })

  test("un tool-call force « tool-calls », même avec un stopReason « end_turn »", () => {
    // Sans cela, la boucle OpenCode s'arrêterait et l'appel d'outil proposerait
    // ne serait jamais exécuté : c'est le cœur du §7.1.
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

  test("une erreur termine le flux par provider-error, et le done suivant est ignoré", () => {
    // ⚠️ Le tampon est **abandonné** : à l'erreur, ce qu'il contient est un JSON
    // tronqué, et l'afficher produirait un transcript à moitié mangé. L'erreur de
    // l'agent passe donc seule, terminale.
    const { state, events } = replay([
      raw('{"type":"text","text":"partial'),
      { type: "error", message: "l'agent est mort" },
      { type: "done", stopReason: "cancelled" },
    ])
    expect(types(events)).toEqual(["step-start", "step-finish", "provider-error"])
    expect(first(events, "provider-error").message).toBe("l'agent est mort")
    // Aucun `finish` **après** le terminal : le core le refuserait.
    expect(indexOfType(events, "finish")).toBe(-1)
    expect(state.terminal).toBe(true)
  })

  test("l'usage de fenêtre de contexte est ignoré, celui du tour est une instance Usage", () => {
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
    // ⚠️ Une **instance**, pas un objet littéral : c'est le piège du §4.0.
    expect(usage).toBeInstanceOf(Usage)
    expect(usage?.inputTokens).toBe(40)
    expect(usage?.outputTokens).toBe(2)
    expect(usage?.totalTokens).toBe(42)
    expect(usage?.reasoningTokens).toBe(1)
    expect(usage?.cacheReadInputTokens).toBe(7)
    expect(usage?.cacheWriteInputTokens).toBe(9)
    // Invariant de `Usage` : nonCached + cacheRead + cacheWrite = input.
    expect(usage?.nonCachedInputTokens).toBe(24)
    // Les deux `step-finish` et `finish` portent le même usage.
    expect(first(events, "step-finish").usage).toBe(usage)
  })

  test("un usage vide n'est pas inventé", () => {
    const { events } = replay([
      { type: "usage", kind: "turn" },
      say("x"),
      { type: "done", stopReason: "end_turn" },
    ])
    expect(first(events, "finish").usage).toBeUndefined()
  })

  test("un nonCached calculé ne descend jamais sous zéro", () => {
    const { events } = replay([
      { type: "usage", kind: "turn", input: 10, cacheRead: 8, cacheWrite: 8 },
      { type: "done", stopReason: "end_turn" },
    ])
    expect(first(events, "finish").usage?.nonCachedInputTokens).toBe(0)
  })

  test("une permission est comptée mais ne produit aucun LLMEvent", () => {
    const { state, events } = replay([
      {
        type: "permission",
        request: {
          sessionId: "s",
          toolCallId: "c",
          title: "Écrire",
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

  test("halt comble un flux vide", () => {
    // Le cas limite du core : un stream sans le moindre événement doit quand
    // même produire un événement terminal, sinon « ended unexpectedly ».
    expect(types(halt(initialState).events)).toEqual(["step-start", "step-finish", "finish"])
  })

  test("halt ferme les blocs ouverts avant de terminer", () => {
    // Seul le raisonnement peut rester ouvert d'un `reduce` au suivant : le texte
    // est tamponné, et le bloc de raisonnement doit être refermé avant le
    // `step-finish`.
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

  test("halt montre le tampon s'il est complet, et le jette s'il est tronqué", () => {
    // Une réponse arrivée entière puis un flux mort : elle est montrée. Une réponse
    // coupée au milieu du JSON : la jeter vaut mieux qu'afficher du JSON mangé.
    const complete = replay([say("déjà fini")])
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

  test("halt est sans effet après un done", () => {
    const { state } = replay([say("a"), { type: "done", stopReason: "end_turn" }])
    expect(halt(state).events).toEqual([])
  })

  test("halt garde « tool-calls » si un outil a été proposé", () => {
    const { state } = replay([
      { type: "tool", id: "c", name: "bash", title: "ls", kind: "execute", status: "pending", input: {} },
    ])
    expect(first(halt(state).events, "finish").reason.normalized).toBe("tool-calls")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 1bis. Le mécanisme §7.3 : le contrat de sortie, au niveau du réducteur
// ─────────────────────────────────────────────────────────────────────────────

describe("mécanisme §7.3 : le contrat de sortie devient un tool-call", () => {
  test("une réponse conforme « tool » devient un tool-call SANS tool-result", () => {
    // Le test qui porte la valeur du projet : l'agent **propose**, OpenCode
    // **exécute**. Sans `providerExecuted` ni `tool-result`, c'est exactement ce
    // que fait la boucle OpenCode (permissions, snapshots, undo).
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
    // C'est cette raison qui fait poursuivre la boucle OpenCode.
    expect(first(events, "finish").reason.normalized).toBe("tool-calls")
    expect(first(events, "step-finish").reason.normalized).toBe("tool-calls")
    // L'appel entre dans le registre : il ne sera pas réémis.
    expect(state.tools.size).toBe(1)
    expect(first(events, "tool-input-delta").text).toBe('{"filePath":"README.md"}')
  })

  test("deux demandes d'outils ne peuvent pas être rendues dans un même tour", () => {
    // Le contrat interdit d'en envoyer deux, et `parseAgentOutput` ne lit que
    // le premier objet exploitable : le second est ignoré silencieusement plutôt
    // que de produire une séquence que le core refuserait.
    const both = `{"type":"tool","name":"read","arguments":{}}${JSON.stringify({
      type: "tool",
      name: "bash",
      arguments: {},
    })}`
    const { events } = replay([raw(both), { type: "done", stopReason: "end_turn" }], withTools("read", "bash"))
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(1)
    expect(first(events, "tool-call").name).toBe("read")
  })

  test("un outil absent du catalogue échoue en nommant l'outillage et les noms acceptés", () => {
    // Jamais de dégradation silencieuse en texte : l'utilisateur doit voir que le
    // travail demandé est perdu, pas croire que l'agent a répondu normalement.
    const { events } = replay(
      [raw('{"type":"tool","name":"shell","arguments":{}}'), { type: "done", stopReason: "end_turn" }],
      withTools("read", "bash"),
    )
    expect(types(events)).toEqual(["step-start", "step-finish", "provider-error"])
    const message = first(events, "provider-error").message
    expect(message).toContain("shell")
    expect(message).toContain("read, bash")
    // Jamais de `finish` derrière un événement terminal.
    expect(indexOfType(events, "finish")).toBe(-1)
  })

  test.each([
    ["du texte brut", "Bonjour, je peux vous aider."],
    ["du JSON invalide", '{"type":"text","text":'],
    ["un type inconnu", '{"type":"réponse","text":"bonjour"}'],
    ["un texte vide", '{"type":"text","text":""}'],
  ])("%s finit en provider-error, jamais en troncature", (_label, output) => {
    const { events } = replay([raw(output), { type: "done", stopReason: "end_turn" }], withTools("read"))
    expect(types(events)).toEqual(["step-start", "step-finish", "provider-error"])
    // Le message porte un extrait de la sortie : c'est la seule chose qui permet
    // de comprendre *ce que* l'agent a produit de travers.
    expect(first(events, "provider-error").message.length).toBeGreaterThan(20)
  })

  test("un objet échappé dans un bloc ``` reste lisible", () => {
    // La tolérance de l'extraction ne s'arrête pas au premier `{` : une accolade
    // dans une chaîne ne referme rien, sinon le texte de l'agent serait coupé.
    const output = 'Voici : ```json\n{"type":"text","text":"voici {une} accolade"}\n```'
    const { events } = replay([raw(output), { type: "done", stopReason: "end_turn" }], withTools("read"))
    expect(first(events, "text-delta").text).toBe("voici {une} accolade")
  })

  test("un `arguments` qui n'est pas un objet est refusé, pas avalé", () => {
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
// 2. Les settings
// ─────────────────────────────────────────────────────────────────────────────

describe("settings du provider", () => {
  test("une configuration minimale est acceptée", () => {
    const parsed = parseSettings({ command: "copilot", args: ["--acp"] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.command).toBe("copilot")
    expect(parsed.value.args).toEqual(["--acp"])
    expect(parsed.value.cwd).toBeUndefined()
  })

  test("command est obligatoire, et le message nomme le champ", () => {
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
    ["copilot", "settings doit être un objet"],
  ])("refuse %o", (input, fragment) => {
    const parsed = parseSettings(input)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain(fragment)
  })

  test("une clé inconnue est ignorée, pas rejetée", () => {
    // OpenCode peut ajouter ses propres clés : faire tomber le provider pour
    // cela serait pire que d'ignorer une clé.
    const parsed = parseSettings({ command: "copilot", baseURL: "https://exemple" })
    expect(parsed.ok).toBe(true)
  })

  test("la clé du process inclut la politique, sinon deux providers se contaminent", () => {
    const strict = fakeSettings()
    const loose = fakeSettings({ FAKE_BOOLEAN_OPTION: "1" })
    // `env` change la clé : deux faux agents différents, deux processus.
    expect(agentKey(strict)).not.toBe(agentKey(loose))
    const withTools = parseSettings({ command: "copilot", allowedTools: ["*"] })
    const without = parseSettings({ command: "copilot" })
    if (!withTools.ok || !without.ok) throw new Error("parseSettings a échoué")
    // `allowedTools` change la **politique du client ACP** : c'est une
    // différence qui doit donner deux agents distincts.
    expect(agentKey(withTools.value)).not.toBe(agentKey(without.value))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Bout-en-bout contre le faux agent
// ─────────────────────────────────────────────────────────────────────────────

/** Construit une requête `LLMRequest` réaliste : système, outils, transcript. */
const buildRequest = (languageModel: LanguageModel, userText: string): LLMRequest =>
  new LLMRequest({
    model: languageModel,
    system: [
      SystemPart.make("Tu es un assistant."),
      SystemPart.make("Réponds en français."),
    ],
    tools: [
      ToolEntry.make({
        name: "read",
        description: "Lit un fichier du projet",
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
 * Joue une requête de bout en bout et renvoie les `LLMEvent` **sans** échec
 * d'initialisation, exactement comme le fait le core d'OpenCode.
 */
const runTurn = async (
  settings: AcpProviderSettings,
  modelID: string,
  request: LLMRequest,
): Promise<LLMEvent[]> => {
  const languageModel = model(modelID, settings)
  // `LanguageModel.route` est typé `AnyRoute` par `@opencode/ai` : c'est la vue
  // effacée qu'il expose, donc `body`/`prepared` sont opaques à ce niveau. On
  // emprunte le même chemin que `compileRequest` : `body.from`, puis
  // `prepareTransport`, puis `streamPrepared`.
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
    throw new Error(`le flux a échoué : ${outcome.failure.message}`)
  }
  return outcome.success
}

describe("bout-en-bout : route réelle contre l'agent ACP", () => {
  test("un tour texte produit la séquence attendue", async () => {
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    // `PING` fait répondre le faux agent, qui respecte le contrat : un seul
    // `text` portant l'objet JSON, décodé en un unique `text-delta` au `done`.
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

  test("le prompt contient le système, le catalogue d'outils et le transcript", async () => {
    // Le faux agent renvoie le prompt **qu'il a reçu** dans son unique chunk de
    // texte : c'est la seule façon de vérifier `fromRequest` de bout en bout.
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    // Aucun mot-clé du faux agent : il prend sa branche par défaut, qui « echo »
    // le prompt.
    const request = buildRequest(languageModel, "bonjour")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    const echoed = events
      .filter((e) => e.type === "text-delta")
      .map((e) => e.text)
      .join("")
    const expected = renderRequest({
      system: ["Tu es un assistant.", "Réponds en français."],
      tools: [
        {
          name: "read",
          description: "Lit un fichier du projet",
          schema: {
            type: "object",
            properties: { filePath: { type: "string" } },
            required: ["filePath"],
          },
        },
      ],
      messages: [
        { role: "user", text: "bonjour" },
        { role: "assistant", text: `Appel d'outil read : {"filePath":"README.md"}` },
        { role: "tool", id: "call-9", name: "read", output: "# README" },
      ],
      maxOutputTokens: 512,
    })
    expect(echoed).toBe(`ACK: ${expected}`)
  })

  test("un appel d'outil devient un tool-call SANS tool-result, et finit en tool-calls", async () => {
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "TOOL")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    // Le faux agent émet `tool_call`, `in_progress` **puis** `completed` : le
    // réducteur n'en fait qu'un seul `tool-call`, sans `tool-result` (§7.3).
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
    // C'est ce qui fait continuer la boucle OpenCode.
    expect(first(events, "finish").reason.normalized).toBe("tool-calls")
  })

  test("une réponse conforme « tool » devient un tool-call SANS tool-result, et finit en tool-calls", async () => {
    // ⚠️ **Le test qui porte la valeur de P2b.** Le faux agent produit le contrat
    // de sortie de `core/prompt.ts` — un `text` JSON unique — et le réducteur le
    // transforme en `tool-call` que **OpenCode** exécutera. C'est le mécanisme
    // §7.3 complet : prompt → parse → `LLMEvent` → boucle OpenCode.
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
    // Le nom vient du **catalogue transmis dans le prompt** (ici `read`), jamais
    // d'un nom d'outil ACP : c'est ce qui supprime tout problème de mapping.
    expect(first(events, "tool-call")).toMatchObject({
      name: "read",
      input: { filePath: "README.md" },
    })
    expect(first(events, "tool-call").providerExecuted).toBeUndefined()
    expect(indexOfType(events, "tool-result")).toBe(-1)
    expect(indexOfType(events, "tool-error")).toBe(-1)
    expect(first(events, "finish").reason.normalized).toBe("tool-calls")
  })

  test("un agent qui répond en texte brut échoue en provider-error, sans troncature", async () => {
    // `FAKE_OUTPUT=raw` : l'agent ignore le contrat. C'est le cas qu'un agent
    // tiers produit, et il ne doit surtout pas ressembler à une troncature.
    const settings = fakeSettings({ FAKE_OUTPUT: "raw" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "bonjour")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    expect(types(events)).toEqual(["step-start", "step-finish", "provider-error"])
    expect(first(events, "provider-error").message).toContain("bonjour")
    expect(indexOfType(events, "finish")).toBe(-1)
  })

  test("un outil halluciné échoue en nommant le catalogue transmis", async () => {
    // `FAKE_OUTPUT=hallucinated` : l'agent propose un outil qui n'existe pas.
    // Le message doit nommer l'outil **et** les noms acceptés, sinon l'utilisateur
    // ne peut rien faire du tour.
    const settings = fakeSettings({ FAKE_OUTPUT: "hallucinated" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "bonjour")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    const message = first(events, "provider-error").message
    expect(message).toContain("outil_qui_nexiste_pas")
    expect(message).toContain("read")
    expect(types(events)).toEqual(["step-start", "step-finish", "provider-error"])
  })

  test("une réponse enfermée dans un bloc ``` est acceptée", async () => {
    // `FAKE_OUTPUT=fenced` : beaucoup d'agents Buryent leur JSON dans un bloc de
    // markdown. La tolérance de `parseAgentOutput` doit absorber ça.
    const settings = fakeSettings({ FAKE_OUTPUT: "fenced" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "PING")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual(["PONG"])
  })

  test("l'usage du tour est une instance de la classe Usage", async () => {
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "PING")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    const usage = first(events, "finish").usage
    expect(usage).toBeInstanceOf(Usage)
    // Relevé du faux agent (`USAGE` dans `fake-acp.ts`).
    expect(usage?.inputTokens).toBe(40)
    expect(usage?.outputTokens).toBe(2)
    expect(usage?.totalTokens).toBe(42)
    expect(usage?.reasoningTokens).toBe(1)
    expect(usage?.cacheReadInputTokens).toBe(7)
    expect(usage?.cacheWriteInputTokens).toBe(9)
    expect(usage?.nonCachedInputTokens).toBe(24)
  })

  test("un flux interrompu ne hangue pas et n'émet pas de finish orphelin", async () => {
    // `TICK` : un `thought` immédiat, puis une longue latence interruptible. Le
    // raisonnement est ce qui est encore streamé en direct (le texte est
    // tamponné jusqu'au `done`), donc c'est lui qu'on attend. On ne prend que les
    // premiers événements : le `Scope` de la requête se ferme, la session se
    // ferme, l'agent reçoit `session/cancel`.
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
    // 30 s de latence côté agent : si l'annulation ne fonctionnait pas, ce test
    // durerait 30 s.
    expect(elapsed).toBeLessThan(10_000)
    const seen = outcome.success.map((event) => event.type)
    expect(seen).toEqual(["step-start", "reasoning-start"])
    // Aucun événement terminal, donc surtout **pas** de `finish` sans
    // `step-finish` : ce serait exactement la troncature que le core signale
    // par « The provider response ended unexpectedly. ».
    expect(indexOfType(outcome.success, "finish")).toBe(-1)
  })

  test("un agent qui meurt en plein tour finit en provider-error, pas en troncature", async () => {
    const settings = fakeSettings({ FAKE_DIE_ON_PROMPT: "1" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "DIE")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    expect(first(events, "provider-error").message).toBeTruthy()
    expect(indexOfType(events, "finish")).toBe(-1)
    // Un `step-finish` **avant** le terminal : c'est lui qui empêche le core de
    // lire une troncature.
    expect(indexOfType(events, "step-finish")).toBeLessThan(indexOfType(events, "provider-error"))
  })

  test("le variant d'effort est appliqué avant le prompt, après le modèle", async () => {
    // `effort` vient d'un `variant` de `Model.Info` (§5.2) : le plugin publie
    // `{ effort: "high" }`, OpenCode le fusionne dans les settings, et c'est
    // l'adaptateur qui doit le traduire en `set_config_option("reasoning_effort")`.
    // Sans ce test, ce câblage pourrait disparaître sans qu'aucun vert ne tombe :
    // `set_config_option` est un aller-retour JSON-RPC sans contrepartie.
    const settings = fakeSettings({ FAKE_ECHO_CONFIG: "1" }, { effort: "high" })
    const languageModel = model("claude-sonnet-5", settings)
    const request = buildRequest(languageModel, "PING")

    const events = await runTurn(settings, "claude-sonnet-5", request)

    // Le faux agent répond ce qu'il a **appliqué** : les deux options ont donc
    // été prises en compte, dans l'ordre.
    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual([
      "PONG claude-sonnet-5 high",
    ])
  })

  test("sans variant, l'agent garde la valeur qu'il annonce lui-même", async () => {
    const settings = fakeSettings({ FAKE_ECHO_CONFIG: "1" })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "PING")

    const events = await runTurn(settings, "gpt-5.6-terra", request)

    expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual([
      "PONG gpt-5.6-terra medium",
    ])
  })

  test("un effort hors liste échoue en nommant les valeurs acceptées", async () => {
    // Un effort peut être valide pour le modèle courant et invalide pour un
    // autre (`none` n'existe pas pour `claude-sonnet-5` sur `copilot --acp`) : on
    // échoue donc en nommant la liste, plutôt que de laisser l'agent refuser une
    // valeur muette.
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
    // Le message nomme la **chose** demandée : « le modèle "absent" » serait
    // illisible.
    expect(outcome.failure.message).toContain("niveau d'effort")
  })

  test("un modèle que l'agent ne propose pas échoue en nommant les valeurs acceptées", async () => {
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    const request = buildRequest(languageModel, "PING")
    // On construit la requête avec un modèle, puis on en demande un autre : c'est
    // `execute` qui applique le modèle de la requête (`set_config_option`).
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const route = languageModel.route
          const body = yield* route.body.from(request)
          const prepared: AcpPrepared = yield* route.prepareTransport(body, request)
          const bogus = { ...prepared, model: "pas-un-modele" }
          return yield* Stream.runCollect(route.streamPrepared(bogus, request, NO_HTTP))
        }),
      ).pipe(Effect.result),
    )
    expect(Result.isFailure(outcome)).toBe(true)
    if (Result.isSuccess(outcome)) return
    expect(outcome.failure.message).toContain("pas-un-modele")
    expect(outcome.failure.message).toContain("gpt-5.6-terra")
  })

  test("une requête sans message est refusée avant tout spawn", async () => {
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
    expect(outcome.failure.message).toContain("sans aucun message")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Le contrat du package provider
// ─────────────────────────────────────────────────────────────────────────────
describe("contrat du package provider", () => {
  test("model(id, settings) renvoie un LanguageModel rattaché à la route", () => {
    const languageModel = model("claude-sonnet-5", fakeSettings())
    expect(String(languageModel.id)).toBe("claude-sonnet-5")
    expect(String(languageModel.provider)).toBe("acp")
    expect(languageModel.route.id).toBe("acp-stdio")
    expect(languageModel.route.protocol).toBe("acp")
    expect(languageModel.route.transport.id).toBe("acp-stdio/transport")
  })

  test("des settings invalides lèvent un ProviderConfigurationError, pas une AIError", () => {
    // Le contrat d'`@opencode/ai` : une erreur de configuration est levée
    // **avant** toute requête, jamais au milieu d'un flux.
    expect(() => model("x", { args: ["--acp"] })).toThrow(ProviderConfigurationError)
    try {
      model("x", { args: ["--acp"] })
      throw new Error("aurait dû lever")
    } catch (error) {
      if (!(error instanceof ProviderConfigurationError)) throw error
      expect(error.message).toContain("settings.command")
    }
  })

  test("le process est partagé entre deux requêtes de mêmes settings", async () => {
    const settings = fakeSettings()
    // Sans ce cache, chaque tour d'une conversation relancerait un `initialize`.
    expect(acquireAgent(settings)).toBe(acquireAgent(settings))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. L'invariant de portabilité du cœur (§2.1)
// ─────────────────────────────────────────────────────────────────────────────

describe("invariant : le cœur n'importe rien de l'hôte", () => {
  // P1 est la première phase à introduire `@opencode/ai` et `effect` dans le
  // dépôt. C'est aussi la phase où il serait le plus tentant d'en faire un
  // raccourci dans `core/` (« juste un type »). Ce test est la seule chose qui
  // l'en empêche, et il coûte trois lignes.
  test("core/ n'importe ni @opencode/ai, ni effect, ni le SDK ACP", async () => {
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
