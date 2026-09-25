/**
 * Lecture de la sortie d'un agent ACP — PLAN.md §7.3.
 *
 * Ce module fait l'autre moitié du « pont à sortie structurée » : `core/prompt.ts`
 * écrit le contrat, ce fichier le relit. Les deux sont **purs** et n'importent que
 * du local — c'est la condition pour que l'adaptateur HTTP (`adapters/openai-http`,
 * P7) puisse réutiliser exactement le même cœur sans tirer `@opencode/ai` dans son
 * graphe (§2.1 / §2.2).
 *
 * ⚠️ **Pourquoi valider le fond, et pas seulement la forme.** Les essais réels
 * (16/16 conformes sur `copilot --acp`) ont montré un cas limite : un agent peut
 * produire un JSON parfaitement valide et sémantiquement vide — typiquement
 * `{"type":"text","text":""}`, c'est-à-dire l'objet d'exemple recopié tel quel.
 * Un parseur qui se contente de vérifier « c'est du JSON » laisserait passer ce
 * cas et produirait un tour vide : l'utilisateur verrait l'agent « répondre » sans
 * jamais rien obtenir. D'où les deux règles de fond :
 *
 * 1. `type:"text"` exige une chaîne **non vide** ;
 * 2. `type:"tool"` exige un nom **exactement** présent dans le catalogue.
 *
 * ⚠️ **Pourquoi ne pas dégrader un nom inconnu en texte.** Si l'agent propose un
 * outil qui n'existe pas, c'est une hallucination : l'afficher comme du texte
 * ferait croire à l'utilisateur que l'agent a répondu normalement, alors que le
 * travail qu'il voulait faire est perdu. On échoue donc en nommant l'outillage
 * fautif **et** les noms acceptés — exactement comme le fait déjà le transport
 * pour un modèle que l'agent ne propose pas (`applyModel`).
 */

import type { NormalizedTool } from "./types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Résultat
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Échec de lecture, toujours porteur d'un **extrait de la sortie brute**.
 *
 * Un extrait borné, et non la sortie entière : une réponse d'agent qui dérape
 * peut faire des dizaines de kilo-octets, et noyer un message d'erreur dans le
 * transcript rendrait le diagnostic plus difficile que l'erreur qu'il décrit.
 */
export class ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ParseError"
  }
}

/** La réponse de l'agent, une fois le contrat de sortie validé. */
export type AgentOutput =
  /** Une réponse en texte : `text-start` / `text-delta` / `text-end`. */
  | { readonly type: "text"; readonly text: string }
  /**
   * Une demande d'appel d'outil : `tool-input-*` puis `tool-call` **sans**
   * `tool-result`, pour qu'OpenCode l'exécute réellement (§7.3).
   */
  | {
      readonly type: "tool"
      readonly name: string
      readonly arguments: Readonly<Record<string, unknown>>
    }

/** Résultat de lecture : jamais une exception, pour que l'appelant reste total. */
export type ParseResult =
  | { readonly ok: true; readonly output: AgentOutput }
  | { readonly ok: false; readonly error: ParseError }

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un objet JSON « nu » — ni tableau, ni `null`.
 *
 * ⚠️ Le refus explicite des **tableaux** est ce qui distingue « arguments mal
 * typés » de « arguments valides » : `Array.isArray` renvoie `true` pour un
 * tableau, et un tableau passé comme entrée d'outil produirait une erreur
 * opaque au moment de l'exécution, bien après le relecteur.
 */
export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Longueur maximale de l'extrait de sortie brute joint à une erreur. */
const MAX_EXCERPT = 400

/** Extrait borné et compact d'une sortie, pour un message d'erreur lisible. */
const excerpt = (raw: string): string => {
  const flat = raw.replace(/\s+/g, " ").trim()
  if (flat === "") return "(sortie vide)"
  return flat.length <= MAX_EXCERPT ? flat : `${flat.slice(0, MAX_EXCERPT)}…`
}

/** Construit un échec, toujours avec la sortie brute sous les yeux. */
const fail = (raw: string, reason: string): ParseResult => ({
  ok: false,
  error: new ParseError(`${reason} — sortie reçue : « ${excerpt(raw)} »`),
})

/** Décrit une valeur pour un message d'erreur (« un tableau », « null »…). */
const describe = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "un tableau"
  return `une valeur de type ${typeof value}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction du JSON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Index du `}` qui referme le `{` d'`start`, ou -1.
 *
 * ⚠️ C'est ici que se joue le piège classique de l'extraction « premier `{` puis
 * premier `}` » : un agent qui répond `{"type":"text","text":"voici {une} accolade"}`
 * verrait son objet coupé en deux et l'extraction échouerait. D'où le suivi des
 * **chaînes** et des **échappements** : un `}` dans une chaîne ne referme rien.
 */
const closingBrace = (raw: string, start: number): number => {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Tous les objets JSON **équilibrés** enchâssés dans un texte, dans l'ordre. */
const embeddedObjects = (raw: string): string[] => {
  const found: string[] = []
  let index = 0
  while (index < raw.length) {
    if (raw[index] !== "{") {
      index += 1
      continue
    }
    const end = closingBrace(raw, index)
    if (end === -1) {
      // Un `{` non fermé ne peut pas cacher d'objet : on avance d'un cran.
      index += 1
      continue
    }
    found.push(raw.slice(index, end + 1))
    // On **reprend après** l'objet fermé : deux objets côte à côte ne doivent pas
    // être confondus en un seul candidat imbriqué.
    index = end + 1
  }
  return found
}

/** Contenu des blocs ```` ```…``` ````, avec ou sans indication de langage. */
const fencedBlocks = (raw: string): string[] => {
  const found: string[] = []
  for (const match of raw.matchAll(/```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n?([\s\S]*?)```/g)) {
    const body = match[1]
    if (body !== undefined && body.trim() !== "") found.push(body.trim())
  }
  return found
}

/**
 * Candidats, du plus probable au plus improbable.
 *
 * L'ordre encode la tolérance attendue, du cas le plus net au plus bricolé :
 * la sortie brute entière, puis les blocs ```` ``` ```` (ce que produisent la
 * plupart des agents quand on leur demande du JSON), puis les objets équilibrés
 * enchâssés dans du texte (« Voici ma réponse : {...} »).
 */
const candidates = (raw: string): string[] => {
  const trimmed = raw.trim()
  const ordered = [trimmed, ...fencedBlocks(trimmed), ...embeddedObjects(trimmed)]
  const unique: string[] = []
  for (const candidate of ordered) {
    if (candidate === "" || unique.includes(candidate)) continue
    unique.push(candidate)
  }
  return unique
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation du fond
// ─────────────────────────────────────────────────────────────────────────────

/** Catalogue d'outils, rendu en une liste de noms pour un message d'erreur. */
const catalogNames = (tools: readonly NormalizedTool[]): string =>
  tools.length === 0
    ? "(aucun — la requête ne portait aucun outil)"
    : tools.map((tool) => tool.name).join(", ")

/**
 * Validation d'un objet **déjà** reconnu comme porteur d'un `type` connu.
 *
 * C'est le cœur de la lecture : la forme a été vérifiée, le fond reste à
 * contrôler. Aucun `arguments` n'est validé contre le JSON schema — OpenCode le
 * fera à l'exécution, et reimplémenter une validation de schema ici donnerait
 * deux Definitions de la vérité pour la même entrée.
 */
const validate = (
  value: Record<string, unknown>,
  type: "text" | "tool",
  tools: readonly NormalizedTool[],
  raw: string,
): ParseResult => {
  if (type === "text") {
    const text = value["text"]
    // ⚠️ Une réponse vide est une **erreur**, pas un texte vide silencieux : c'est
    // le cas limite observé en réel (« JSON valide mais vide de sens »).
    if (typeof text !== "string" || text.trim() === "") {
      return fail(
        raw,
        `l'objet {"type":"text"} ne porte aucun texte exploitable (champ « text » absent, vide ou non textuel)`,
      )
    }
    return { ok: true, output: { type: "text", text } }
  }

  const name = value["name"]
  if (typeof name !== "string" || name === "") {
    return fail(raw, `l'objet {"type":"tool"} ne nomme aucun outil (champ « name » absent ou vide)`)
  }
  if (!tools.some((tool) => tool.name === name)) {
    return fail(
      raw,
      `l'agent a proposé l'outil « ${name} », qui ne fait pas partie du catalogue ` +
        `(noms acceptés : ${catalogNames(tools)})`,
    )
  }

  const args = value["arguments"]
  // ⚠️ `arguments` **absent** n'est pas une erreur : un outil sans paramètre
  // (ou dont l'agent n'a rien à passer) mérite un objet vide, pas un tour
  // perdu. En revanche un `arguments` présent et mal typé est une faute de
  // contrat : on la dit, plutôt que de la laisser exploser à l'exécution.
  if (args === undefined) return { ok: true, output: { type: "tool", name, arguments: {} } }
  if (!isJsonObject(args)) {
    return fail(
      raw,
      `les arguments de l'outil « ${name} » ne sont pas un objet JSON (reçu : ${describe(args)})`,
    )
  }
  return { ok: true, output: { type: "tool", name, arguments: args } }
}

// ─────────────────────────────────────────────────────────────────────────────
// Point d'entrée
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lit la sortie d'un agent et la rend conforme au contrat de `core/prompt.ts`.
 *
 * Fonction **pure** : aucun process, aucun SDK, aucun état global. Tout ce qu'elle
 * peut échouer, elle le rend dans `ParseResult` — l'appelant décide, et l'adaptateur
 * OpenCode transforme l'échec en `provider-error` terminal (§4.0).
 *
 * @param raw    sortie brute concaténée de l'agent pour ce tour
 * @param tools  catalogue transmis dans le prompt — la **seule** source de vérité
 *               sur les noms d'outils acceptables
 */
export const parseAgentOutput = (
  raw: string,
  tools: readonly NormalizedTool[],
): ParseResult => {
  if (raw.trim() === "") {
    return fail(raw, "l'agent n'a produit aucune sortie exploitable")
  }

  // Retenu pour le diagnostic : un objet JSON bien formé mais de `type` inconnu
  // est un cas différent d'une sortie qui n'est pas du JSON du tout, et le
  // message doit pouvoir le dire.
  let unknownType: string | undefined

  for (const candidate of candidates(raw)) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch {
      // Candidat suivant : du texte autour d'un objet n'a pas à être du JSON.
      continue
    }
    if (!isJsonObject(value)) continue
    const type = value["type"]
    if (type === "text" || type === "tool") return validate(value, type, tools, raw)
    if (typeof type === "string") unknownType = type
  }

  if (unknownType !== undefined) {
    return fail(raw, `« type » vaut « ${unknownType} » : seuls « text » et « tool » sont acceptés`)
  }
  return fail(
    raw,
    "aucun objet JSON de la forme {\"type\":\"text\"|\"tool\"} n'a été trouvé dans la sortie",
  )
}
