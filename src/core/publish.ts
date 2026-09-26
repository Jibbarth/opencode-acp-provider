/**
 * Publishing the ACP inventory into OpenCode's catalogue.
 *
 * Note: this module is **pure**: it imports neither `@opencode/plugin`, nor
 * `@opencode/schema`, nor `effect`, nor the ACP SDK. It therefore does **not**
 * produce `Model.Info` / `Provider.Info` - those are types of a package versioned
 * in lockstep with the host, and letting them appear here would turn the
 * portable core into an OpenCode extension.
 *
 * Work is therefore done on **raw shapes** (`RawModelInfo`, `RawProviderInfo`)
 * built from the portable `Inventory` contract, itself already validated by
 * `core/models.ts`. The typed conversion (`Model.Info.default`,
 * `Provider.Info.empty`, `Model.ID.make`...) happens in `src/plugin.ts`, the
 * only file that depends on the plugin API.
 *
 * The split has a direct testability benefit: everything that decides *what
 * OpenCode sees* - the limits, the filtering of `auto`, the shape of effort
 * variants - is testable with no process, no import and no server.
 */

import type { AcpModel, Inventory } from "./types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The provider id used by an agent that was given no `id`.
 *
 * Note: the plugin publishes this exact value in the provider `settings`, which
 * is the only channel OpenCode leaves to reach the transport - `model(modelID,
 * settings)` receives nothing else. The id therefore travels **with the
 * settings**, never as a frozen constant in `adapters/opencode-transport.ts`:
 * OpenCode matches a model to its provider by `(providerID, modelID)`, and two
 * providers carrying the same route identity would make `acp-copilot/x`
 * indistinguishable from `acp-codex/x`.
 */
export const PROVIDER_ID = "acp"

/**
 * Prefix of every **named** agent's provider id.
 *
 * Note: what it buys is the absence of a collision. OpenCode ships providers
 * named `openai`, `anthropic`, `github-copilot`… and the user may have declared
 * his own; `acp-` is a namespace this project owns, so an agent named `copilot`
 * cannot land on top of a built-in. The alternative - publishing the agent's `id`
 * verbatim - would make that collision not merely possible but likely, and
 * `editor.add` **replaces** the entry with the same id: the user's own provider
 * would be overwritten by an ACP inventory, without a word.
 */
export const PROVIDER_PREFIX = "acp-"

/**
 * A provider id fragment, reduced to what an id may contain.
 *
 * Note: only `[a-z0-9-]` survives. An id ends up in a `provider/model` string
 * typed by a human, in a CLI filter, and in a URL; a `.`, a `/` or a space would
 * have to be quoted at least once, and a `..` would be a path. The `acp-` prefix
 * also makes a leading digit harmless.
 */
export const normalizeProviderSlug = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")

/**
 * The provider id an agent is published under.
 *
 * Note: `undefined` (no explicit `id`) means the **historic** `acp`, not a slug
 * derived from the command. A user who has never named his agent keeps the
 * provider id - and the `providers.acp.settings` block - he has today; the id
 * only becomes `acp-<id>` when the user asked for it by naming the agent.
 *
 * Note: an empty slug yields {@link PROVIDER_ID} too. `readAgent` already
 * refuses one, so the case cannot come from a configuration; making the function
 * total here costs nothing and removes a bare `acp-` from the reachable set.
 */
export const providerIdOf = (slug: string | undefined): string =>
  slug === undefined || slug === "" ? PROVIDER_ID : `${PROVIDER_PREFIX}${slug}`

// ─────────────────────────────────────────────────────────────────────────────
// Announced limits and capabilities
// ─────────────────────────────────────────────────────────────────────────────

/** Context window and maximum output, as announced to OpenCode. */
export interface ModelLimits {
  readonly context: number
  readonly output: number
}

/**
 * Default limits - **declared values, not known values**.
 *
 * Note: ACP publishes no model capability, so there is nothing to read, and
 * `Model.Info` requires `limit.context` and `limit.output`. 200 000 / 32 000 -
 * the values `@opencode/schema` itself falls back to - are announced instead of
 * `0` (which would suggest a null window) or `Number.MAX_SAFE_INTEGER` (which
 * would prevent any compaction).
 *
 * `limit.context` is the only place an error is expensive: it is the compaction
 * threshold. A value that is **too large** merely delays compaction, which the
 * ACP agent decides on its own side; too small a value would truncate
 * conversations long before the agent wants it. Hence a high, prudent value and
 * a per-agent setting (`options.limits`).
 */
export const DEFAULT_LIMITS: ModelLimits = { context: 200_000, output: 32_000 }

/** What the transport can actually render on input and output. */
export interface RawCapabilities {
  readonly tools: boolean
  readonly input: readonly string[]
  readonly output: readonly string[]
}

/**
 * Note: `input: ["text"]` even though `copilot --acp` declares
 * `promptCapabilities.image` and `embeddedContext: true` is a deliberate choice,
 * not an oversight. The reducer (`adapters/opencode-protocol.ts`) can only
 * render text - an image announced here would make OpenCode believe it can send
 * one, and the agent would receive an empty message. Lying here produces a
 * **silent** failure; announcing `["text"]` produces a refusal, in the right
 * place.
 *
 * `tools: true` is exact: the agent proposes, OpenCode executes.
 */
export const DEFAULT_CAPABILITIES: RawCapabilities = { tools: true, input: ["text"], output: ["text"] }

// ─────────────────────────────────────────────────────────────────────────────
// Published raw shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `Model.Info` variant, in raw form.
 *
 * Note: there is deliberately **no** `"default"` variant: OpenCode reads the id
 * `"default"` as "no variant" and does **not** merge its `settings` (see
 * `ModelResolver`). A `default` variant carrying `{ effort: ... }` would
 * therefore be silently ignored. With no variant selected, no `effort` is sent
 * and the agent applies its own `currentValue`: that is the correct behaviour
 * and it does not need to be published.
 */
export interface RawVariant {
  readonly id: string
  /** Values merged by OpenCode into the provider settings. */
  readonly settings: Readonly<Record<string, string>>
}

/** A `Model.Info` in raw form: what `/model` must be able to display. */
export interface RawModelInfo {
  readonly id: string
  readonly name: string
  readonly capabilities: RawCapabilities
  readonly limit: ModelLimits
  readonly variants: readonly RawVariant[]
}

/** A `Provider.Info` in raw form. */
export interface RawProviderInfo {
  readonly id: string
  readonly name: string
  /**
   * Always `"enabled"`: at this point of `setup` the agent has already answered
   * `initialize`, so the provider is reachable. `"auto"` - the value of
   * `Provider.Info.empty` - would not prove that; and on a stdio transport there
   * is no identifier to ask for, so nothing is deferred.
   */
  readonly activation: "enabled"
  /** **Absolute** `file://` URL of the module exporting `model`. */
  readonly package: string
  /** Settings handed back as-is to `model(modelID, settings)`. */
  readonly settings: Readonly<Record<string, unknown>>
}

// ─────────────────────────────────────────────────────────────────────────────
// Publish options
// ─────────────────────────────────────────────────────────────────────────────

/** What the plugin knows about the agent and the inventory does not. */
export interface PublishOptions {
  /** Provider id; `PROVIDER_ID` otherwise. See {@link providerIdOf}. */
  readonly id?: string
  /** Readable provider label, e.g. `"ACP - Copilot"`. */
  readonly label?: string
  /** Provider settings, handed back to `model()`. */
  readonly settings?: Readonly<Record<string, unknown>>
  /** Announced limits; `DEFAULT_LIMITS` otherwise. */
  readonly limits?: ModelLimits
}

// ─────────────────────────────────────────────────────────────────────────────
// `Inventory` -> raw shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Values of the `model` category that are **not** models.
 *
 * Note: `auto` is a **pseudo-value**: the agent picks the model on every turn
 * and does not say which. It is therefore filtered out, for three reasons:
 *
 * 1. a `Model.Info` promises a *deterministic* model - that is what lets
 *    OpenCode display limits and a cost, and lets the adapter send
 *    `set_config_option("model", ...)` with a stable value. Under `auto` all
 *    three would be wrong without ever saying so;
 * 2. the limits would vary from turn to turn; announcing the current model's
 *    would be false information;
 * 3. keeping it would give the user the impression of an extra model whose
 *    choice they do not control.
 */
export const PSEUDO_MODEL_IDS: readonly string[] = ["auto"]

const isPseudoModel = (id: string): boolean => {
  const normalized = id.trim().toLowerCase()
  return PSEUDO_MODEL_IDS.some((pseudo) => pseudo === normalized)
}

/**
 * A model's display name.
 *
 * `AcpModel.name` comes from the agent (an ACP `name`, or the value as a
 * fallback), so it is already readable. It is deliberately not "prettified":
 * capitalising an identifier by a rule of our own invention would produce
 * `Gpt 5.6 Terra` where the agent shows `GPT-5.6 Terra`, and the model in
 * `/model` would no longer look like the agent's.
 */
const displayName = (model: AcpModel): string => (model.name.trim() === "" ? model.id : model.name)

/**
 * ACP effort levels become `variants`.
 *
 * Note: each variant's `settings` is exactly `{ effort: <level> }`, the field
 * `src/settings.ts` reads; the adapter turns it into
 * `set_config_option("reasoning_effort", ...)` before the prompt. Levels are
 * **deduplicated and filtered**: an agent repeating a value would produce two
 * variants with the same id, and OpenCode then rejects the whole model when
 * resolving the variant.
 */
export const effortVariants = (inventory: Inventory): readonly RawVariant[] => {
  const variants: RawVariant[] = []
  const seen = new Set<string>()
  for (const level of inventory.thoughtLevels) {
    if (level.trim() === "" || seen.has(level)) continue
    seen.add(level)
    variants.push({ id: level, settings: { effort: level } })
  }
  return variants
}

/**
 * One `Model.Info` per value of the `model` category.
 *
 * Note: the agent's **order is preserved**: it is the display order it chose,
 * and reordering by family or by date would impose a nomenclature we do not
 * control. Only pseudo-values are removed, and duplicate ids are ignored (first
 * one wins): OpenCode refuses a catalogue containing two models with the same
 * id, and warning here beats inventing an identifier to tell them apart.
 */
export const inventoryToModels = (
  inventory: Inventory,
  options: PublishOptions = {},
): readonly RawModelInfo[] => {
  const limit = options.limits ?? DEFAULT_LIMITS
  const variants = effortVariants(inventory)
  const models: RawModelInfo[] = []
  const seen = new Set<string>()
  for (const model of inventory.models) {
    if (isPseudoModel(model.id)) continue
    if (seen.has(model.id)) continue
    seen.add(model.id)
    models.push({
      id: model.id,
      name: displayName(model),
      capabilities: DEFAULT_CAPABILITIES,
      limit,
      variants,
    })
  }
  return models
}

/**
 * The `Provider.Info` to register.
 *
 * `Provider.Info.empty(id)` only provides an `id`, a `name` equal to that id
 * and an `activation` of `"auto"`: `package` (mandatory) and our `name` are
 * missing. The raw shape is therefore built here, and `src/plugin.ts` applies it
 * on top of `empty` - the only way to inherit the fields OpenCode may add to
 * `Provider.Info` without reinventing them.
 */
export const providerInfo = (options: PublishOptions, packageURL: string): RawProviderInfo => ({
  id: options.id ?? PROVIDER_ID,
  name: options.label?.trim() === "" || options.label === undefined ? "ACP" : options.label,
  activation: "enabled",
  package: packageURL,
  settings: options.settings ?? {},
})

/**
 * A signature of an inventory, so only what changed is **republished**.
 *
 * Note: `ctx.provider.reload()` rebuilds the whole catalogue: calling it
 * without reason would make `/model` reload and lose the current selection.
 * This signature - ids, names, effort levels, current model - is the smallest
 * summary that tells "the inventory moved" from "the agent simply answered the
 * same". It is not cryptographic: its only job is to tell two captures apart,
 * not to authenticate them.
 */
export const inventorySignature = (inventory: Inventory): string =>
  JSON.stringify([
    inventory.models.map((model) => [model.id, model.name]),
    inventory.thoughtLevels,
    inventory.currentModel ?? null,
    inventory.currentThoughtLevel ?? null,
  ])

// ─────────────────────────────────────────────────────────────────────────────
// Plugin options (`opencode.jsonc` -> `plugins[].options`)
// ─────────────────────────────────────────────────────────────────────────────

/** An agent declared in the plugin options, before validation by `settings.ts`. */
export interface RawAgent {
  /** Label chosen by the user; used for messages, not for the provider. */
  readonly id: string
  /**
   * The `id` the user **explicitly** gave, normalised; `undefined` when none.
   *
   * Note: distinct from `id`, which falls back to the command so that every log
   * line can name the agent. The distinction is the whole backward-compatibility
   * story: an unnamed agent keeps the historic `acp` provider id, a named one
   * gets `acp-<slug>` (see {@link providerIdOf}). Folding the two together
   * would silently rename the provider of every existing configuration. It is
   * optional because an agent that names nothing simply has none - and because a
   * hand-built `RawAgent` (a test fixture, mostly) should not have to say so.
   */
  readonly providerSlug?: string | undefined
  readonly command: string
  readonly args: readonly string[] | undefined
  readonly cwd: string | undefined
  readonly env: Readonly<Record<string, string>> | undefined
  /** Note: only drives an all-or-nothing switch today, cf. `settings.allowedTools`. */
  readonly allowedTools: readonly string[] | undefined
  /** Limits announced for this agent's models. */
  readonly limits: ModelLimits | undefined
}

/** Normalised plugin options. */
export interface PluginConfig {
  readonly agents: readonly RawAgent[]
  /**
   * Minimum delay between two rediscoveries, in ms. `0` disables refreshing.
   *
   * Note: this is **not** a polling period. The plugin only re-examines the
   * inventory when OpenCode signals a finished turn (`session.idle`), and at
   * most once per `refreshMs`. Each pass costs a `session/new` round trip -
   * hence a minute by default rather than a second.
   */
  readonly refreshMs: number
  /**
   * Bounds on the **discovery**: agent launch, `initialize`, inventory capture.
   *
   * Note: this is the only place in the project where a wait can block
   * OpenCode's startup: `setup()` is awaited by the host before it yields, so a
   * mute agent does not cause "no provider registered", it causes "OpenCode does
   * not start". Hence two bounds, not one.
   */
  readonly discoveryTimeoutMs: number
  /**
   * **Inactivity** bound: maximum delay without any sign of life from the agent.
   *
   * Note: it catches what the global bound does not - an agent that rambles
   * without ever finishing (authentication loop, permanent network
   * reconnection) never stops, but it is no longer mute: without this bound
   * `setup` would wait it out until the global bound, and the user would see
   * OpenCode's startup stop "for a reason" with no error shown.
   */
  readonly discoveryIdleTimeoutMs: number
}

/** Result of `parsePluginConfig`: never an exception, always a diagnostic. */
export type PluginConfigResult =
  | { readonly ok: true; readonly value: PluginConfig }
  | { readonly ok: false; readonly message: string }

/** Agent used when the plugin is configured without `agents`. */
export const DEFAULT_AGENT: RawAgent = {
  id: "copilot",
  providerSlug: undefined,
  command: "copilot",
  args: ["--acp"],
  cwd: undefined,
  env: undefined,
  allowedTools: undefined,
  limits: undefined,
}

/** Default minimum delay between two rediscoveries. */
export const DEFAULT_REFRESH_MS = 60_000

/**
 * Default discovery bounds, in ms - 10 s, matching `opencode-acpx`.
 *
 * Note: 10 s rather than the 30 s `initialize` timeout of `createAcpAgent`,
 * because what is at stake is not patience but **OpenCode's startup**. Thirty
 * seconds of frozen screen at boot, with no message, are indistinguishable
 * from a crash; ten seconds still are not. A genuinely slow agent is handled
 * with `discoveryTimeoutMs` - that is an option, not a freeze.
 */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000

/** Default inactivity bound, in ms: same order of magnitude as the global one. */
export const DEFAULT_DISCOVERY_IDLE_TIMEOUT_MS = 10_000

/** The default discovery bounds, ready to spread into a `PluginConfig`. */
const DEFAULT_BOUNDS = {
  refreshMs: DEFAULT_REFRESH_MS,
  discoveryTimeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS,
  discoveryIdleTimeoutMs: DEFAULT_DISCOVERY_IDLE_TIMEOUT_MS,
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Uniform error message, carrying the path of the offending field. */
const invalid = (path: string, expected: string): { readonly ok: false; readonly message: string } => ({
  ok: false,
  message: `options.${path} ${expected}`,
})

const readStringArray = (
  input: Record<string, unknown>,
  path: string,
  key: string,
): { readonly ok: true; readonly value: readonly string[] | undefined } | { readonly ok: false; readonly message: string } => {
  const raw = input[key]
  if (raw === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(raw)) return invalid(`${path}.${key}`, "doit être un tableau de chaînes")
  // **Copy** rather than returning the received array: `Array.isArray` proves
  // nothing about its element type, and a copy built here is necessarily a
  // `string[]`, with no need to lie about the typing.
  const values: string[] = []
  for (const item of raw) {
    if (typeof item !== "string") return invalid(`${path}.${key}`, "doit être un tableau de chaînes")
    values.push(item)
  }
  return { ok: true, value: values }
}

const readStringRecord = (
  input: Record<string, unknown>,
  path: string,
  key: string,
): { readonly ok: true; readonly value: Record<string, string> | undefined } | { readonly ok: false; readonly message: string } => {
  const raw = input[key]
  if (raw === undefined) return { ok: true, value: undefined }
  if (!isRecord(raw)) return invalid(`${path}.${key}`, "doit être un objet de chaînes")
  const entries: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string") return invalid(`${path}.${key}.${name}`, "doit être une chaîne")
    entries[name] = value
  }
  return { ok: true, value: entries }
}

const readLimits = (
  input: Record<string, unknown>,
  path: string,
): { readonly ok: true; readonly value: ModelLimits | undefined } | { readonly ok: false; readonly message: string } => {
  const raw = input["limits"]
  if (raw === undefined) return { ok: true, value: undefined }
  if (!isRecord(raw)) return invalid(`${path}.limits`, "doit être un objet { context, output }")
  const context = raw["context"]
  const output = raw["output"]
  if (typeof context !== "number" || !Number.isInteger(context) || context <= 0) {
    return invalid(`${path}.limits.context`, "doit être un entier positif")
  }
  if (typeof output !== "number" || !Number.isInteger(output) || output <= 0) {
    return invalid(`${path}.limits.output`, "doit être un entier positif")
  }
  return { ok: true, value: { context, output } }
}

/**
 * Validates an agent entry.
 *
 * Note: `command` is the **only** mandatory field, and an empty command is a
 * flat error: without it the plugin would try to spawn an empty command and the
 * failure would surface in OpenCode's log as a mysterious `ENOENT`. Everything
 * else is optional, and an unknown key is ignored rather than rejected (same
 * reasoning as `parseSettings`: OpenCode may add its own).
 */
const readAgent = (
  raw: unknown,
  path: string,
): { readonly ok: true; readonly value: RawAgent } | { readonly ok: false; readonly message: string } => {
  if (!isRecord(raw)) return invalid(path, "doit être un objet { command, args?, cwd?, env? }")
  const command = raw["command"]
  if (typeof command !== "string" || command.trim() === "") {
    return invalid(`${path}.command`, 'est obligatoire (ex. "copilot")')
  }
  const id = raw["id"]
  if (id !== undefined && typeof id !== "string") return invalid(`${path}.id`, "doit être une chaîne")
  // An explicit `id` becomes a **provider id**, hence a slug: validated here,
  // where the path of the offending field is still known, and not at
  // registration, where it would only be one more anonymous failure among the
  // agents. An id that normalises to nothing (`"///"`) is refused rather than
  // silently falling back to `acp`: the user asked for a name, and giving him
  // the default would hide the typo behind a working configuration.
  const providerSlug = id === undefined || id.trim() === "" ? undefined : normalizeProviderSlug(id)
  if (providerSlug === "") {
    return invalid(
      `${path}.id`,
      'ne contient aucun caractère utilisable dans un identifiant (attendu : lettres, chiffres, "-" ; ex. "copilot")',
    )
  }
  const args = readStringArray(raw, path, "args")
  if (!args.ok) return args
  const cwd = raw["cwd"]
  if (cwd !== undefined && typeof cwd !== "string") return invalid(`${path}.cwd`, "doit être une chaîne")
  const env = readStringRecord(raw, path, "env")
  if (!env.ok) return env
  const allowedTools = readStringArray(raw, path, "allowedTools")
  if (!allowedTools.ok) return allowedTools
  const limits = readLimits(raw, path)
  if (!limits.ok) return limits

  return {
    ok: true,
    value: {
      // The `id` is a label: falling back to the command guarantees that every
      // log line can name the agent, even if the user gave none.
      id: id === undefined || id.trim() === "" ? command : id,
      providerSlug,
      command,
      args: args.value,
      cwd: cwd === undefined ? undefined : cwd,
      env: env.value,
      allowedTools: allowedTools.value,
      limits: limits.value,
    },
  }
}

/**
 * Reads the plugin options (`opencode.jsonc` -> `plugins[].options`).
 *
 * Note: an absent or empty `agents` yields `DEFAULT_AGENT` (`copilot --acp`)
 * rather than an error: a plugin that fails to load takes the whole plugin list
 * down with it, and "nothing configured" almost always means "the default
 * agent".
 *
 * Note: unknown plugin keys are ignored, never rejected (cf. `readAgent`).
 */
export const parsePluginConfig = (input: unknown): PluginConfigResult => {
  if (input === undefined || input === null) {
    return { ok: true, value: { agents: [DEFAULT_AGENT], ...DEFAULT_BOUNDS } }
  }
  if (!isRecord(input)) {
    return {
      ok: false,
      message:
        'options doit être un objet, par exemple { "agents": [{ "command": "copilot", "args": ["--acp"] }] }',
    }
  }

  const refreshMs = input["refreshMs"]
  if (
    refreshMs !== undefined &&
    (typeof refreshMs !== "number" || !Number.isFinite(refreshMs) || refreshMs < 0)
  ) {
    return invalid("refreshMs", "doit être un nombre de millisecondes ≥ 0 (0 désactive le rafraîchissement)")
  }

  // The two discovery bounds are validated **here** rather than read as-is: a
  // negative or non-finite bound would not bound anything, and the worst case
  // for a timeout is to be infinite.
  const discoveryTimeoutMs = input["discoveryTimeoutMs"]
  if (
    discoveryTimeoutMs !== undefined &&
    (typeof discoveryTimeoutMs !== "number" ||
      !Number.isFinite(discoveryTimeoutMs) ||
      discoveryTimeoutMs <= 0)
  ) {
    return invalid(
      "discoveryTimeoutMs",
      "doit être un nombre de millisecondes strictement positif (borne haute de la découverte)",
    )
  }
  const discoveryIdleTimeoutMs = input["discoveryIdleTimeoutMs"]
  if (
    discoveryIdleTimeoutMs !== undefined &&
    (typeof discoveryIdleTimeoutMs !== "number" ||
      !Number.isFinite(discoveryIdleTimeoutMs) ||
      discoveryIdleTimeoutMs <= 0)
  ) {
    return invalid(
      "discoveryIdleTimeoutMs",
      "doit être un nombre de millisecondes strictement positif (borne d'inactivité de l'agent)",
    )
  }

  const bounds = {
    refreshMs: refreshMs ?? DEFAULT_REFRESH_MS,
    discoveryTimeoutMs: discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    discoveryIdleTimeoutMs: discoveryIdleTimeoutMs ?? DEFAULT_DISCOVERY_IDLE_TIMEOUT_MS,
  }

  const raw = input["agents"]
  if (raw === undefined) {
    return { ok: true, value: { agents: [DEFAULT_AGENT], ...bounds } }
  }
  if (!Array.isArray(raw)) {
    return invalid("agents", 'doit être un tableau d\'objets [{ "command": "copilot", "args": ["--acp"] }]')
  }
  if (raw.length === 0) {
    return { ok: true, value: { agents: [DEFAULT_AGENT], ...bounds } }
  }

  const agents: RawAgent[] = []
  for (const [index, entry] of raw.entries()) {
    const agent = readAgent(entry, `agents[${index}]`)
    if (!agent.ok) return agent
    agents.push(agent.value)
  }
  return { ok: true, value: { agents, ...bounds } }
}

/**
 * Settings published for the agent, handed back to `model()` by OpenCode.
 *
 * Note: two things are deliberately left out: `id` (a label, meaningless to the
 * provider) and `limits` (a catalogue display value, not a request parameter -
 * keeping it would send a `limits` key that `parseSettings` ignores on every
 * turn). Undefined fields are **omitted** rather than set: they would otherwise
 * overwrite, at merge time, the value the user put in `opencode.jsonc` under
 * `providers.acp.settings`.
 *
 * Note: `providerId` **is** published, and only when it differs from the
 * default. `model(modelID, settings)` receives no other trace of which provider
 * it is building a route for, so this key is the sole place the id can travel -
 * and omitting it for the default `acp` leaves a hand-written
 * `providers.acp.settings` exactly as the user wrote it.
 */
export const providerSettingsOf = (
  agent: RawAgent,
  providerId: string = PROVIDER_ID,
): Readonly<Record<string, unknown>> => ({
  command: agent.command,
  ...(agent.args === undefined ? {} : { args: [...agent.args] }),
  ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
  ...(agent.env === undefined ? {} : { env: { ...agent.env } }),
  ...(agent.allowedTools === undefined ? {} : { allowedTools: [...agent.allowedTools] }),
  ...(providerId === PROVIDER_ID ? {} : { provider: providerId }),
})
