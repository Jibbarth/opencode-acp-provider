/**
 * ACP prompt construction.
 *
 * This module imports **only local code**, so any other transport can reuse
 * `renderRequest` and `parseAgentOutput` without dragging the ACP SDK - and
 * therefore `zod` and the generated types - into its dependency graph. That is
 * why the function lives here and not in `acp/agent.ts`: this is prompt
 * construction, not protocol.
 *
 * The whole value of the project lives in this file. The agent is not left to
 * act: it is **given** OpenCode's tool catalogue and a strict JSON output
 * contract, its answer is then read back (`core/parse.ts`) and a `tool-call` is
 * emitted for **OpenCode** to execute. Without that contract the agent answers
 * in prose and the OpenCode loop never sees a tool call.
 *
 * Note: the section order is not cosmetic. The output contract comes **last**,
 * hence closest to generation. OpenCode's system prompt (AGENTS.md, skills,
 * operator instructions) comes **after** the role and therefore before the
 * catalogue - it must never end up "drowned" under a formatting instruction.
 */

import { isJsonObject } from "./parse.js"
import type { NormalizedMessage, NormalizedRequest, NormalizedTool } from "./types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Fixed sections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role - who the model is and what is expected of it.
 *
 * Note: the "you have no tool" sentence is a safety net. It does not replace
 * the permission refusal, but it stops an agent from spending its turn trying
 * to call its native tools instead of answering the contract.
 */
const ROLE = [
  "## Role",
  "",
  "You are the reasoning engine of a code editor. You have **no tool**: you can neither",
  "read a file, nor run a command, nor write anything. Your only power is to produce the",
  "answer the editor expects, and you produce it only by respecting the format described",
  "at the very end of this message.",
  "",
  "The tools listed below are not yours: the editor is what runs them, and only if you",
  "ask for it in your answer. You must therefore never try to run them yourself.",
].join("\n")

const SYSTEM_HEADER = "## System instructions"

const TOOLS_HEADER = "## Available tools"

const TOOLS_RULE = [
  "These tools belong to the editor, not to you. The name you return must reproduce",
  "**exactly** one of those listed below, character for character: that exact name is",
  "what the editor will use to run the call.",
].join("\n")

/** Honest message when the request carries no tool: never imply there are some. */
const NO_TOOLS = "(no tool is available for this request)"

const TRANSCRIPT_HEADER = "## Conversation"

/**
 * Transcript section header when an ACP session is **resumed**.
 *
 * Note: the textual counterpart of `NormalizedRequest.resume`. On resume,
 * `messages` holds only the **new** messages: the agent has the earlier ones in
 * its own memory. Without this mention it would read a truncated "Conversation"
 * section and could believe the start of the exchange never happened - so it
 * would summarise it, or answer as if the conversation began there. One line,
 * and above all a **promise**: what is not recalled was not forgotten. The
 * output contract itself does not change: the agent always answers with one
 * JSON object.
 */
const RESUME_HEADER = "## Conversation - continued"

/** Clarification rendered under the resume header. */
const RESUME_NOTE = [
  "(the messages that precede are already exchanged: they are in your session memory,",
  "do not repeat them and do not rephrase them - carry on from here.)",
].join("\n")

/** Honest message when the transcript is empty. */
const EMPTY_TRANSCRIPT = "(no previous message)"

const TOOL_SCHEMA_HEADER = "Argument schema (JSON Schema):"

// ─────────────────────────────────────────────────────────────────────────────
// Tool rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Renders a tool's name, description and schema. */
const renderTool = (tool: NormalizedTool): string => {
  const lines = [`### ${tool.name}`]
  if (tool.description !== "") lines.push(tool.description)
  lines.push(TOOL_SCHEMA_HEADER, renderSchema(tool.schema))
  return lines.join("\n")
}

/**
 * **Defensive** serialisation of a tool's JSON schema.
 *
 * Note: `NormalizedTool.schema` is typed `unknown` and **nothing** validates it
 * upstream. A `schema: undefined` serialises to `undefined`, and
 * `JSON.stringify` **throws** on a circular structure - so one bad catalogue
 * entry would take down the whole prompt build, before the agent is even
 * spawned. Both cases are caught and an explicit fallback is rendered: an agent
 * reading "schema unavailable" will do its best, whereas an exception says
 * nothing at all.
 */
const renderSchema = (schema: unknown): string => {
  if (schema === undefined || schema === null) {
    return "(no schema: pass an arguments object, for example {})"
  }
  try {
    const json = JSON.stringify(schema)
    if (json === undefined) {
      return "(schema not serialisable: pass an arguments object, for example {})"
    }
    return json
  } catch {
    return "(schema not serialisable as JSON: pass an arguments object, for example {})"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema-conformant argument example
// ─────────────────────────────────────────────────────────────────────────────

/** Sample value for a property, deduced from its type and its `enum`. */
const sampleValue = (property: unknown): unknown => {
  if (!isJsonObject(property)) return "example"
  // An `enum` is the best available source of examples: the first value is
  // *guaranteed* accepted by the schema, which an invented `string` is not.
  const allowed = property["enum"]
  if (Array.isArray(allowed) && allowed.length > 0) return allowed[0]
  switch (property["type"]) {
    case "string":
      return "example"
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
      return "example"
  }
}

/**
 * Sample arguments for a tool, built from its schema.
 *
 * Note: this exists only for the **contract's example**; the agent will never
 * receive this object by default. But an example consistent with the schema
 * beats a `{}` that would teach the model to call `read` with no path. The
 * properties kept are the `required` ones if there are any, otherwise all of
 * them - and an unreadable schema yields `{}`, never an exception.
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
// Output contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The output contract.
 *
 * Note: **exemplified, not merely described**. Real runs showed the agent
 * respects a contract accompanied by an example markedly better, and the tool
 * example is rebuilt **from the real catalogue** - it therefore always carries a
 * valid name and schema-conformant arguments, making it impossible for the
 * agent to copy a stale example.
 */
const renderContract = (tools: readonly NormalizedTool[]): string => {
  const lines = [
    "## Output format - mandatory",
    "",
    "Answer with **a single JSON object**, and nothing else: no text before, no text",
    "after, no comment, no explanation. No code block, no pleasantries.",
    "",
    "Two shapes are accepted, and no other:",
    "",
    '1. a text answer: {"type":"text","text":"<your answer>"}',
    '2. a tool call request: {"type":"tool","name":"<exact name of a tool listed ' +
      'above>","arguments":{…}}',
    "",
    "Examples:",
    "",
    '{"type":"text","text":"The file contains 42 lines."}',
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
    "Mandatory rules:",
    "",
    "- One single object per answer. Never two, never one object per line.",
    '- The "name" key must reproduce exactly a name from the "Available tools" section.',
    '- The "arguments" key must hold a JSON object conforming to the tool\'s schema.',
    "- If you have nothing to ask the editor for, answer with the \"text\" shape.",
    "- Do not call any native tool: you have none, and any attempt would be rejected.",
  )
  return lines.join("\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcript
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role prefix applied to every transcript message.
 *
 * Note: this prefix is not cosmetic. ACP has no "system" field and the
 * transcript is rendered **flat**. Without it the agent cannot tell its own
 * earlier output from a user instruction - yet it must respect a JSON output
 * contract, and confusing the two is the worst invariant to break. The role is
 * therefore explicit, like the rest of the prompt.
 *
 * Note: a tool result's `id` is deliberately **not** rendered. It exists for
 * the OpenCode round-trip; showing it to the model would invite it to invent or
 * reuse an identifier it has no hold on. Two results from the same tool stay
 * distinguishable by their content and by the matching call on the previous
 * line.
 */
const rolePrefix = (message: NormalizedMessage): string => {
  switch (message.role) {
    case "user":
      return "User"
    case "assistant":
      return "Assistant"
    case "tool":
      return `Tool ${message.name}`
  }
}

/** Renders a single message, role included. */
const renderMessage = (message: NormalizedMessage): string =>
  `${rolePrefix(message)} : ${message.role === "tool" ? message.output : message.text}`

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Text rendering of a `NormalizedRequest` - role, system, tool catalogue,
 * transcript, output contract. Always in that order.
 *
 * Pure and dependency-free: same inputs, same output. That is what lets
 * `verify-real.ts`, the tests, and any other transport check the exact shape of
 * the prompt without starting an agent.
 *
 * Note: only one thing changes when `request.resume` is true: the title - and
 * the warning line - of the transcript section, which then holds only the
 * **delta** of the conversation. The other sections are rendered **in full on
 * every turn**: system, tool catalogue and contract are not deltafied, because
 * they are not what duplicates, and an agent must see a system or tool change
 * immediately.
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
    sections.push(
      request.resume === true ? RESUME_HEADER : TRANSCRIPT_HEADER,
      ...(request.resume === true ? [RESUME_NOTE] : []),
      request.messages.map(renderMessage).join("\n\n"),
    )
  } else {
    sections.push(request.resume === true ? RESUME_HEADER : TRANSCRIPT_HEADER, EMPTY_TRANSCRIPT)
  }

  // The contract always closes the prompt, even with no tool: it is what forbids
  // answering in free prose, including when there is nothing to ask the editor
  // for.
  sections.push(renderContract(request.tools))

  return sections.join("\n\n")
}
