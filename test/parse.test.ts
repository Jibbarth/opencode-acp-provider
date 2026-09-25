/**
 * Tests de la phase P2b : le **cœur** du projet.
 *
 * Deux modules sont ici couverts, tous deux purs et sans process :
 *
 * 1. `core/parse.ts` — la lecture de la sortie de l'agent. C'est le lecteur du
 *    contrat de sortie écrit par `core/prompt.ts` (§7.3). Les cas couverts sont
 *    exactement ceux qu'un agent produit en vrai : du JSON noyé dans du texte, un
 *    objet dans un bloc de markdown, des accolades **dans une chaîne**, une
 *    réponse valide mais vide de sens, un nom d'outil inventé.
 * 2. `core/prompt.ts` — l'écriture du contrat : ordre des sections, catalogue
 *    d'outils, exemple reconstruit, et repli sur un `schema` illisible.
 *
 * Ces tests ne lancent **aucun** sous-processus : c'est ce qui permet de couvrir
 * une sortie d'agent qui n'a rien à voir avec ce que le faux agent sait produire.
 */

import { describe, expect, test } from "bun:test"

import { ParseError, parseAgentOutput } from "../src/core/parse.js"
import { renderRequest } from "../src/core/prompt.js"
import type { NormalizedRequest, NormalizedTool } from "../src/core/types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────────────────────────────────────

const READ: NormalizedTool = {
  name: "read",
  description: "Lit un fichier",
  schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
}
const BASH: NormalizedTool = { name: "bash", description: "Exécute une commande", schema: {} }

/** Le message d'un échec, en exigeant qu'il existe (sinon le test ne teste rien). */
const failure = (raw: string, tools: readonly NormalizedTool[] = [READ]): string => {
  const parsed = parseAgentOutput(raw, tools)
  if (parsed.ok) throw new Error(`un échec était attendu, obtenu : ${JSON.stringify(parsed.output)}`)
  expect(parsed.error).toBeInstanceOf(ParseError)
  return parsed.error.message
}

/** La valeur lue, en exigeant un succès. */
const output = (raw: string, tools: readonly NormalizedTool[] = [READ]) => {
  const parsed = parseAgentOutput(raw, tools)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.output
}

const baseRequest: NormalizedRequest = {
  system: ["SYSTÈME"],
  tools: [READ],
  messages: [{ role: "user", text: "bonjour" }],
}

// ─────────────────────────────────────────────────────────────────────────────
// core/parse.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("parseAgentOutput — extraction", () => {
  test("un objet JSON direct", () => {
    expect(output('{"type":"text","text":"pong"}')).toEqual({ type: "text", text: "pong" })
  })

  test("des espaces autour ne changent rien", () => {
    expect(output('\n  {"type":"text","text":"pong"}  \n')).toEqual({ type: "text", text: "pong" })
  })

  test("un objet dans un bloc ```json", () => {
    const raw = 'Voici ma réponse :\n```json\n{"type":"text","text":"pong"}\n```\nCordialement.'
    expect(output(raw)).toEqual({ type: "text", text: "pong" })
  })

  test("un objet dans un bloc ``` sans langage", () => {
    const raw = '```\n{"type":"text","text":"pong"}\n```'
    expect(output(raw)).toEqual({ type: "text", text: "pong" })
  })

  test("un objet JSON enchâssé dans du texte", () => {
    // Le cas le plus fréquent chez les agents : une phrase d'introduction.
    const raw = 'Bien sûr ! Voici le résultat : {"type":"text","text":"pong"} — bonne journée.'
    expect(output(raw)).toEqual({ type: "text", text: "pong" })
  })

  test("le premier objet exploitable gagne", () => {
    const raw = '{"type":"text","text":"un"}{"type":"text","text":"deux"}'
    expect(output(raw)).toEqual({ type: "text", text: "un" })
  })

  test("le premier objet est ignoré s'il n'a pas un type connu", () => {
    const raw = '{"type":"schema","value":1}\n{"type":"text","text":"deux"}'
    expect(output(raw)).toEqual({ type: "text", text: "deux" })
  })

  test("une accolade dans une chaîne ne referme pas l'objet", () => {
    // ⚠️ C'est LE piège de l'extraction naïve « premier `{`, premier `}` » : sans
    // suivi des chaînes, l'objet serait coupé et la lecture échouerait.
    const raw = '{"type":"text","text":"voici {une} accolade et un \\" guillemet"}'
    expect(output(raw)).toEqual({ type: "text", text: 'voici {une} accolade et un " guillemet' })
  })

  test("un échappement de fin de chaîne est géré", () => {
    // `\\"` est un guillemet **dans** la chaîne : la fermeture de la chaîne arrive
    // après, sinon le `}` final serait avalé.
    const raw = '{"type":"text","text":"une barre \\\\ puis }"}'
    expect(output(raw)).toEqual({ type: "text", text: "une barre \\ puis }" })
  })

  test("des objets imbriqués ne confondent pas l'extraction", () => {
    const raw = '{"type":"tool","name":"bash","arguments":{"command":{"nested":{"deep":true}}}}'
    expect(output(raw, [READ, BASH])).toEqual({
      type: "tool",
      name: "bash",
      arguments: { command: { nested: { deep: true } } },
    })
  })

  test("un `{` non fermé n'empêche pas de lire la suite", () => {
    const raw = 'une accolade orpheline { puis {"type":"text","text":"pong"}'
    expect(output(raw)).toEqual({ type: "text", text: "pong" })
  })
})

describe("parseAgentOutput — validation du fond", () => {
  test("une sortie vide est une erreur, pas un texte vide", () => {
    // Le cas limite relevé en réel : un agent peut renvoyer « rien » après avoir
    // accepté le contrat. Un texte vide silencieux ferait croire à une réponse.
    expect(failure("")).toContain("aucune sortie exploitable")
    expect(failure("   \n  ")).toContain("aucune sortie exploitable")
  })

  test("un texte vide est une erreur", () => {
    // ⚠️ « JSON valide mais vide de sens » : la forme est bonne, le fond ne l'est pas.
    expect(failure('{"type":"text","text":""}')).toContain("texte exploitable")
  })

  test("un texte composé d'espaces est une erreur", () => {
    expect(failure('{"type":"text","text":"   "}')).toContain("texte exploitable")
  })

  test("un champ `text` absent est une erreur", () => {
    expect(failure('{"type":"text"}')).toContain("texte exploitable")
  })

  test("un `text` non textuel est une erreur", () => {
    expect(failure('{"type":"text","text":42}')).toContain("texte exploitable")
  })

  test("du texte brut est une erreur", () => {
    expect(failure("Bonjour, je peux vous aider.")).toContain("aucun objet JSON")
  })

  test("du JSON invalide est une erreur", () => {
    expect(failure('{"type":"text","text":')).toContain("aucun objet JSON")
  })

  test("un type inconnu est une erreur qui nomme ce qu'il a trouvé", () => {
    const message = failure('{"type":"réponse","text":"pong"}')
    expect(message).toContain("réponse")
    expect(message).toContain('"text"')
  })

  test("un nom d'outil inconnu est une erreur qui nomme l'outil ET les noms acceptés", () => {
    // Aucune dégradation silencieuse en texte : l'utilisateur doit voir que le
    // travail demandé est perdu, et avec quoi le refaire.
    const message = failure('{"type":"tool","name":"shell","arguments":{}}', [READ, BASH])
    expect(message).toContain("shell")
    expect(message).toContain("read, bash")
  })

  test("une demande d'outil sans catalogue échoue en le disant", () => {
    const message = failure('{"type":"tool","name":"read","arguments":{}}', [])
    expect(message).toContain("read")
    expect(message).toContain("aucun")
  })

  test("un `name` absent ou vide est une erreur", () => {
    expect(failure('{"type":"tool","arguments":{}}')).toContain("ne nomme aucun outil")
    expect(failure('{"type":"tool","name":"","arguments":{}}')).toContain("ne nomme aucun outil")
  })

  test("le nom doit être EXACT : ni préfixe, ni casse différente", () => {
    // Le nom est la clé que OpenCode utilise pour trouver l'outil : une
    // approximation ne ferait qu'un `tool-call` que rien ne peut exécuter.
    expect(failure('{"type":"tool","name":"Read","arguments":{}}')).toContain("read")
    expect(failure('{"type":"tool","name":"read_file","arguments":{}}')).toContain("read")
  })

  test.each([
    ['"read"', "une valeur de type string"],
    ["42", "une valeur de type number"],
    ["true", "une valeur de type boolean"],
    ["null", "null"],
    ["[1,2]", "un tableau"],
    ['"{"', "une valeur de type string"],
  ])("des `arguments` %s sont refusés", (arguments_, fragment) => {
    const message = failure(`{"type":"tool","name":"read","arguments":${arguments_}}`)
    expect(message).toContain(fragment)
    expect(message).toContain("read")
  })

  test("des `arguments` absents valent un objet vide, pas une erreur", () => {
    // Un outil sans paramètre mérite un appel, pas un tour perdu.
    expect(output('{"type":"tool","name":"bash"}', [READ, BASH])).toEqual({
      type: "tool",
      name: "bash",
      arguments: {},
    })
  })

  test("des `arguments` invalides ne sont pas validés contre le schéma", () => {
    // OpenCode valide l'entrée au moment de l'exécution : le relecteur n'a pas à
    // être une seconde définition de la vérité sur les schemas.
    const output_ = output('{"type":"tool","name":"read","arguments":{"filePath":42}}')
    expect(output_).toEqual({ type: "tool", name: "read", arguments: { filePath: 42 } })
  })

  test("le message d'erreur contient un extrait borné de la sortie", () => {
    // Une réponse valide noyée dans 5 000 caractères de bruit est **lue** : la
    // tolérance de l'extraction fait son travail.
    const long = `x`.repeat(5000)
    expect(output(`voici : ${long} {"type":"text","text":"pong"}`)).toEqual({
      type: "text",
      text: "pong",
    })
    // Quand la lecture échoue, l'extrait est borné : noyer un message dans le
    // transcript rendrait le diagnostic plus dur que l'erreur qu'il décrit.
    const bounded = failure(`voici : ${long}`)
    expect(bounded.length).toBeLessThan(600)
    expect(bounded).toContain("…")
  })

  test("un message d'erreur sur une sortie vide le dit", () => {
    expect(failure("")).toContain("sortie vide")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// core/prompt.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("renderRequest — structure du prompt", () => {
  test("les sections apparaissent dans l'ordre du §7.3", () => {
    const rendered = renderRequest(baseRequest)
    const role = rendered.indexOf("## Rôle")
    const system = rendered.indexOf("## Instructions système")
    const tools = rendered.indexOf("## Outils disponibles")
    const transcript = rendered.indexOf("## Conversation")
    const contract = rendered.indexOf("## Format de sortie")
    expect([role, system, tools, transcript, contract]).toEqual([
      ...[role, system, tools, transcript, contract].sort((a, b) => a - b),
    ])
    expect(role).toBe(0)
  })

  test("le système est repris tel quel, sans réécriture", () => {
    expect(renderRequest(baseRequest)).toContain("SYSTÈME")
  })

  test("le catalogue nomme chaque outil, sa description et son schéma sérialisé", () => {
    const rendered = renderRequest(baseRequest)
    expect(rendered).toContain("### read")
    expect(rendered).toContain("Lit un fichier")
    expect(rendered).toContain('"required":["filePath"]')
  })

  test("les noms d'outils sont imposés explicitement", () => {
    // L'agent doit choisir un nom **parmi ceux-là** : le contrat le dit, et le
    // catalogue est la seule source de vérité.
    const rendered = renderRequest(baseRequest)
    expect(rendered).toContain("caractère pour caractère")
    expect(rendered).toContain("read")
  })

  test("le transcript garde son préfixe de rôle", () => {
    const rendered = renderRequest({
      ...baseRequest,
      messages: [
        { role: "user", text: "lis" },
        { role: "assistant", text: "je lis" },
        { role: "tool", id: "call-1", name: "read", output: "# README" },
      ],
    })
    expect(rendered).toContain("Utilisateur : lis")
    expect(rendered).toContain("Assistant : je lis")
    expect(rendered).toContain("Outil read : # README")
  })

  test("l'id d'un résultat d'outil n'est pas rendu", () => {
    // Il sert au round-trip OpenCode → nous, pas au modèle : le montrer
    // l'inviterait à fabriquer un identifiant.
    expect(renderRequest(baseRequest)).not.toContain("call-1")
  })

  test("le contrat interdit le texte autour et les outils natifs", () => {
    const rendered = renderRequest(baseRequest)
    expect(rendered).toContain("un seul objet JSON")
    expect(rendered).toContain("aucun texte avant")
    expect(rendered).toContain("N'appelle aucun outil natif")
  })

  test("les deux formes du contrat sont écrites, et exemplifiées", () => {
    const rendered = renderRequest(baseRequest)
    expect(rendered).toContain('{"type":"text","text":"<ta réponse>"}')
    expect(rendered).toContain('{"type":"text","text":"Le fichier contient 42 lignes."}')
  })

  test("l'exemple d'outil est reconstruit depuis le catalogue réel", () => {
    // Un exemple figé pourrait citer un outil absent : l'agent le recopierait et
    // l'appel serait refusé. Celui-ci est donc dérivé du **premier** outil.
    const rendered = renderRequest({
      ...baseRequest,
      tools: [{ ...BASH, schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
    })
    expect(rendered).toContain('{"type":"tool","name":"bash","arguments":{"command":"exemple"}}')
    expect(rendered).not.toContain('"name":"read"')
  })

  test("l'exemple d'arguments respecte les `required` et les `enum` du schéma", () => {
    const rendered = renderRequest({
      ...baseRequest,
      tools: [
        {
          name: "search",
          description: "Cherche",
          schema: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["rapide", "complet"] },
              depth: { type: "integer" },
            },
            required: ["mode"],
          },
        },
      ],
    })
    // Seule la propriété requise est dans l'exemple, avec la première valeur de
    // l'`enum` — une valeur inventée pour un `enum` serait refusée par le schéma.
    expect(rendered).toContain('"arguments":{"mode":"rapide"}')
  })

  test("sans outil, le catalogue le dit et le contrat n'exemplifie pas d'appel", () => {
    const rendered = renderRequest({ ...baseRequest, tools: [] })
    expect(rendered).toContain("aucun outil n'est disponible")
    // La **forme** reste décrite, mais aucun exemple ne peut citer un outil : il
    // n'y en a pas, et l'agent n'aurait qu'un nom à recopier.
    expect(rendered).toContain('"name":"<nom exact d\'un outil listé plus haut>"')
    expect(rendered).not.toContain('{"type":"tool","name":"read"')
  })

  test("sans message, le transcript le dit", () => {
    expect(renderRequest({ ...baseRequest, messages: [] })).toContain("aucun message précédent")
  })

  test("le rendu est stable : mêmes entrées, même sortie", () => {
    expect(renderRequest(baseRequest)).toBe(renderRequest(baseRequest))
  })
})

describe("renderRequest — schémas d'outils illisibles", () => {
  test("un schema absent ne casse pas le catalogue", () => {
    // ⚠️ `NormalizedTool.schema` est typé `unknown` : **rien** ne le valide en
    // amont. Un `undefined` sérialiserait en `undefined` et laisserait l'agent
    // sans aucune information sur l'outil.
    const rendered = renderRequest({ ...baseRequest, tools: [{ name: "read", description: "", schema: undefined }] })
    expect(rendered).toContain("### read")
    expect(rendered).toContain("aucun schéma")
  })

  test("un schema circulaire ne fait pas tomber la construction du prompt", () => {
    // `JSON.stringify` **lève** sur une structure circulaire : sans repli, une
    // seule entrée malformée ferait échouer le prompt entier, avant tout spawn.
    const circular: Record<string, unknown> = { type: "object" }
    circular["self"] = circular
    const rendered = renderRequest({ ...baseRequest, tools: [{ name: "read", description: "", schema: circular }] })
    expect(rendered).toContain("### read")
    expect(rendered).toContain("non sérialisable")
  })

  test("un schema qui ne sérialise pas en JSON (BigInt) a un repli aussi", () => {
    const rendered = renderRequest({
      ...baseRequest,
      tools: [{ name: "read", description: "", schema: { taille: 1n } }],
    })
    expect(rendered).toContain("### read")
    expect(rendered).toContain("non sérialisable")
  })

  test("un schema en texte libre est rendu tel quel, sans être jeté", () => {
    const rendered = renderRequest({
      ...baseRequest,
      tools: [{ name: "read", description: "", schema: "un objet quelconque" }],
    })
    expect(rendered).toContain('"un objet quelconque"')
  })
})
