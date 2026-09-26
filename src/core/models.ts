/**
 * Inventory extraction from raw ACP `configOptions`.
 *
 * Pure: no SDK import, no process, no side effect. Everything starts from
 * `unknown` and is read through local structural types, because the format
 * comes from third-party agents and may evolve. Anything that does not look
 * like what we expect is ignored rather than blowing up model discovery.
 *
 * Reference capture on `copilot --acp`:
 *   [mode]          id=mode              current=#agent    values=[#agent, #plan, #autopilot]
 *   [model]         id=model             current=gpt-5.6   values=[auto, gpt-5.6, ...] (20)
 *   [thought_level] id=reasoning_effort  current=medium    values=[none ... max]
 *   [permissions]   id=allow_all         current=off       values=[on, off]
 */

import type { AcpMode, AcpModel, AcpOption, Inventory } from "./types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Expected categories
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_MODEL = "model"
const CATEGORY_THOUGHT = "thought_level"
const CATEGORY_MODE = "mode"
const CATEGORY_PERMISSIONS = "permissions"

/**
 * Fallback on `id` when the category is absent, which is the case for agents
 * that only send an `id`. Every entry is an **id measured in the wild**:
 * `model` and `mode` (both agents), `reasoning_effort` and `allow_all`
 * (`copilot --acp`), `effort` (`opencode acp`).
 *
 * Note: a category name must never be added to this table. Classifying an
 * option is precisely what makes `applyOption` send its `id`, and no measured
 * agent accepts a category as a `configId` (`Unknown config option
 * 'thought_level'` from `copilot`, `unknown config option` from `opencode
 * acp`). `model` and `mode` are the exception that measures true: they are
 * *really* the ids those agents use, and their category happens to match. That
 * coincidence is recorded, not generalised.
 *
 * Note: an id absent from this table yields the empty category, so the option is
 * parsed and kept, but matches no category - the probe reports it and it is
 * never applied. Guessing a category would be worse: a miscategorised option
 * would publish variants the agent never offered, and `applyOption` would then
 * send a `configId` the agent refuses.
 */
const CATEGORY_BY_ID: Readonly<Record<string, string>> = {
  model: CATEGORY_MODEL,
  reasoning_effort: CATEGORY_THOUGHT,
  effort: CATEGORY_THOUGHT,
  mode: CATEGORY_MODE,
  allow_all: CATEGORY_PERMISSIONS,
}

// ─────────────────────────────────────────────────────────────────────────────
// Defensive reading
// ─────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** A `select` value with its label, ready to be indexed. */
interface RawValue {
  value: string
  name: string
  description?: string
}

/** An ACP `select` exposes `options`: a list of values **or** a list of groups. */
const readSelectValues = (raw: unknown): RawValue[] => {
  if (!Array.isArray(raw)) return []
  const out: RawValue[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    // Grouped shape: `{ group, name, options: [...] }` is flattened.
    if (Array.isArray(entry["options"])) {
      out.push(...readSelectValues(entry["options"]))
      continue
    }
    const value = asString(entry["value"])
    if (value === undefined) continue
    const name = asString(entry["name"]) ?? value
    const description = asString(entry["description"])
    out.push(description === undefined ? { value, name } : { value, name, description })
  }
  return out
}

/** An `AcpOption` enriched with each value's label. */
interface ParsedOption {
  option: AcpOption
  values: RawValue[]
}

/**
 * Flattens a raw `ConfigOption`. Returns `undefined` when it is unusable (no
 * `id`): a noisy agent must not break discovery.
 */
const readOption = (raw: unknown): ParsedOption | undefined => {
  if (!isRecord(raw)) return undefined
  const id = asString(raw["id"])
  if (id === undefined || id.length === 0) return undefined

  const name = asString(raw["name"]) ?? id
  const description = asString(raw["description"])
  const category = asString(raw["category"]) ?? CATEGORY_BY_ID[id] ?? ""

  if (raw["type"] === "boolean") {
    // A boolean exposes no list: synthesise `["false", "true"]` so `setOption`
    // can round-trip a textual value.
    return {
      option: {
        id,
        name,
        category,
        type: "boolean",
        currentValue: raw["currentValue"] === true ? "true" : "false",
        values: ["false", "true"],
        ...(description === undefined ? {} : { description }),
      },
      values: [],
    }
  }

  const values = readSelectValues(raw["options"])
  const currentValue = asString(raw["currentValue"]) ?? values[0]?.value ?? ""
  return {
    option: {
      id,
      name,
      category,
      type: "select",
      currentValue,
      values: values.map((v) => v.value),
      ...(description === undefined ? {} : { description }),
    },
    values,
  }
}

/**
 * Flattens a raw `ConfigOption` into an `AcpOption`, or returns `undefined`.
 * Public entry point for reading a single option.
 */
export const parseOption = (raw: unknown): AcpOption | undefined => readOption(raw)?.option

/**
 * Shortens a mode id, which is often a URL
 * (`https://agentclientprotocol.com/...#agent`): keeps the `#...` fragment if
 * there is one, else the last path segment, else the raw id.
 */
export const shortenModeId = (rawId: string): string => {
  const hash = rawId.lastIndexOf("#")
  if (hash >= 0 && hash < rawId.length - 1) return rawId.slice(hash + 1)
  const query = rawId.indexOf("?")
  const path = query >= 0 ? rawId.slice(0, query) : rawId
  const segments = path.split("/").filter((s) => s.length > 0)
  return segments[segments.length - 1] ?? rawId
}

// ─────────────────────────────────────────────────────────────────────────────
// Main function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ConfigOption[]` (raw, as returned by the agent) to `Inventory`. Never throws:
 * an agent sending no `configOptions` yields an empty inventory, which lets the
 * core run on a single model.
 */
export const parseInventory = (raw: readonly unknown[]): Inventory => {
  const parsed: ParsedOption[] = []
  for (const entry of raw) {
    const option = readOption(entry)
    if (option !== undefined) parsed.push(option)
  }
  if (parsed.length === 0) return { models: [], thoughtLevels: [], modes: [], options: [] }

  const options = parsed.map((p) => p.option)
  const find = (category: string): ParsedOption | undefined =>
    parsed.find((p) => p.option.category === category)

  // Models: one OpenCode model per value of the `model` category.
  const modelEntry = find(CATEGORY_MODEL)
  const models: AcpModel[] = (modelEntry?.values ?? []).map((value) =>
    value.description === undefined
      ? { id: value.value, name: value.name }
      : { id: value.value, name: value.name, description: value.description },
  )

  // Thought levels: variants of the model.
  const thoughtEntry = find(CATEGORY_THOUGHT)

  // Modes: OpenCode agents, with shortened ids.
  const modeEntry = find(CATEGORY_MODE)
  const modes: AcpMode[] = (modeEntry?.values ?? []).map((value) => ({
    id: shortenModeId(value.value),
    rawId: value.value,
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
  }))

  // Permissions, reported as-is; the default policy pins them to `off`.
  const permissionEntry = find(CATEGORY_PERMISSIONS)

  const currentMode = (() => {
    if (modeEntry === undefined || modeEntry.option.currentValue === "") return undefined
    const current = modeEntry.option.currentValue
    // The short id is what we expose; the agent is still addressed by `rawId`.
    return modes.find((m) => m.rawId === current)?.id ?? shortenModeId(current)
  })()

  return {
    models,
    thoughtLevels: thoughtEntry?.option.values ?? [],
    modes,
    ...(permissionEntry === undefined ? {} : { permissions: permissionEntry.option }),
    options,
    ...(modelEntry !== undefined && modelEntry.option.currentValue !== ""
      ? { currentModel: modelEntry.option.currentValue }
      : {}),
    ...(thoughtEntry !== undefined && thoughtEntry.option.currentValue !== ""
      ? { currentThoughtLevel: thoughtEntry.option.currentValue }
      : {}),
    ...(currentMode === undefined ? {} : { currentMode }),
  }
}
