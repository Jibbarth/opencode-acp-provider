/**
 * Construction du prompt ACP — PLAN.md §2.4 / §7.3.
 *
 * Ce module est la preuve exécutable de la promesse du §2.2 : il **n'importe
 * que du local**. Un adaptateur HTTP (`adapters/openai-http`) réutilisera
 * `renderRequest` et `parseAgentOutput` sans tirer le SDK ACP — et donc `zod` et
 * le typage généré — dans son graphe de dépendances. C'est pour ça que la
 * fonction vit ici et pas dans `acp/agent.ts` : c'est de la construction de
 * prompt, pas du protocole.
 *
 * ⚠️ **C'est le fichier qui porte toute la valeur du projet** (§7.1). En mode
 * « cerveau brut », on ne laisse pas l'agent agir : on lui **donne** le catalogue
 * d'outils d'OpenCode et un contrat de sortie JSON strict, puis on lit sa réponse
 * (`core/parse.ts`) et on émet un `tool-call` que **OpenCode** exécute. Sans ce
 * contrat, l'agent répond en texte et la boucle OpenCode ne voit jamais d'appel
 * d'outil.
 *
 * ⚠️ L'ordre des sections n'est pas cosmétique : le contrat de sortie est **en
 * dernier**, donc le plus proche de la génération. Le système d'OpenCode
 * (AGENTS.md, skills, instructions opérateur) vient **après** le rôle, donc
 * avant le catalogue — il ne doit jamais pouvoir se retrouver « noyé » sous une
 * consigne de format.
 */

import { isJsonObject } from "./parse.js"
import type { NormalizedMessage, NormalizedRequest, NormalizedTool } from "./types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Sections fixes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rôle — qui est le modèle, ce qu'on attend de lui.
 *
 * ⚠️ La phrase « tu n'as aucun outil » est le **filet de sécurité** du §7.4
 * (point 3) : elle ne remplace pas le refus de permission, mais elle évite
 * qu'un agent passe son tour à essayer d'appeler ses outils natifs au lieu de
 * répondre au contrat.
 */
const ROLE = [
  "## Rôle",
  "",
  "Tu es le moteur de raisonnement d'un éditeur de code. Tu n'as **aucun outil** : tu ne peux",
  "ni lire un fichier, ni exécuter une commande, ni écrire quoi que ce soit. Ton unique",
  "puissance est de produire la réponse attendue par l'éditeur, et tu ne la produis qu'en",
  "respectant le format décrit à la toute fin de ce message.",
  "",
  "Les outils listés plus bas ne sont pas les tiens : c'est l'éditeur qui les exécutera, et",
  "uniquement si tu le demandes dans ta réponse. Tu ne dois donc jamais tenter de les",
  "exécuter toi-même.",
].join("\n")

const SYSTEM_HEADER = "## Instructions système"

const TOOLS_HEADER = "## Outils disponibles"

const TOOLS_RULE = [
  "Ces outils appartiennent à l'éditeur, pas à toi. Le nom que tu renvois doit reproduire",
  "**exactement** l'un de ceux listés ci-dessous, caractère pour caractère : c'est cet",
  "exact nom que l'éditeur utilisera pour exécuter l'appel.",
].join("\n")

/** Message honnête quand la requête ne porte aucun outil : ne pas laisser croire qu'il y en a. */
const NO_TOOLS = "(aucun outil n'est disponible pour cette requête)"

const TRANSCRIPT_HEADER = "## Conversation"

/** Message honnête quand le transcript est vide. */
const EMPTY_TRANSCRIPT = "(aucun message précédent)"

const TOOL_SCHEMA_HEADER = "Schéma des arguments (JSON Schema) :"

// ─────────────────────────────────────────────────────────────────────────────
// Rendu des outils
// ─────────────────────────────────────────────────────────────────────────────

/** Rendu du nom, de la description et du schéma d'un outil. */
const renderTool = (tool: NormalizedTool): string => {
  const lines = [`### ${tool.name}`]
  if (tool.description !== "") lines.push(tool.description)
  lines.push(TOOL_SCHEMA_HEADER, renderSchema(tool.schema))
  return lines.join("\n")
}

/**
 * Sérialisation **défensive** du JSON schema d'un outil.
 *
 * ⚠️ `NormalizedTool.schema` est typé `unknown` : **rien** ne le valide en amont.
 * Un `schema: undefined` (un `inputSchema` absent côté OpenCode) sérialiserait
 * en `undefined`, et `JSON.stringify` sur une structure circulaire **lève** — donc
 * un catalogue aurait fait tomber la construction du prompt entière, avant même
 * le spawn de l'agent. On attrape les deux cas et on rend un repli explicite : un
 * agent qui lit « schéma indisponible » fera de son mieux, alors qu'une exception
 * ne dit rien du tout.
 */
const renderSchema = (schema: unknown): string => {
  if (schema === undefined || schema === null) {
    return "(aucun schéma : passe un objet d'arguments, par exemple {})"
  }
  try {
    const json = JSON.stringify(schema)
    if (json === undefined) {
      return "(schéma non sérialisable : passe un objet d'arguments, par exemple {})"
    }
    return json
  } catch {
    return "(schéma non sérialisable en JSON : passe un objet d'arguments, par exemple {})"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exemple d'arguments conforme au schéma
// ─────────────────────────────────────────────────────────────────────────────

/** Valeur d'exemple pour une propriété, déduite de son type et de son `enum`. */
const sampleValue = (property: unknown): unknown => {
  if (!isJsonObject(property)) return "exemple"
  // Un `enum` est la meilleure source d'exemple qui soit : la première valeur
  // est *garantie* acceptée par le schéma, alors qu'une valeur inventée pour un
  // `string` ne l'est pas.
  const allowed = property["enum"]
  if (Array.isArray(allowed) && allowed.length > 0) return allowed[0]
  switch (property["type"]) {
    case "string":
      return "exemple"
    case "number":
    case "integer":
      return 0
    case "boolean":
      return false
    case "array":
      return []
    case "object":
      return {}
    default:
      return "exemple"
  }
}

/**
 * Exemple d'arguments pour un outil, construit depuis son schéma.
 *
 * ⚠️ On ne fabrique ce+n'est que pour **l'exemple du contrat** : l'agent
 * n'obtiendra jamais cet objet par défaut. Mais un exemple cohérent avec le
 * schéma vaut mieux qu'un `{}` qui apprendrait au modèle à appeler `read` sans
 * chemin. Les propriétés retenues sont les `required` s'il y en a, sinon toutes
 * — et un schéma illisible donne `{}`, jamais une exception.
 */
const sampleArguments = (schema: unknown): Record<string, unknown> => {
  if (!isJsonObject(schema)) return {}
  const properties = schema["properties"]
  if (!isJsonObject(properties)) return {}
  const required = schema["required"]
  const keys =
    Array.isArray(required) && required.some((key) => typeof key === "string")
      ? required.filter((key): key is string => typeof key === "string")
      : Object.keys(properties)
  const example: Record<string, unknown> = {}
  for (const key of keys) {
    const value = sampleValue(properties[key])
    if (value !== undefined) example[key] = value
  }
  return example
}

// ─────────────────────────────────────────────────────────────────────────────
// Contrat de sortie
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le contrat de sortie — §7.3, point 4.
 *
 * ⚠️ **Exemplifié, pas seulement décrit** : les essais réels ont montré que
 * l'agent respecte nettement mieux un contrat accompagné d'un exemple, et
 * l'exemple d'outil est reconstruit **depuis le catalogue réel** — il porte donc
 * toujours un nom valide et des arguments conformes au schéma, ce qui rend
 * impossible pour l'agent de copier un exemple obsolète.
 */
const renderContract = (tools: readonly NormalizedTool[]): string => {
  const lines = [
    "## Format de sortie — impératif",
    "",
    "Réponds par **un seul objet JSON**, et par rien d'autre : aucun texte avant, aucun",
    "texte après, aucun commentaire, aucune explication. Pas de bloc de code, pas de",
    "formules de politesse.",
    "",
    "Deux formes sont acceptées, et aucune autre :",
    "",
    '1. une réponse en texte : {"type":"text","text":"<ta réponse>"}',
    '2. une demande d\'appel d\'outil : {"type":"tool","name":"<nom exact d\'un outil listé ' +
      'plus haut>","arguments":{…}}',
    "",
    "Exemples :",
    "",
    '{"type":"text","text":"Le fichier contient 42 lignes."}',
  ]
  const tool = tools[0]
  if (tool !== undefined) {
    lines.push(
      `{"type":"tool","name":${JSON.stringify(tool.name)},"arguments":${JSON.stringify(
        sampleArguments(tool.schema),
      )}}`,
    )
  }
  lines.push(
    "",
    "Règles impératives :",
    "",
    "- Un seul objet par réponse. Jamais deux, jamais un objet par ligne.",
    '- La clé "name" doit reproduire exactement un nom de la section « Outils disponibles ».',
    '- La clé "arguments" doit contenir un objet JSON conforme au schéma de l\'outil.',
    "- Si tu n'as rien à demander à l'éditeur, réponds avec la forme « text ».",
    "- N'appelle aucun outil natif : tu n'en as aucun, et toute tentative serait rejetée.",
  )
  return lines.join("\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcript
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Préfixe de rôle appliqué à chaque message du transcript.
 *
 * ⚠️ Ce préfixe n'est pas cosmétique : ACP n'a pas de champ « system » et le
 * transcript est rendu **à plat**. Sans lui, l'agent ne peut pas distinguer sa
 * propre sortie antérieure d'une instruction de l'utilisateur — or il doit
 * respecter un contrat de sortie JSON (§7.3) : confondre les deux est le pire
 * invariant à casser. On rend donc le rôle explicite, en français, comme le
 * reste du prompt.
 *
 * ⚠️ L'`id` d'un résultat d'outil n'est **pas** rendu. Il existe pour le
 * round-trip OpenCode → nous (§2.1) ; le montrer au modèle l'inciterait à
 * fabriquer ou à réutiliser un identifiant, alors qu'il n'a aucune prise sur
 * lui. Deux résultats du même outil restent distinguables par leur contenu et
 * par l'appel correspondant de la ligne précédente.
 */
const rolePrefix = (message: NormalizedMessage): string => {
  switch (message.role) {
    case "user":
      return "Utilisateur"
    case "assistant":
      return "Assistant"
    case "tool":
      return `Outil ${message.name}`
  }
}

/** Rendu d'un message unique, rôle compris. */
const renderMessage = (message: NormalizedMessage): string =>
  `${rolePrefix(message)} : ${message.role === "tool" ? message.output : message.text}`

// ─────────────────────────────────────────────────────────────────────────────
// Point d'entrée
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rendu texte d'une `NormalizedRequest` — rôle, système, catalogue d'outils,
 * transcript, contrat de sortie. Dans cet ordre, toujours (§7.3).
 *
 * Fonction **pure** et sans dépendance : mêmes entrées, même sortie. C'est ce
 * qui permet à `verify-real.ts`, aux tests et à un futur adaptateur HTTP de
 * vérifier la forme exacte du prompt sans démarrer d'agent.
 */
export const renderRequest = (request: NormalizedRequest): string => {
  const sections: string[] = [ROLE]

  if (request.system.length > 0) {
    sections.push([SYSTEM_HEADER, ...request.system].join("\n\n"))
  }

  sections.push(TOOLS_HEADER, TOOLS_RULE)
  if (request.tools.length > 0) {
    sections.push(request.tools.map(renderTool).join("\n\n"))
  } else {
    sections.push(NO_TOOLS)
  }

  if (request.messages.length > 0) {
    sections.push(TRANSCRIPT_HEADER, request.messages.map(renderMessage).join("\n\n"))
  } else {
    sections.push(TRANSCRIPT_HEADER, EMPTY_TRANSCRIPT)
  }

  // Le contrat ferme **toujours** le prompt, même sans outil : c'est lui qui
  // interdit de répondre en texte libre, y compris quand il n'y a rien à
  // demander à l'éditeur.
  sections.push(renderContract(request.tools))

  return sections.join("\n\n")
}
