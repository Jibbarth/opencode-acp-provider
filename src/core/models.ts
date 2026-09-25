/**
 * Extraction de l'inventaire à partir des `configOptions` ACP — PLAN.md §5.
 *
 * Fonction **pure** : aucun import du SDK, aucun process, aucun effet de bord.
 * On travaille sur des types structurels locaux (`unknown` au départ) parce que
 * le format vient d'agents tierces et peut évoluer : tout ce qui ne ressemble
 * pas à ce qu'on attend est ignoré plutôt que de faire exploser la découverte
 * de modèles.
 *
 * Relevé de référence sur `copilot --acp` :
 *   [mode]          id=mode              current=#agent    values=[#agent, #plan, #autopilot]
 *   [model]         id=model             current=gpt-5.6   values=[auto, gpt-5.6, …] (20)
 *   [thought_level] id=reasoning_effort  current=medium    values=[none … max]
 *   [permissions]   id=allow_all         current=off       values=[on, off]
 */

import type { AcpMode, AcpModel, AcpOption, Inventory } from "./types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Catégories attendues
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_MODEL = "model"
const CATEGORY_THOUGHT = "thought_level"
const CATEGORY_MODE = "mode"
const CATEGORY_PERMISSIONS = "permissions"

/**
 * Repli sur l'`id` quand la catégorie est absente : c'est le cas de la plupart
 * des agents, qui n'envoient qu'un `id` (`reasoning_effort`, `allow_all`…).
 * On couvre les trois noms rencontrés dans la nature.
 */
const CATEGORY_BY_ID: Readonly<Record<string, string>> = {
  model: CATEGORY_MODEL,
  reasoning_effort: CATEGORY_THOUGHT,
  thought_level: CATEGORY_THOUGHT,
  mode: CATEGORY_MODE,
  allow_all: CATEGORY_PERMISSIONS,
  permissions: CATEGORY_PERMISSIONS,
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecture défensive
// ─────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** Une valeur de `select` avec son libellé, prête à indexer. */
interface RawValue {
  value: string
  name: string
  description?: string
}

/** Un `select` ACP expose `options` : liste de valeurs **ou** liste de groupes. */
const readSelectValues = (raw: unknown): RawValue[] => {
  if (!Array.isArray(raw)) return []
  const out: RawValue[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    // Format groupé : `{ group, name, options: [...] }` → on aplatit.
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

/** `AcpOption` enrichie du libellé de chaque valeur. */
interface ParsedOption {
  option: AcpOption
  values: RawValue[]
}

/**
 * Aplatit une `ConfigOption` brute. Renvoie `undefined` si elle n'est pas
 * exploitable (pas d'`id`) — un agent bruyant ne doit pas casser la découverte.
 */
const readOption = (raw: unknown): ParsedOption | undefined => {
  if (!isRecord(raw)) return undefined
  const id = asString(raw["id"])
  if (id === undefined || id.length === 0) return undefined

  const name = asString(raw["name"]) ?? id
  const description = asString(raw["description"])
  const category = asString(raw["category"]) ?? CATEGORY_BY_ID[id] ?? ""

  if (raw["type"] === "boolean") {
    // Un booléen n'expose pas de liste : on synthétise `["false", "true"]` pour
    // que `setOption` puisse round-tripper une valeur textuelle.
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
 * Aplatit une `ConfigOption` brute en `AcpOption`, ou renvoie `undefined`.
 * Point d'entrée public pour qui veut lire une seule option.
 */
export const parseOption = (raw: unknown): AcpOption | undefined => readOption(raw)?.option

/**
 * Raccourcit un identifiant de mode, qui est souvent une URL
 * (`https://agentclientprotocol.com/…#agent`). On garde le fragment `#…` s'il
 * existe, sinon le dernier segment du chemin, sinon l'identifiant brut.
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
// Fonction principale
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ConfigOption[]` (brut, tel que renvoyé par l'agent) → `Inventory`.
 * Ne lève jamais : un agent qui n'envoie pas de `configOptions` donne un
 * inventaire vide, ce qui laisse le cœur fonctionner avec un modèle unique.
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

  // ── Modèles : un modèle OpenCode par valeur de la catégorie `model` ─────────
  const modelEntry = find(CATEGORY_MODEL)
  const models: AcpModel[] = (modelEntry?.values ?? []).map((value) =>
    value.description === undefined
      ? { id: value.value, name: value.name }
      : { id: value.value, name: value.name, description: value.description },
  )

  // ── Niveaux d'effort : variants du modèle ────────────────────────────────
  const thoughtEntry = find(CATEGORY_THOUGHT)

  // ── Modes : agents OpenCode, identifiants raccourcis ─────────────────────
  const modeEntry = find(CATEGORY_MODE)
  const modes: AcpMode[] = (modeEntry?.values ?? []).map((value) => ({
    id: shortenModeId(value.value),
    rawId: value.value,
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
  }))

  // ── Permissions : épinglées à `off` en mode « cerveau brut » (§7.4) ───────
  const permissionEntry = find(CATEGORY_PERMISSIONS)

  const currentMode = (() => {
    if (modeEntry === undefined || modeEntry.option.currentValue === "") return undefined
    const current = modeEntry.option.currentValue
    // L'`id` court est celui qu'on expose ; l'agent reste adressé par `rawId`.
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
