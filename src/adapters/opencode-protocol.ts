/**
 * `AcpEvent` → `LLMEvent` — PLAN.md §4 et §4.0.
 *
 * Ce module est **la** machine à états de l'adaptateur OpenCode, et il est
 * **pur** : aucune entrée n'est nécessaire, aucun process n'est lancé, aucun
 * `Effect` n'est construit dans le cœur de la traduction. C'est ce qui permet
 * de tester les cas qui sont les plus difficiles à atteindre avec un vrai agent
 * — un `*-delta` sans `*-start`, un agent qui meurt au milieu d'un bloc — sans
 * dépendre du timings d'un sous-processus.
 *
 * ⚠️ La séquence d'événements produite ici est **strictement validée** par
 * `@opencode/ai` : la moindre malformation échoue avec « The provider response
 * ended unexpectedly. », message **indiscernable** d'une troncature (§4.0). Deux
 * règles en découlent, appliquées partout :
 *
 * 1. au plus **un** bloc de texte ou de raisonnement ouvert à la fois — on
 *    ferme avant d'ouvrir, dans les deux sens ;
 * 2. un flux qui s'arrête sans `step-finish` **et** `finish` est un bug, pas un
 *    détail : `halt()` comble le trou, y compris pour un flux *vide*.
 *
 * ⚠️ `usage` doit être une **instance** de la classe `Usage`. Un objet littéral
 * produit exactement le même message d'erreur qu'un flux tronqué ; le réducteur
 * construit donc toujours l'instance, et ne l'ajoute à l'état que si l'agent a
 * réellement rapporté des compteurs.
 */

import { Effect, Schema } from "effect"
import { Protocol } from "@opencode/ai/route"
import { Usage } from "@opencode/ai/schema/index"
import type { AIError, FinishReason, LLMEvent, LLMRequest } from "@opencode/ai/schema/index"

import type { AcpEvent, AcpStopReason, NormalizedMessage, NormalizedRequest, PlanEntry } from "../core/types.js"
import type { AcpProviderSettings } from "../settings.js"

/** Identifiant du protocole, visible dans les diagnostics de `@opencode/ai`. */
export const PROTOCOL_ID = "acp"

// ─────────────────────────────────────────────────────────────────────────────
// Corps de la requête
// ─────────────────────────────────────────────────────────────────────────────

/** Ce que `body.from` produit, et ce que `prepare` reçoit. */
export interface AcpBody {
  /** Modèle demandé par OpenCode — une valeur d'option côté agent (§5). */
  readonly model: string
  /** La requête telle que le cœur la comprend, quel que soit l'appelant. */
  readonly request: NormalizedRequest
}

const normalizedToolSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  schema: Schema.Unknown,
})

const normalizedMessageSchema = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), text: Schema.String }),
  Schema.Struct({ role: Schema.Literal("assistant"), text: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    id: Schema.String,
    name: Schema.String,
    output: Schema.String,
  }),
])

/**
 * Schéma du corps.
 *
 * ⚠️ `message` est `unknown` et non `string` : c'est le résultat d'un outil, qui
 * est très souvent un objet JSON. Le contraindre à une chaîne ferait échouer
 * `compileRequest` sur le premier `read` de fichier, avant même le spawn de
 * l'agent.
 */
const bodySchema: Schema.Codec<AcpBody, unknown> = Schema.Struct({
  model: Schema.String,
  request: Schema.Struct({
    system: Schema.Array(Schema.String),
    tools: Schema.Array(normalizedToolSchema),
    messages: Schema.Array(normalizedMessageSchema),
    maxOutputTokens: Schema.optional(Schema.Number),
    thinkingLevel: Schema.optional(Schema.String),
  }),
})

// ─────────────────────────────────────────────────────────────────────────────
// Cadre des trames
// ─────────────────────────────────────────────────────────────────────────────

/** Une trame émise par le transport : un `AcpEvent` enveloppé, sérialisable. */
export interface AcpFrame {
  readonly ev: AcpEvent
}

const planEntrySchema = Schema.Struct({
  content: Schema.String,
  priority: Schema.Literals(["high", "medium", "low"]),
  status: Schema.Literals(["pending", "in_progress", "completed"]),
})

const permissionRequestSchema = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  title: Schema.String,
  kind: Schema.String,
  options: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, kind: Schema.String })),
})

const permissionDecisionSchema = Schema.Union([
  Schema.Struct({ action: Schema.Literal("select"), optionId: Schema.String }),
  Schema.Struct({ action: Schema.Literal("reject"), optionId: Schema.optional(Schema.String) }),
  Schema.Struct({ action: Schema.Literal("cancel") }),
])

/**
 * ⚠️ Les deux variantes de `usage` restent **disjointes** (`kind: "context"` /
 * `"turn"`) : la notification de fenêtre de contexte et le coût du tour
 * viennent de deux producteurs différents, et les confondre afficherait un
 * compteur faux au lieu d'aucun (§ `core/types.ts`).
 *
 * `usage: "turn"` ne porte **que des champs optionnels**, jamais d'objets
 * imbriqués : c'est le réducteur qui construit la classe `Usage`, au dernier
 * moment, quand on sait qu'il y a des données.
 */
const acpEventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thought"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool"),
    id: Schema.String,
    name: Schema.String,
    title: Schema.String,
    kind: Schema.String,
    status: Schema.String,
    // ⚠️ `Unknown` et **pas** `optional` : le type doit rester aligné sur
    // `AcpEvent`, sinon l'annotation `Schema.Codec<AcpFrame, string>` ci-dessous
    // cesse de vérifier quoi que ce soit. C'est `toFrame` (transport) qui garantit
    // que la clé est **présente** dans le JSON, `JSON.stringify` supprimant
    // silencieusement les valeurs `undefined`.
    input: Schema.Unknown,
    output: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("plan"), entries: Schema.Array(planEntrySchema) }),
  Schema.Struct({ type: Schema.Literal("usage"), kind: Schema.Literal("context"), used: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("usage"),
    kind: Schema.Literal("turn"),
    input: Schema.optional(Schema.Number),
    output: Schema.optional(Schema.Number),
    total: Schema.optional(Schema.Number),
    reasoning: Schema.optional(Schema.Number),
    cacheRead: Schema.optional(Schema.Number),
    cacheWrite: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("permission"),
    request: permissionRequestSchema,
    decision: permissionDecisionSchema,
    selectedOptionId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("done"),
    stopReason: Schema.Literals(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]),
  }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
])

/**
 * Une trame est une **chaîne JSON** : le codec du core décode *toutes* les
 * trames via `Schema.decodeUnknownEffect`, et un `Schema.fromJsonString` est le
 * seul moyen d'obtenir un `Codec<Event, string>` avec l'API publique du
 * `Protocol`.
 */
const frameSchema: Schema.Codec<AcpFrame, string> = Protocol.jsonEvent(
  Schema.Struct({ ev: acpEventSchema }),
)

// ─────────────────────────────────────────────────────────────────────────────
// État du réducteur
// ─────────────────────────────────────────────────────────────────────────────

/**
 * État du réducteur, **immuable** : chaque `reduce` renvoie un nouvel état, ce
 * qui rend les tests reproductibles (rejouer la même séquence donne le même
 * résultat) et évite qu'un `onHalt` modifie un état déjà observé.
 */
export interface ReducerState {
  /** Index du step en cours ; 0 tant qu'un seul `step-finish` est attendu. */
  readonly step: number
  /** Un `step-start` a-t-il été émis pour le step courant ? */
  readonly started: boolean
  /** Id du bloc de texte ouvert, `null` si aucun. */
  readonly text: string | null
  /** Id du bloc de raisonnement ouvert, `null` si aucun. */
  readonly reasoning: string | null
  /** Compteur de blocs ouverts, pour des ids uniques et lisibles dans les logs. */
  readonly blocks: number
  /** Ids des appels d'outils **déjà émis** — une seule fois par id (§7.3). */
  readonly tools: ReadonlySet<string>
  /** Un `step-finish` a-t-il été émis pour le step courant ? */
  readonly stepFinished: boolean
  /** Un `finish` a-t-il été émis ? */
  readonly finished: boolean
  /** Un événement terminal (`finish` **ou** `provider-error`) a-t-il été émis ? */
  readonly terminal: boolean
  /** Dernier `usage` de tour rapporté par l'agent, s'il y en a un. */
  readonly usage: Usage | undefined
  /** Nombre de décisions de permission prises pendant le tour (observabilité §7.4). */
  readonly permissions: number
}

/** Résultat d'une étape de réduction. */
export interface Reduction {
  readonly state: ReducerState
  readonly events: LLMEvent[]
}

/** État initial — un tour qui n'a encore rien produit. */
export const initialState: ReducerState = {
  step: 0,
  started: false,
  text: null,
  reasoning: null,
  blocks: 0,
  tools: new Set<string>(),
  stepFinished: false,
  finished: false,
  terminal: false,
  usage: undefined,
  permissions: 0,
}

// ─────────────────────────────────────────────────────────────────────────────
// Réduction
// ─────────────────────────────────────────────────────────────────────────────

/** `stopReason` ACP → raison normalisée OpenCode (§4). */
const normalizedStopReason = (reason: AcpStopReason): FinishReason => {
  switch (reason) {
    case "end_turn":
    case "cancelled":
      return "stop"
    case "max_tokens":
      return "length"
    case "refusal":
      return "content-filter"
    // `max_turn_requests` n'a pas d'équivalent : le tour s'est arrêté parce que
    // l'agent a atteint sa limite de tours, pas parce qu'il a refusé de
    // répondre. « stop » est le seul choix qui ne ment pas sur la sortie.
    case "max_turn_requests":
      return "stop"
  }
}

/**
 * Raison de fin de tour.
 *
 * ⚠️ `tool-calls` l'emporte **toujours** quand au moins un appel a été émis :
 * c'est la seule valeur qui fait poursuivre la boucle OpenCode, donc
 * transformer un tour qui propose un outil en `stop` reviendrait à faire perdre
 * silencieusement le travail de l'agent (§7.1).
 */
const finishReasonOf = (state: ReducerState, stopReason?: AcpStopReason): FinishReason => {
  if (state.tools.size > 0) return "tool-calls"
  return stopReason === undefined ? "stop" : normalizedStopReason(stopReason)
}

/** Raison d'un flux interrompu : on ne connaît pas le `stopReason`. */
const haltReason = (state: ReducerState): FinishReason =>
  state.tools.size > 0 ? "tool-calls" : "stop"

/** Rendu texte d'une valeur quelconque (résultat d'outil, entrée d'appel…). */
const renderJson = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  // Un résultat d'outil peut être circulaire : mieux vaut une mention honnête
  // qu'une exception au milieu de la construction du prompt.
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** `Usage` ACP → instance `Usage` (§4.1), ou `undefined` si l'agent n'a rien dit. */
const toUsage = (event: Extract<AcpEvent, { type: "usage"; kind: "turn" }>): Usage | undefined => {
  const { input, output, total, reasoning, cacheRead, cacheWrite } = event
  const reported = [input, output, total, reasoning, cacheRead, cacheWrite]
  // Un `usage` vide ne vaut pas mieux que pas d'`usage` : OpenCode afficherait
  // « 0 token » pour un tour qu'il n'a pas su compter.
  if (reported.every((value) => value === undefined)) return undefined
  // Invariant documenté de `Usage` : `nonCached + cacheRead + cacheWrite = input`.
  // ACP ne le donne pas, on le déduit — avec `Math.max(0, …)` parce qu'un agent
  // qui annonce plus de tokens mis en cache que de tokens envoyés ne doit pas
  // produire un compteur négatif en aval.
  const nonCachedInputTokens =
    input === undefined ? undefined : Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0))
  return new Usage({
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
    ...(nonCachedInputTokens === undefined ? {} : { nonCachedInputTokens }),
  })
}

/** Rendu d'un plan en texte, pour le bloc de raisonnement (§4). */
const renderPlan = (entries: readonly PlanEntry[]): string =>
  entries
    .map((entry) => `Plan — [${entry.priority}] ${entry.content} (${entry.status})`)
    .join("\n")

/** Nom d'outil porté par un appel : jamais vide, sinon OpenCode ne sait pas quoi exécuter. */
const toolNameOf = (event: Extract<AcpEvent, { type: "tool" }>): string =>
  event.name !== "" ? event.name : event.title !== "" ? event.title : "tool"

/**
 * Traduit **un** `AcpEvent`.
 *
 * Fonction pure : mêmes entrées, même sortie, aucun état mutable partagé.
 *
 * ⚠️ ACP n'a pas d'événement « début de bloc » ni « fin de bloc » : un `text`
 * est un delta, rien de plus. L'ouverture est donc **dérivée** (`openText`
 * n'émet `text-start` que si aucun bloc n'est ouvert) et la fermeture est
 * **calculée** (`closeText` n'émet `text-end` que si un bloc est ouvert). Un
 * agent qui envoie un delta sans avoir « ouvert » ne peut pas nous mettre en
 * défaut, puisqu'il n'y a rien à ouvrir.
 */
export const reduce = (state: ReducerState, event: AcpEvent): Reduction => {
  const events: LLMEvent[] = []

  // Un événement terminal est le dernier : `@opencode/ai` rejette explicitement
  // tout événement qui suit « Provider emitted X after the terminal event ».
  if (state.terminal) return { state, events }

  let next = state

  /** Ouvre le step si nécessaire — la séquence commence **toujours** par là. */
  const ensureStep = (): void => {
    if (next.started) return
    events.push({ type: "step-start", index: next.step })
    next = { ...next, started: true }
  }

  /** Ferme le bloc de raisonnement s'il est ouvert. */
  const closeReasoning = (): void => {
    if (next.reasoning === null) return
    events.push({ type: "reasoning-end", id: next.reasoning })
    next = { ...next, reasoning: null }
  }

  /** Ferme le bloc de texte s'il est ouvert. */
  const closeText = (): void => {
    if (next.text === null) return
    events.push({ type: "text-end", id: next.text })
    next = { ...next, text: null }
  }

  /** Ferme tout bloc ouvert : un seul à la fois, l'ordre d'ouverture est respecté. */
  const closeBlocks = (): void => {
    closeReasoning()
    closeText()
  }

  /** Ouvre un bloc de texte, en refermant d'abord tout ce qui traîne. */
  const openText = (): void => {
    closeReasoning()
    if (next.text !== null) return
    const id = `text-${next.blocks}`
    events.push({ type: "text-start", id })
    next = { ...next, text: id, blocks: next.blocks + 1 }
  }

  /** Ouvre un bloc de raisonnement, en refermant d'abord tout ce qui traîne. */
  const openReasoning = (): void => {
    closeText()
    if (next.reasoning !== null) return
    const id = `reasoning-${next.blocks}`
    events.push({ type: "reasoning-start", id })
    next = { ...next, reasoning: id, blocks: next.blocks + 1 }
  }

  switch (event.type) {
    case "text": {
      if (event.text === "") return { state: next, events }
      ensureStep()
      openText()
      events.push({ type: "text-delta", id: next.text ?? "", text: event.text })
      return { state: next, events }
    }

    case "thought": {
      if (event.text === "") return { state: next, events }
      ensureStep()
      openReasoning()
      events.push({ type: "reasoning-delta", id: next.reasoning ?? "", text: event.text })
      return { state: next, events }
    }

    case "plan": {
      if (event.entries.length === 0) return { state: next, events }
      ensureStep()
      openReasoning()
      events.push({ type: "reasoning-delta", id: next.reasoning ?? "", text: renderPlan(event.entries) })
      return { state: next, events }
    }

    case "tool": {
      // ⚠️ ACP envoie **plusieurs** `AcpEvent` pour un seul appel
      // (`tool_call` puis `tool_call_update` en `in_progress`, puis en
      // `completed`). N'émettre qu'une fois est la seule façon de produire une
      // séquence valide — et c'est aussi le mode §7.3 : le provider **propose**,
      // OpenCode exécute, donc aucun `tool-result` n'est émis ici. Le résultat
      // reviendra au tour suivant, dans `request.messages`.
      if (next.tools.has(event.id)) return { state: next, events }
      ensureStep()
      closeBlocks()
      const name = toolNameOf(event)
      const input = event.input ?? {}
      events.push({ type: "tool-input-start", id: event.id, name })
      events.push({ type: "tool-input-delta", id: event.id, name, text: renderJson(input), input })
      events.push({ type: "tool-input-end", id: event.id, name })
      // ⚠️ **Pas** de `providerExecuted` : c'est ce qui fait qu'OpenCode exécute
      // l'outil pour de vrai (permissions, snapshots, undo, journalisation).
      events.push({ type: "tool-call", id: event.id, name, input })
      return { state: { ...next, tools: new Set([...next.tools, event.id]) }, events }
    }

    case "usage": {
      // La fenêtre de contexte n'est pas le coût du tour : la compter ici
      // afficherait un « tokens utilisés » qui baisse et remonte au fil de l'eau.
      if (event.kind === "context") return { state: next, events }
      const usage = toUsage(event)
      return { state: usage === undefined ? next : { ...next, usage }, events }
    }

    case "permission": {
      // §4 ne définit **aucun** `LLMEvent` pour une permission : la visibilité
      // côté utilisateur arrive en P4. On compte quand même, pour qu'un
      // diagnostic puisse dire « l'agent a demandé 3 permissions, toutes
      // refusées » sans rejouer le flux.
      return { state: { ...next, permissions: next.permissions + 1 }, events }
    }

    case "error": {
      ensureStep()
      closeBlocks()
      events.push({ type: "step-finish", index: next.step, reason: { normalized: "error" } })
      // `provider-error` **est** l'événement terminal du protocole (§4.0) : il
      // porte le message de l'agent jusqu'à l'interface, là où un
      // `finish{error}` l'aurait perdu. Le `done{cancelled}` qui suit dans le
      // flux ACP est alors ignoré (`terminal`).
      events.push({ type: "provider-error", message: event.message })
      return { state: { ...next, stepFinished: true, terminal: true }, events }
    }

    case "done": {
      ensureStep()
      closeBlocks()
      const reason = { normalized: finishReasonOf(next, event.stopReason) } as const
      const usage = next.usage
      events.push({
        type: "step-finish",
        index: next.step,
        reason,
        ...(usage === undefined ? {} : { usage }),
      })
      events.push({
        type: "finish",
        reason,
        ...(usage === undefined ? {} : { usage }),
      })
      return {
        state: { ...next, stepFinished: true, finished: true, terminal: true },
        events,
      }
    }
  }
}

/**
 * Flush de fin de flux — appelé par `onHalt`.
 *
 * ⚠️ C'est la **seule** garantie qu'un flux interrompu, tronqué ou totalement
 * vide ne produise pas « The provider response ended unexpectedly. » : le core
 * exige un événement terminal, et il n'y a pas d'autre endroit où l'émettre.
 * Un état déjà terminal renvoie la liste vide, donc `onHalt` est sans effet après
 * un `done` normal.
 */
export const halt = (state: ReducerState): Reduction => {
  if (state.terminal) return { state, events: [] }
  const events: LLMEvent[] = []
  let next = state
  if (!next.started) {
    events.push({ type: "step-start", index: next.step })
    next = { ...next, started: true }
  }
  if (next.reasoning !== null) {
    events.push({ type: "reasoning-end", id: next.reasoning })
    next = { ...next, reasoning: null }
  }
  if (next.text !== null) {
    events.push({ type: "text-end", id: next.text })
    next = { ...next, text: null }
  }
  const reason = { normalized: haltReason(next) } as const
  const usage = next.usage
  events.push({
    type: "step-finish",
    index: next.step,
    reason,
    ...(usage === undefined ? {} : { usage }),
  })
  events.push({
    type: "finish",
    reason,
    ...(usage === undefined ? {} : { usage }),
  })
  return { state: { ...next, stepFinished: true, finished: true, terminal: true }, events }
}

// ─────────────────────────────────────────────────────────────────────────────
// `LLMRequest` → `NormalizedRequest`
// ─────────────────────────────────────────────────────────────────────────────

/** Nom d'un outil, namespaces aplatis comme le fait `flattenTools` de `@opencode/ai`. */
const NAMESPACED_SEPARATOR = "_"

const flatToolName = (namespace: string | undefined, name: string): string =>
  namespace === undefined ? name : `${namespace}${NAMESPACED_SEPARATOR}${name}`

/**
 * Un bloc de contenu textuel, sans `as` : le prédicat **est** le rétrécissement,
 * et l'opérateur `in` de TypeScript suffit à rendre `block.type` lisible.
 */
const isTextBlock = (block: unknown): block is { readonly type: "text"; readonly text: string } =>
  typeof block === "object" &&
  block !== null &&
  "type" in block &&
  block.type === "text" &&
  "text" in block &&
  typeof block.text === "string"

/**
 * Rendu d'un résultat d'outil pour le transcript.
 *
 * `content` est le cas le plus fréquent côté OpenCode (un `read` renvoie des
 * blocs de texte) : le sérialiser en JSON enfermerait la réponse de l'outil dans
 * des accolades, ce que l'agent lirait comme du bruit.
 */
const renderToolResult = (result: { readonly type: string; readonly value: unknown }): string => {
  switch (result.type) {
    case "text":
      return renderJson(result.value)
    case "content": {
      const blocks = Array.isArray(result.value) ? result.value.filter(isTextBlock) : []
      return blocks.length > 0 ? blocks.map((block) => block.text).join("\n") : renderJson(result.value)
    }
    case "error":
      return `erreur : ${renderJson(result.value)}`
    default:
      return renderJson(result.value)
  }
}

/** Rendu d'un appel d'outil **du transcript** : ce que l'agent avait proposé au tour précédent. */
const renderToolCall = (name: string, input: unknown): string =>
  `Appel d'outil ${name} : ${renderJson(input)}`

/** Un outil du catalogue, namespace aplati. */
const flattenTools = (tools: LLMRequest["tools"]): { name: string; description: string; schema: unknown }[] =>
  tools.flatMap((entry) => {
    if (entry.type === "namespace") {
      return entry.tools
        .filter((inner): inner is Exclude<typeof inner, { type: "namespace" }> => inner.type !== "namespace")
        .map((inner) => ({
          name: flatToolName(entry.name, inner.name),
          description: inner.description,
          schema: inner.inputSchema,
        }))
    }
    return [{ name: entry.name, description: entry.description, schema: entry.inputSchema }]
  })

/** Un message du transcript, texte accumulé (parties `text` et `tool-call` confondues). */
interface Textual {
  readonly role: "user" | "assistant"
  readonly parts: string[]
}

/**
 * `LLMRequest` → `NormalizedRequest`.
 *
 * Le cœur du projet (prompt, contrat de sortie, politique) ne connaît que cette
 * forme : c'est ce qui permet à l'adaptateur HTTP (§ P7) de réutiliser
 * exactement le même rendu de prompt.
 */
export const fromRequest = (
  request: LLMRequest,
  settings: AcpProviderSettings,
): Effect.Effect<AcpBody, AIError> => {
  const system: string[] = []
  for (const part of request.system) {
    if (part.text !== "") system.push(part.text)
  }
  // Le suffixe vient **après** le système d'OpenCode : c'est lui qui porte le
  // contrat de sortie (§7.3), et il doit fermer le prompt, pas s'y mêler.
  if (settings.systemSuffix !== undefined && settings.systemSuffix !== "") {
    system.push(settings.systemSuffix)
  }

  const messages: NormalizedMessage[] = []
  for (const message of request.messages) {
    switch (message.role) {
      case "system": {
        // Un message de rôle `system` en cours de conversation est une
        // instruction opérateur : elle appartient au système, pas au transcript.
        const text = message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n")
          .trim()
        if (text !== "") system.push(text)
        break
      }

      case "user":
      case "assistant": {
        const textual: Textual = { role: message.role, parts: [] }
        for (const part of message.content) {
          if (part.type === "text") {
            if (part.text !== "") textual.parts.push(part.text)
          } else if (part.type === "tool-call") {
            // Un `tool-call` d'un tour précédent **est** une instruction : sans
            // lui, l'agent ne sait pas ce qu'il avait proposé et ne peut pas
            // continuer (§7.3).
            textual.parts.push(renderToolCall(flatToolName(part.namespace, part.name), part.input))
          }
          // `reasoning`, `media` et `compaction` sont volontairement ignorés :
          // le raisonnement d'un tour passé est un artefact de rendu, pas une
          // instruction, et le renvoyer coûte des tokens sans rien apporter.
        }
        const text = textual.parts.join("\n").trim()
        if (text !== "") messages.push({ role: textual.role, text })
        break
      }

      case "tool": {
        for (const part of message.content) {
          if (part.type !== "tool-result") continue
          messages.push({
            role: "tool",
            // ⚠️ `id` **verbatim** (§2.1) : c'est l'agent ACP qui a synthétisé
            // cet identifiant au tour N, et c'est lui qui doit le reconnaître au
            // tour N+1. Le réécrire casseraient le round-trip de tout le
            // mécanisme §7.3.
            id: part.id,
            name: flatToolName(part.namespace, part.name),
            output: renderToolResult(part.result),
          })
        }
        break
      }
    }
  }

  const normalized: NormalizedRequest = {
    system,
    tools: flattenTools(request.tools),
    messages,
    ...(request.generation?.maxTokens === undefined
      ? {}
      : { maxOutputTokens: request.generation.maxTokens }),
  }

  return Effect.succeed({ model: String(request.model.id), request: normalized })
}

// ─────────────────────────────────────────────────────────────────────────────
// Le `Protocol`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construit le protocole de la route.
 *
 * ⚠️ Il est une **fonction** et non une constante : `body.from` dépend des
 * settings (le `systemSuffix`), alors que le `Protocol` de `@opencode/ai` est
 * construit une fois pour toutes dans `Route.make`. Comme la route elle-même est
 * reconstruite à chaque appel à `model()`, la cohérence est garantie par la
 * construction, pas par une convention.
 */
export const makeProtocol = (settings: AcpProviderSettings): Protocol<
  AcpBody,
  string,
  AcpFrame,
  ReducerState
> =>
  Protocol.make({
    id: PROTOCOL_ID,
    body: {
      schema: bodySchema,
      from: (request) => fromRequest(request, settings),
    },
    stream: {
      event: frameSchema,
      initial: () => initialState,
      step: (state, frame) => {
        const { state: next, events } = reduce(state, frame.ev)
        return Effect.succeed([next, events] as const)
      },
      // Le flush final : comble le `step-finish` / `finish` manquants (§4.0).
      onHalt: (state) => Effect.succeed(halt(state).events),
    },
  })
