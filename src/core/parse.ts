/**
 * Reading the output of an ACP agent.
 *
 * This module is the other half of the structured-output bridge: `core/prompt.ts`
 * writes the contract, this file reads it back. Both are **pure** and import
 * only local code - the condition for any other transport to reuse exactly the
 * same core without pulling `@opencode/ai` into its graph.
 *
 * Note: **why the substance is validated, not only the shape.** Real runs
 * surfaced an edge case: an agent can produce perfectly valid JSON that is
 * semantically empty - typically `{"type":"text","text":""}`, the example object
 * copied verbatim. A parser that only checked "this is JSON" would let that
 * through and produce an empty turn: the user would see the agent "answer" and
 * never get anything. Hence the two substantive rules:
 *
 * 1. `type:"text"` requires a **non-empty** string;
 * 2. `type:"tool"` requires a name **exactly** present in the catalogue.
 *
 * Note: **why an unknown name is not degraded into text.** If the agent proposes
 * a tool that does not exist, it is hallucinating: rendering it as text would
 * make the user believe the agent answered normally, while the work it wanted
 * to do is lost. So it fails, naming both the offending tool and the accepted
 * names - exactly as the transport already does for a model the agent does not
 * offer (`applyModel`).
 */

import type { NormalizedTool } from "./types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A read failure, always carrying a **bounded excerpt** of the raw output.
 *
 * Bounded rather than complete: a runaway agent answer can run to tens of
 * kilobytes, and drowning an error message in the transcript would make the
 * diagnosis harder than the error it describes.
 */
export class ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ParseError"
  }
}

/** The agent's answer, once the output contract is validated. */
export type AgentOutput =
  /** A text answer: `text-start` / `text-delta` / `text-end`. */
  | { readonly type: "text"; readonly text: string }
  /**
   * A tool call request: `tool-input-*` then `tool-call` **without**
   * `tool-result`, so OpenCode actually executes it.
   */
  | {
      readonly type: "tool"
      readonly name: string
      readonly arguments: Readonly<Record<string, unknown>>
    }

/** Read result: never an exception, so the caller stays total. */
export type ParseResult =
  | { readonly ok: true; readonly output: AgentOutput }
  | { readonly ok: false; readonly error: ParseError }

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A "bare" JSON object - not an array, not `null`.
 *
 * Note: explicitly rejecting **arrays** is what distinguishes "badly typed
 * arguments" from "valid arguments". `Array.isArray` returns `true` for an
 * array, and an array passed as tool input would produce an opaque error at
 * execution time, long after the reader.
 */
export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Maximum length of the raw output excerpt attached to an error. */
const MAX_EXCERPT = 400

/** A bounded, compacted excerpt of an output, for a readable error message. */
const excerpt = (raw: string): string => {
  const flat = raw.replace(/\s+/g, " ").trim()
  if (flat === "") return "(sortie vide)"
  return flat.length <= MAX_EXCERPT ? flat : `${flat.slice(0, MAX_EXCERPT)}…`
}

/** Builds a failure, always with the raw output in sight. */
const fail = (raw: string, reason: string): ParseResult => ({
  ok: false,
  error: new ParseError(`${reason} — sortie reçue : « ${excerpt(raw)} »`),
})

/** Describes a value for an error message ("an array", "null"...). */
const describe = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "un tableau"
  return `une valeur de type ${typeof value}`
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Index of the `}` closing the `{` at `start`, or -1.
 *
 * Note: this is where the classic "first `{` then first `}`" trap is avoided: an
 * agent answering `{"type":"text","text":"here is {a} brace"}` would have its
 * object cut in two and the extraction would fail. Hence the tracking of
 * **strings** and **escapes**: a `}` inside a string closes nothing.
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

/** All the **balanced** JSON objects embedded in a text, in order. */
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
      // An unclosed `{` cannot hide an object: advance by one.
      index += 1
      continue
    }
    found.push(raw.slice(index, end + 1))
    // Resume **after** the closed object: two side-by-side objects must not be
    // mistaken for a single nested candidate.
    index = end + 1
  }
  return found
}

/** Contents of ``` fenced blocks, with or without a language hint. */
const fencedBlocks = (raw: string): string[] => {
  const found: string[] = []
  for (const match of raw.matchAll(/```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n?([\s\S]*?)```/g)) {
    const body = match[1]
    if (body !== undefined && body.trim() !== "") found.push(body.trim())
  }
  return found
}

/**
 * Candidates, from most to least probable.
 *
 * The order encodes the expected tolerance, from the cleanest case to the most
 * improvised: the whole raw output, then ``` fenced blocks (what most agents
 * produce when asked for JSON), then balanced objects embedded in prose
 * ("Here is my answer: {...}").
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
// Substantive validation
// ─────────────────────────────────────────────────────────────────────────────

/** Tool catalogue, rendered as a list of names for an error message. */
const catalogNames = (tools: readonly NormalizedTool[]): string =>
  tools.length === 0
    ? "(aucun — la requête ne portait aucun outil)"
    : tools.map((tool) => tool.name).join(", ")

/**
 * Validates an object **already** recognised as carrying a known `type`.
 *
 * This is the heart of the reading: the shape has been checked, the substance
 * remains. No `arguments` are validated against the JSON schema - OpenCode does
 * that at execution time, and reimplementing schema validation here would give
 * two definitions of the truth for the same input.
 */
const validate = (
  value: Record<string, unknown>,
  type: "text" | "tool",
  tools: readonly NormalizedTool[],
  raw: string,
): ParseResult => {
  if (type === "text") {
    const text = value["text"]
    // An empty answer is an **error**, not a silent empty text: this is the
    // edge case observed in real runs (valid JSON, empty of meaning).
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
  // An **absent** `arguments` is not an error: a parameterless tool (or one the
  // agent has nothing to pass) deserves an empty object, not a lost turn. A
  // present but badly typed `arguments`, on the other hand, is a contract
  // violation: it is reported rather than left to blow up at execution time.
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
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads an agent's output and makes it conform to the contract of
 * `core/prompt.ts`.
 *
 * Pure: no process, no SDK, no global state. Everything it can fail at is
 * returned in `ParseResult` - the caller decides, and the OpenCode adapter turns
 * a failure into a terminal `provider-error`.
 *
 * @param raw    the raw output concatenated for this turn
 * @param tools  the catalogue sent in the prompt - the **only** source of truth
 *               on acceptable tool names
 */
export const parseAgentOutput = (
  raw: string,
  tools: readonly NormalizedTool[],
): ParseResult => {
  if (raw.trim() === "") {
    return fail(raw, "l'agent n'a produit aucune sortie exploitable")
  }

  // Kept for the diagnostic: a well-formed JSON object with an unknown `type` is
  // a different case from output that is not JSON at all, and the message must
  // be able to say so.
  let unknownType: string | undefined

  for (const candidate of candidates(raw)) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch {
      // Next candidate: prose around an object need not be JSON.
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
