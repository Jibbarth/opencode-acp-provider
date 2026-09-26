/**
 * The **core** of the project.
 *
 * Two modules are covered here, both pure and process-free:
 *
 * 1. `core/parse.ts` - reading the agent's output. It is the reader of the output
 *    contract written by `core/prompt.ts`. The cases covered are exactly those a
 *    real agent produces: JSON drowned in prose, an object inside a markdown
 *    block, braces **inside a string**, a valid but semantically empty answer, an
 *    invented tool name.
 * 2. `core/prompt.ts` - writing the contract: section order, tool catalogue,
 *    rebuilt example, and the fallback for an unreadable `schema`.
 *
 * These tests spawn **no** subprocess, which is what allows covering an agent
 * output nothing like what the fake agent can produce.
 */

import { describe, expect, test } from "bun:test"

import { ParseError, parseAgentOutput } from "../src/core/parse.js"
import { renderRequest } from "../src/core/prompt.js"
import type { NormalizedRequest, NormalizedTool } from "../src/core/types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

const READ: NormalizedTool = {
  name: "read",
  description: "Lit un fichier",
  schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
}
const BASH: NormalizedTool = { name: "bash", description: "Exécute une commande", schema: {} }

/** A failure's message, requiring that it exists (otherwise the test tests nothing). */
const failure = (raw: string, tools: readonly NormalizedTool[] = [READ]): string => {
  const parsed = parseAgentOutput(raw, tools)
  if (parsed.ok) throw new Error(`un échec était attendu, obtenu : ${JSON.stringify(parsed.output)}`)
  expect(parsed.error).toBeInstanceOf(ParseError)
  return parsed.error.message
}

/** The read value, requiring a success. */
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

describe("parseAgentOutput - extraction", () => {
  test("a direct JSON object", () => {
    expect(output('{"type":"text","text":"pong"}')).toEqual({ type: "text", text: "pong" })
  })

  test("surrounding whitespace changes nothing", () => {
    expect(output('\n  {"type":"text","text":"pong"}  \n')).toEqual({ type: "text", text: "pong" })
  })

  test("an object in a ```json block", () => {
    const raw = 'Voici ma réponse :\n```json\n{"type":"text","text":"pong"}\n```\nCordialement.'
    expect(output(raw)).toEqual({ type: "text", text: "pong" })
  })

  test("an object in a ``` block with no language", () => {
    const raw = '```\n{"type":"text","text":"pong"}\n```'
    expect(output(raw)).toEqual({ type: "text", text: "pong" })
  })

  test("a JSON object embedded in prose", () => {
    // The most frequent case with agents: an introductory sentence.
    const raw = 'Bien sûr ! Voici le résultat : {"type":"text","text":"pong"} — bonne journée.'
    expect(output(raw)).toEqual({ type: "text", text: "pong" })
  })

  test("the first usable object wins", () => {
    const raw = '{"type":"text","text":"un"}{"type":"text","text":"deux"}'
    expect(output(raw)).toEqual({ type: "text", text: "un" })
  })

  test("the first object is skipped when it has no known type", () => {
    const raw = '{"type":"schema","value":1}\n{"type":"text","text":"deux"}'
    expect(output(raw)).toEqual({ type: "text", text: "deux" })
  })

  test("a brace inside a string does not close the object", () => {
    // Note: this is THE trap of the naive "first `{`, first `}`" extraction:
    // without tracking strings, the object would be cut and the read would
    // fail.
    const raw = '{"type":"text","text":"voici {une} accolade et un \\" guillemet"}'
    expect(output(raw)).toEqual({ type: "text", text: 'voici {une} accolade et un " guillemet' })
  })

  test("a trailing string escape is handled", () => {
    // `\\"` is a quote **inside** the string: the string's closing quote comes
    // after, otherwise the final `}` would be swallowed.
    const raw = '{"type":"text","text":"une barre \\\\ puis }"}'
    expect(output(raw)).toEqual({ type: "text", text: "une barre \\ puis }" })
  })

  test("nested objects do not confuse the extraction", () => {
    const raw = '{"type":"tool","name":"bash","arguments":{"command":{"nested":{"deep":true}}}}'
    expect(output(raw, [READ, BASH])).toEqual({
      type: "tool",
      name: "bash",
      arguments: { command: { nested: { deep: true } } },
    })
  })

  test("an unclosed `{` does not prevent reading the rest", () => {
    const raw = 'une accolade orpheline { puis {"type":"text","text":"pong"}'
    expect(output(raw)).toEqual({ type: "text", text: "pong" })
  })
})

describe("parseAgentOutput - substantive validation", () => {
  test("an empty output is an error, not empty text", () => {
    // The edge case seen in real runs: an agent can return "nothing" after
    // having accepted the contract. A silent empty text would suggest an answer.
    expect(failure("")).toContain("aucune sortie exploitable")
    expect(failure("   \n  ")).toContain("aucune sortie exploitable")
  })

  test("empty text is an error", () => {
    // Note: "valid JSON but empty of meaning": the shape is right, the substance is not.
    expect(failure('{"type":"text","text":""}')).toContain("texte exploitable")
  })

  test("whitespace-only text is an error", () => {
    expect(failure('{"type":"text","text":"   "}')).toContain("texte exploitable")
  })

  test("a missing `text` field is an error", () => {
    expect(failure('{"type":"text"}')).toContain("texte exploitable")
  })

  test("a non-textual `text` is an error", () => {
    expect(failure('{"type":"text","text":42}')).toContain("texte exploitable")
  })

  test("raw prose is an error", () => {
    expect(failure("Bonjour, je peux vous aider.")).toContain("aucun objet JSON")
  })

  test("invalid JSON is an error", () => {
    expect(failure('{"type":"text","text":')).toContain("aucun objet JSON")
  })

  test("an unknown type is an error naming what it found", () => {
    const message = failure('{"type":"réponse","text":"pong"}')
    expect(message).toContain("réponse")
    expect(message).toContain('"text"')
  })

  test("an unknown tool name is an error naming the tool AND the accepted names", () => {
    // No silent degradation into text: the user must see that the requested work
    // is lost, and with what to redo it.
    const message = failure('{"type":"tool","name":"shell","arguments":{}}', [READ, BASH])
    expect(message).toContain("shell")
    expect(message).toContain("read, bash")
  })

  test("a tool request with no catalogue fails saying so", () => {
    const message = failure('{"type":"tool","name":"read","arguments":{}}', [])
    expect(message).toContain("read")
    expect(message).toContain("aucun")
  })

  test("a missing or empty `name` is an error", () => {
    expect(failure('{"type":"tool","arguments":{}}')).toContain("ne nomme aucun outil")
    expect(failure('{"type":"tool","name":"","arguments":{}}')).toContain("ne nomme aucun outil")
  })

  test("the name must be EXACT: no prefix, no different case", () => {
    // The name is the key OpenCode uses to find the tool: an approximation would
    // only produce a `tool-call` nothing can execute.
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

  test("absent `arguments` mean an empty object, not an error", () => {
    // A parameterless tool deserves a call, not a lost turn.
    expect(output('{"type":"tool","name":"bash"}', [READ, BASH])).toEqual({
      type: "tool",
      name: "bash",
      arguments: {},
    })
  })

  test("invalid `arguments` are not validated against the schema", () => {
    // OpenCode validates the input at execution time: the reader does not have to
    // be a second definition of the truth about schemas.
    const output_ = output('{"type":"tool","name":"read","arguments":{"filePath":42}}')
    expect(output_).toEqual({ type: "tool", name: "read", arguments: { filePath: 42 } })
  })

  test("the error message holds a bounded excerpt of the output", () => {
    // A valid answer drowned in 5 000 characters of noise is **read**: the
    // extraction's tolerance does its job.
    const long = `x`.repeat(5000)
    expect(output(`voici : ${long} {"type":"text","text":"pong"}`)).toEqual({
      type: "text",
      text: "pong",
    })
    // When the read fails, the excerpt is bounded: drowning a message in the
    // transcript would make the diagnosis harder than the error it describes.
    const bounded = failure(`voici : ${long}`)
    expect(bounded.length).toBeLessThan(600)
    expect(bounded).toContain("…")
  })

  test("an error message on an empty output says so", () => {
    expect(failure("")).toContain("sortie vide")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// core/prompt.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("renderRequest - prompt structure", () => {
  test("the sections appear in the canonical order", () => {
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

  test("the system prompt is taken as-is, without rewriting", () => {
    expect(renderRequest(baseRequest)).toContain("SYSTÈME")
  })

  test("the catalogue names every tool, its description and its serialised schema", () => {
    const rendered = renderRequest(baseRequest)
    expect(rendered).toContain("### read")
    expect(rendered).toContain("Lit un fichier")
    expect(rendered).toContain('"required":["filePath"]')
  })

  test("tool names are explicitly mandated", () => {
    // The agent must pick a name **among those**: the contract says so, and the
    // catalogue is the only source of truth.
    const rendered = renderRequest(baseRequest)
    expect(rendered).toContain("caractère pour caractère")
    expect(rendered).toContain("read")
  })

  test("the transcript keeps its role prefix", () => {
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

  test("a tool result's id is not rendered", () => {
    // It serves the OpenCode round-trip, not the model: showing it would invite
    // the model to fabricate an identifier.
    expect(renderRequest(baseRequest)).not.toContain("call-1")
  })

  test("the contract forbids surrounding prose and native tools", () => {
    const rendered = renderRequest(baseRequest)
    expect(rendered).toContain("un seul objet JSON")
    expect(rendered).toContain("aucun texte avant")
    expect(rendered).toContain("N'appelle aucun outil natif")
  })

  test("both shapes of the contract are written and exemplified", () => {
    const rendered = renderRequest(baseRequest)
    expect(rendered).toContain('{"type":"text","text":"<ta réponse>"}')
    expect(rendered).toContain('{"type":"text","text":"Le fichier contient 42 lignes."}')
  })

  test("the tool example is rebuilt from the real catalogue", () => {
    // A frozen example could cite an absent tool: the agent would copy it and the
    // call would be refused. This one is therefore derived from the **first**
    // tool.
    const rendered = renderRequest({
      ...baseRequest,
      tools: [{ ...BASH, schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
    })
    expect(rendered).toContain('{"type":"tool","name":"bash","arguments":{"command":"exemple"}}')
    expect(rendered).not.toContain('"name":"read"')
  })

  test("the argument example honours the schema's `required` and `enum`", () => {
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
    // Only the required property is in the example, with the first value of the
    // `enum` - an invented value for an `enum` would be refused by the schema.
    expect(rendered).toContain('"arguments":{"mode":"rapide"}')
  })

  test("with no tool, the catalogue says so and the contract exemplifies no call", () => {
    const rendered = renderRequest({ ...baseRequest, tools: [] })
    expect(rendered).toContain("aucun outil n'est disponible")
    // The **shape** is still described, but no example can cite a tool: there is
    // none, and the agent would only have a name to copy.
    expect(rendered).toContain('"name":"<nom exact d\'un outil listé plus haut>"')
    expect(rendered).not.toContain('{"type":"tool","name":"read"')
  })

  test("with no message, the transcript says so", () => {
    expect(renderRequest({ ...baseRequest, messages: [] })).toContain("aucun message précédent")
  })

  test("the rendering is stable: same inputs, same output", () => {
    expect(renderRequest(baseRequest)).toBe(renderRequest(baseRequest))
  })
})

describe("renderRequest - unreadable tool schemas", () => {
  test("a missing schema does not break the catalogue", () => {
    // Note: `NormalizedTool.schema` is typed `unknown` and **nothing** validates
    // it upstream. An `undefined` would serialise to `undefined` and leave the
    // agent with no information at all about the tool.
    const rendered = renderRequest({ ...baseRequest, tools: [{ name: "read", description: "", schema: undefined }] })
    expect(rendered).toContain("### read")
    expect(rendered).toContain("aucun schéma")
  })

  test("a circular schema does not bring down the prompt build", () => {
    // `JSON.stringify` **throws** on a circular structure: without a fallback, a
    // single malformed entry would fail the whole prompt, before any spawn.
    const circular: Record<string, unknown> = { type: "object" }
    circular["self"] = circular
    const rendered = renderRequest({ ...baseRequest, tools: [{ name: "read", description: "", schema: circular }] })
    expect(rendered).toContain("### read")
    expect(rendered).toContain("non sérialisable")
  })

  test("a schema that does not serialise to JSON (BigInt) has a fallback too", () => {
    const rendered = renderRequest({
      ...baseRequest,
      tools: [{ name: "read", description: "", schema: { taille: 1n } }],
    })
    expect(rendered).toContain("### read")
    expect(rendered).toContain("non sérialisable")
  })

  test("a free-form schema is rendered as-is, not discarded", () => {
    const rendered = renderRequest({
      ...baseRequest,
      tools: [{ name: "read", description: "", schema: "un objet quelconque" }],
    })
    expect(rendered).toContain('"un objet quelconque"')
  })
})
