/**
 * A.1 — Fidélité de la reconstruction du prompt (§14.2).
 *
 * Le tour de recette rapporte `tokens=2/24` là où l'agent, appelé directement,
 * déclare ~15 000 tokens d'entrée. Deux explications sont possibles, et le plan
 * tranche pour la seconde : « l'agent ne compte que le non mis en cache »
 * (explication bénigne) **ou** « notre reconstruction de `LLMRequest` perd le
 * system prompt, les outils ou le transcript » (bug grave, invisible sur une
 * réponse courte).
 *
 * **Verdict, mesuré sur `copilot --acp` v1.0.88** : aucune perte. Le relevé
 * réel est `input=25811 cacheWrite=25809 nonCached=2` avec un prompt minimal, et
 * `input=36002 cacheWrite=22434 nonCached=2` avec ~4 000 tokens de plus dans le
 * système : `input` **croît** exactement de ce qu'on ajoute au prompt, et le
 * `2` ne bouge pas. C'est donc `2` qu'OpenCode affiche comme entrée — le reste
 * est du `cacheWrite`, que l'agent paie une fois et qu'OpenCode ne compte pas
 * comme tokens d'entrée du tour. Voir `describe("usage")` plus bas, qui verrouille
 * ce décodage.
 *
 * Ce fichier ne se contente pas du raisonnement : il apporte la **preuve**.
 *
 * 1. `renderRequest` est **pure** : on peut comparer son résultat caractère par
 *    caractère, sans agent. C'est ce qui prouve l'ordre, l'unicité et l'absence
 *    de troncature.
 * 2. `FAKE_PROMPT_FILE` fait déposer au faux agent le prompt **exactement tel
 *    qu'il l'a reçu sur le fil** (`test/fake-acp.ts`). On rejoue une requête
 *    `LLMRequest` réaliste — système multi-parties, trois outils avec schémas
 *    JSON, transcript avec appel et résultat d'outil — et on vérifie que ce qui
 *    est arrivé à l'agent est exactement ce que `fromRequest` + `renderRequest`
 *    ont produit. Rien de plus, rien de moins.
 *
 * ⚠️ Pourquoi ne pas se contenter de l'écho « ACK: <prompt> » du faux agent,
 * déjà couvert ailleurs : cet écho passe par le **contrat de sortie** et son
 * extracteur tolérant. Un prompt tronqué au milieu d'une accolade resterait
 * « valide » côté extraction, et le test passerait sur une régression réelle.
 * Ici on compare au niveau des octets, avant toute interprétation.
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

/** Doit rester synchronisé avec `PROMPT_SEPARATOR` de `test/fake-acp.ts`. */
const SEPARATOR = "-----8<-- PROMPT REÇU --8<-----"

afterAll(async () => {
  await closeCachedAgents()
})

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────────────────────────────────────

/** Le transport ACP ne fait jamais de HTTP : l'exécuteur doit donc mourir bruyamment. */
const NO_HTTP = { http: { execute: () => Effect.die("le transport ACP ne fait pas de HTTP") } }

/** Settings du faux agent ; échoue bruyamment si la validation se trompe. */
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

/** Nombre d'occurrences **non chevauchantes** de `needle` dans `haystack`. */
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

/** Index de la première occurrence, ou une erreur nommant l'extrait manquant. */
const indexOfOrFail = (prompt: string, needle: string, what: string): number => {
  const at = prompt.indexOf(needle)
  if (at === -1) {
    throw new Error(`${what} est absent du prompt : ${JSON.stringify(needle)}`)
  }
  return at
}

// ─────────────────────────────────────────────────────────────────────────────
// Le jeu de données de référence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trois outils aux formes volontairement différentes.
 *
 * ⚠️ Un `enum` dans le deuxième et un objet imbriqué dans le troisième : ce sont
 * les deux formes dont la sérialisation casse le plus facilement (un `enum` mal
 * fermé, une clé `undefined` supprimée par `JSON.stringify`), donc les deux
 * premières choses à vérifier.
 */
const TOOLS: readonly NormalizedTool[] = [
  {
    name: "read",
    description: "Lit un fichier du projet",
    schema: {
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
    },
  },
  {
    name: "grep",
    description: "Cherche un motif dans le dépôt",
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
    description: "Remplace un morceau de fichier",
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

/** Les mêmes trois outils en `ToolEntry` : c'est la forme que reçoit l'adaptateur. */
const TOOL_ENTRIES = [
  ToolEntry.make({
    name: "read",
    description: "Lit un fichier du projet",
    inputSchema: TOOLS[0]?.schema as Record<string, unknown>,
  }),
  ToolEntry.make({
    name: "grep",
    description: "Cherche un motif dans le dépôt",
    inputSchema: TOOLS[1]?.schema as Record<string, unknown>,
  }),
  ToolEntry.make({
    name: "edit",
    description: "Remplace un morceau de fichier",
    inputSchema: TOOLS[2]?.schema as Record<string, unknown>,
  }),
]

/** Les parties système, volontairement **multiples** : c'est le cas réel d'OpenCode. */
const SYSTEM_PARTS = [
  "Tu es un assistant de programmation.",
  "AGENTS.md : on ne modifie jamais un fichier généré.",
  "Réponds en français, sans préambule.",
]

/** Le transcript de référence : un appel d'outil, son résultat, puis une relance. */
const MESSAGES: readonly NormalizedMessage[] = [
  { role: "user", text: "révise le fichier config.json" },
  { role: "assistant", text: 'Appel d\'outil read : {"filePath":"config.json"}' },
  { role: "tool", id: "call-1", name: "read", output: '{ "port": 4096 }' },
  { role: "user", text: "et le port ?" },
]

/**
 * La requête normalisée de référence.
 *
 * ⚠️ Elle est écrite **à la main**, indépendamment de `fromRequest` : c'est ce qui
 * donne tout son sens à l'égalité de caractères plus bas. Si l'adaptateur
 * invente, perd ou déplace quoi que ce soit, l'égalité échoue — et l'échec nomme
 * la section concernée.
 */
const NORMALIZED: NormalizedRequest = {
  system: SYSTEM_PARTS,
  tools: TOOLS,
  messages: MESSAGES,
  maxOutputTokens: 512,
}

/** Construit la `LLMRequest` réaliste qui sert de référence. */
const buildRequest = (languageModel: LanguageModel, tools: LLMRequest["tools"] = TOOL_ENTRIES): LLMRequest =>
  new LLMRequest({
    model: languageModel,
    system: SYSTEM_PARTS.map((text) => SystemPart.make(text)),
    tools: [...tools],
    messages: [
      Message.user("révise le fichier config.json"),
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
      Message.user("et le port ?"),
    ],
    generation: GenerationOptions.make({ maxTokens: 512 }),
  })

/**
 * La requête normalisée produite par l'adaptateur, sans passer par le réseau.
 *
 * ⚠️ Le `LanguageModel` n'est **pas** un paramètre : `fromRequest` n'a besoin que
 * de la requête, et l'y lier rendrait chaque appel inutilement dépendant d'une
 * route construite pour l'occasion.
 */
const normalizedOf = (request: LLMRequest): NormalizedRequest =>
  Effect.runSync(fromRequest(request, fakeSettings())).request

// ─────────────────────────────────────────────────────────────────────────────
// Les invariants de rendu
// ─────────────────────────────────────────────────────────────────────────────

/** Les cinq sections attendues, dans cet ordre (§7.3). */
const SECTION_ORDER = [
  "## Rôle",
  "## Instructions système",
  "## Outils disponibles",
  "## Conversation",
  "## Format de sortie — impératif",
] as const

/** La dernière ligne du contrat : le prompt doit s'y terminer. */
const LAST_RULE =
  "- N'appelle aucun outil natif : tu n'en as aucun, et toute tentative serait rejetée."

/**
 * Les invariants de rendu, appliqués à n'importe quel prompt.
 *
 * Fonction **pure** : c'est ce qui permet de la faire tourner aussi bien sur le
 * rendu local que sur le prompt réellement reçu par l'agent. Une régression qui
 * perdrait le système, dupliquerait un outil ou tronquerait la fin échouerait ici.
 */
const assertIntact = (prompt: string): void => {
  // 1. Les cinq sections sont présentes, une fois chacune, **dans l'ordre**.
  const positions = SECTION_ORDER.map((header) =>
    indexOfOrFail(prompt, header, `la section « ${header} »`),
  )
  for (let i = 1; i < positions.length; i += 1) {
    const previous = positions[i - 1] ?? 0
    const current = positions[i] ?? 0
    if (current <= previous) {
      throw new Error(
        `ordre des sections cassé : « ${SECTION_ORDER[i - 1]} » avant « ${SECTION_ORDER[i]} »`,
      )
    }
  }
  for (const header of SECTION_ORDER) {
    expect(countOf(prompt, header)).toBe(1)
  }

  // 2. Chaque partie système est là, **une fois**, et dans l'ordre de la requête.
  let previous = -1
  for (const part of SYSTEM_PARTS) {
    const at = indexOfOrFail(prompt, part, "une partie système")
    if (at <= previous) throw new Error(`partie système hors ordre : ${part}`)
    previous = at
    expect(countOf(prompt, part)).toBe(1)
  }

  // 3. Chaque outil est là avec son **schéma sérialisé** — la preuve qu'aucun
  //    outil n'a été réduit à son nom, ni à un `{}` de repli.
  const toolsAt = positions[2] ?? 0
  const conversationAt = positions[3] ?? Number.MAX_SAFE_INTEGER
  for (const tool of TOOLS) {
    const heading = indexOfOrFail(prompt, `### ${tool.name}\n`, `l'outil « ${tool.name} »`)
    expect(countOf(prompt, `### ${tool.name}\n`)).toBe(1)
    expect(heading).toBeGreaterThan(toolsAt)
    expect(heading).toBeLessThan(conversationAt)
    expect(prompt).toContain(tool.description)
    const schema = JSON.stringify(tool.schema)
    expect(prompt).toContain(schema)
    // Le schéma est rendu **une seule** fois : ni perdu, ni dupliqué.
    expect(countOf(prompt, schema)).toBe(1)
  }

  // 4. Chaque message est là avec son rôle, une fois, dans l'ordre.
  const lines: readonly string[] = [
    "Utilisateur : révise le fichier config.json",
    'Assistant : Appel d\'outil read : {"filePath":"config.json"}',
    'Outil read : { "port": 4096 }',
    "Utilisateur : et le port ?",
  ]
  previous = -1
  for (const line of lines) {
    const at = indexOfOrFail(prompt, line, "un message du transcript")
    if (at <= previous) throw new Error(`message hors ordre : ${line}`)
    previous = at
    expect(countOf(prompt, line)).toBe(1)
  }

  // 5. Rien n'est tronqué : le contrat de sortie **ferme** le prompt, et sa
  //    dernière ligne est bien la dernière du prompt.
  expect(prompt.endsWith(LAST_RULE)).toBe(true)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Le rendu pur
// ─────────────────────────────────────────────────────────────────────────────

describe("renderRequest : rien ne se perd, rien ne se duplique", () => {
  const prompt = renderRequest(NORMALIZED)

  test("système, outils, transcript et contrat sont intacts et ordonnés", () => {
    assertIntact(prompt)
  })

  test("le rendu est déterministe", () => {
    // Une fonction pure rend le test reproductible : deux rendus de la même
    // requête sont identiques, caractère pour caractère.
    expect(renderRequest(NORMALIZED)).toBe(prompt)
  })

  test("un outil sans schéma n'invente pas de JSON", () => {
    // Le repli doit rester **lisible** : « undefined » ou une exception
    // construiraient un prompt qui ne dit rien à l'agent.
    const rendered = renderRequest({
      system: [],
      tools: [{ name: "mystere", description: "", schema: undefined }],
      messages: [{ role: "user", text: "test" }],
    })
    expect(rendered).toContain("### mystere")
    expect(rendered).toContain("aucun schéma")
    expect(rendered).not.toContain("undefined")
  })

  test("un transcript vide et un catalogue vide ne mentent pas", () => {
    const rendered = renderRequest({ system: [], tools: [], messages: [] })
    expect(rendered).toContain("(aucun outil n'est disponible pour cette requête)")
    expect(rendered).toContain("(aucun message précédent)")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. `fromRequest` : la reconstruction depuis la vraie `LLMRequest`
// ─────────────────────────────────────────────────────────────────────────────

describe("fromRequest : la reconstruction est complète", () => {
  test("système, outils et transcript sont intégralement repris", () => {
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    const normalized = normalizedOf(buildRequest(languageModel))

    expect(normalized.system).toEqual(SYSTEM_PARTS)
    expect(normalized.messages).toEqual(MESSAGES)
    expect(normalized.maxOutputTokens).toBe(512)
    // Les trois outils, et **seulement** eux : un outil perdu ici est un outil
    // que l'agent ne pourra jamais proposer (§7.3).
    expect(normalized.tools.map((t) => t.name)).toEqual(["read", "grep", "edit"])
    for (const tool of normalized.tools) {
      const reference = TOOLS.find((entry) => entry.name === tool.name)
      if (reference === undefined) throw new Error(`outil inattendu : ${tool.name}`)
      expect(tool.description).toBe(reference.description)
      // ⚠️ Le schéma est comparé **après re-sérialisation** : c'est la forme qui
      // part sur le fil, et c'est elle que l'agent va lire.
      expect(JSON.stringify(tool.schema)).toBe(JSON.stringify(reference.schema))
    }
    // Un outil de premier niveau n'a pas d'namespace : en inventer un ferait
    // porter un `namespace` vide au `tool-call`.
    expect(normalized.tools.every((tool) => tool.namespace === undefined)).toBe(true)
  })

  test("le prompt de bout en bout est exactement celui du rendu pur", () => {
    // ⚠️ Le test qui tranche la question du §14.2. Si `fromRequest` perdait une
    // partie système, un outil, un message ou son rôle, l'égalité échouerait ici.
    const settings = fakeSettings()
    const languageModel = model("gpt-5.6-terra", settings)
    const normalized = normalizedOf(buildRequest(languageModel))
    assertIntact(renderRequest(normalized))
  })

  test("une instruction opérateur en cours de conversation rejoint le système", () => {
    // `Message.system` est une instruction d'opérateur : ACP n'a pas de champ
    // « system », donc elle doit atterrir dans la section système, pas dans le
    // transcript — sinon l'agent la prendrait pour une phrase d'un tour passé.
    const languageModel = model("gpt-5.6-terra", fakeSettings())
    const request = new LLMRequest({
      model: languageModel,
      system: [SystemPart.make("Système de base.")],
      tools: [],
      messages: [
        Message.user("premier"),
        Message.system("Rappel : ne jamais écraser un fichier verrouillé."),
        Message.user("deuxième"),
      ],
    })
    const body = Effect.runSync(fromRequest(request, fakeSettings()))
    expect(body.request.system).toEqual([
      "Système de base.",
      "Rappel : ne jamais écraser un fichier verrouillé.",
    ])
    expect(body.request.messages).toEqual([
      { role: "user", text: "premier" },
      { role: "user", text: "deuxième" },
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Le prompt **réellement reçu** par l'agent
// ─────────────────────────────────────────────────────────────────────────────

describe("le prompt reçu sur le fil est byte pour byte le prompt rendu", () => {
  const temporary: string[] = []

  const temporaryDirectory = async (label: string): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), `acp-prompt-${label}-`))
    temporary.push(directory)
    return join(directory, "prompt.txt")
  }

  afterAll(async () => {
    await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("un tour complet ne perd ni système, ni outil, ni transcript", async () => {
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

    // On lit **le fichier** : c'est la seule source qui dit ce qui est vraiment
    // arrivé au sous-processus, et non ce que notre code croit lui avoir envoyé.
    const raw = await readFile(promptFile, "utf8")
    expect(raw.startsWith(`${SEPARATOR}\n`)).toBe(true)
    const received = raw.slice(`${SEPARATOR}\n`.length).replace(/\n$/, "")

    // 1. L'agent a reçu un prompt exploitable, section par section.
    assertIntact(received)

    // 2. Et il est **identique** à ce que le cœur produit pour cette requête :
    //    aucune perte, aucun ajout, aucun déplacement.
    const normalized = normalizedOf(buildRequest(languageModel))
    expect(received).toBe(renderRequest(normalized))

    // 3. Le tour, lui, s'est bien terminé normalement : la capture ne doit pas
    //    avoir perturbé le protocole.
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

  test("le prompt est plus long quand la requête est plus riche", async () => {
    // Le contre-sens de la question « perd-il des choses ? » : un prompt qui
    // rétrécit quand on ajoute une instruction serait la preuve d'une
    // troncature. On mesure donc **la taille** du fichier déposé par l'agent.
    const rich = await temporaryDirectory("rich")
    const poor = await temporaryDirectory("poor")
    const extra = "Règle supplémentaire : ne cite jamais un fichier que tu n'as pas lu."

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
        messages: [Message.user("bonjour")],
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
    // L'écart vaut exactement la ligne ajoutée : rien n'a été normalisé, rien n'a
    // été absorbé, et le prompt n'est pas plafonné.
    expect(richPrompt.length).toBe(poorPrompt.length + extra.length + 2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Le `tokens=2/24` de la recette : le décodage des compteurs
// ─────────────────────────────────────────────────────────────────────────────

describe("usage : pourquoi la recette affiche 2/24", () => {
  /**
   * Rejoue le réducteur et renvoie l'`usage` de fin de tour.
   *
   * On passe par le réducteur — et non par un objet littéral — parce que c'est
   * lui qui construit la classe `Usage` du core (§4.0), et c'est donc lui que
   * OpenCode lit pour afficher ses compteurs.
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
    if (finish?.type !== "finish") throw new Error("aucun finish")
    return finish.usage
  }

  test("les ~26 000 tokens entrants ne sont pas perdus : ils sont du cacheWrite", () => {
    // ⚠️ **Relevé réel sur `copilot --acp`** (sonde `verify-real`, §14.2) :
    //   `input=25811 output=50 cacheWrite=25809` avec un prompt minimal, et
    //   `input=36002 cacheWrite=22434` avec ~4 000 tokens de système en plus.
    // Deux constats, et c'est le second qui tranche la question du §14.2 :
    //
    //   1. `inputTokens` porte bien la totalité des tokens reçus — il **croît**
    //      de ce qu'on ajoute au prompt, donc le prompt n'est pas perdu ;
    //   2. le `2` affiché par l'interface est `nonCachedInputTokens`, le reste
    //      étant du `cacheWrite` que l'agent paie une fois.
    const usage = usageOf(25_811, 50, 25_809)
    expect(usage?.inputTokens).toBe(25_811)
    expect(usage?.cacheWriteInputTokens).toBe(25_809)
    expect(usage?.outputTokens).toBe(50)
    // Le « 2 » de `tokens=2/24` : l'input non mis en cache.
    expect(usage?.nonCachedInputTokens).toBe(2)
  })

  test("un agent qui ne déclare aucun cache n'est pas touché par le décodage", () => {
    // Le calcul ne doit rien changer pour un agent qui ne fait pas de cache :
    // c'est le cas de la plupart des agents ACP locaux.
    const usage = usageOf(1_500, 24, 0)
    expect(usage?.nonCachedInputTokens).toBe(1_500)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Outils namespacés : la seule perte trouvée (§A.1)
// ─────────────────────────────────────────────────────────────────────────────

describe("outils namespacés : le nom aplati ne suffit pas à l'exécution", () => {
  /** Deux outils dans un namespace, plus un outil de premier niveau. */
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

  test("le prompt demande le nom aplati, convention de @opencode/ai", () => {
    const languageModel = model("gpt-5.6-terra", fakeSettings())
    const normalized = normalizedOf(buildRequest(languageModel, namespaced))
    expect(normalized.tools.map((t) => t.name)).toEqual(["read", "search_grep"])
    // Le point serait plus lisible, mais `@opencode/ai` refuse `.` dans les noms
    // d'outils chez la plupart des fournisseurs (« not broadly accepted in
    // provider tool names ») : c'est donc `_`, partout, sans exception.
    expect(renderRequest(normalized)).toContain("### search_grep")
  })

  test("le tool-call porte le namespace, sinon le runtime ne retrouve pas l'outil", () => {
    // ⚠️ **La perte trouvée par l'enquête.** `ToolRuntime.dispatch` de
    // `@opencode/ai` indexe son registre par `namespace.nom` ; le cœur
    // d'OpenCode fait de même (`tools.set(nom_avec_points, outil)`). Un
    // `tool-call` qui ne porterait que `search_grep` échouerait avec « No tool
    // named "search_grep" is currently available » — l'appel serait perdu, et
    // « l'agent aurait **proposé** un outil inexistant »
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
    // Et `halt` reste sans effet : le `tool-call` est déjà sorti, exactement une fois.
    expect(halt(state).events).toEqual([])
  })

  test("un outil de premier niveau n'invente pas de namespace", () => {
    // Sans ce test, ajouter `namespace: ""` par défaut ferait porter un namespace
    // vide au `tool-call` — et le runtime chercherait `"." + nom`.
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
