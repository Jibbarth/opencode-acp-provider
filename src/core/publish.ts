/**
 * Publication de l'inventaire ACP dans le catalogue d'OpenCode — PLAN.md §5, §6.
 *
 * ⚠️ Ce module est **pur** : il n'importe ni `@opencode/plugin`, ni
 * `@opencode/schema`, ni `effect`, ni le SDK ACP. Il ne produit donc **pas** des
 * `Model.Info` / `Provider.Info` : ce sont des types d'un paquet versionné au
 * même rythme que l'hôte, et les faire apparaître ici transformerait le cœur
 * portable (§2.1) en extension d'OpenCode.
 *
 * On travaille donc sur des **formes brutes** (`RawModelInfo`, `RawProviderInfo`),
 * construites à partir du contrat portable `Inventory` — lui-même déjà vérifié
 * par `core/models.ts`. La conversion typée (`Model.Info.default`,
 * `Provider.Info.empty`, `Model.ID.make`…) se fait dans `src/plugin.ts`, qui est
 * le seul fichier à dépendre de l'API plugin.
 *
 * Le découpage a un bénéfice de testabilité direct : tout ce qui décide *ce
 * qu'OpenCode voit* — les limites, le filtrage de `auto`, la forme des variants
 * d'effort — se teste sans process, sans import et sans serveur.
 */

import type { AcpModel, Inventory } from "./types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Identité
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identifiant du provider publié.
 *
 * ⚠️ Il doit rester **égal** à `PROVIDER` (`adapters/opencode-transport.ts`) :
 * c'est cet identifiant que la route déclare, et OpenCode apparie le modèle au
 * provider par `(providerID, modelID)`. Deux valeurs divergentes ne casseraient
 * pas à la compilation — les deux fichiers n'ont rien en commun — mais
 * produiraient un modèle invisible dans `/model`, ce qui est pire qu'une erreur.
 */
export const PROVIDER_ID = "acp"

// ─────────────────────────────────────────────────────────────────────────────
// Limites et capacités annoncées
// ─────────────────────────────────────────────────────────────────────────────

/** Fenêtre de contexte et sortie maximale, telles qu'annoncées à OpenCode. */
export interface ModelLimits {
  readonly context: number
  readonly output: number
}

/**
 * Limites par défaut — **des valeurs déclarées, pas des valeurs connues**.
 *
 * ⚠️ ACP ne publie aucune capacité de modèle : il n'y a donc rien à lire, et
 * `Model.Info` exige `limit.context` et `limit.output`. On annonce donc
 * 200 000 / 32 000, les valeurs que `@opencode/schema` lui-même retient par
 * défaut, plutôt que `0` (qui ferait croire à une fenêtre nulle) ou
 * `Number.MAX_SAFE_INTEGER` (qui empêcherait toute compaction).
 *
 * Le seul endroit où une erreur se paie cher est `limit.context` : il sert de
 * seuil de compaction. Une valeur **trop grande** ne fait que retarder la
 * compaction, que l'agent ACP décide de son côté ; une valeur trop petite
 * tronquerait des conversations bien avant que l'agent ne le souhaite. D'où le
 * choix d'une valeur haute et prudente, et d'un point de réglage par agent
 * (`options.limits`).
 */
export const DEFAULT_LIMITS: ModelLimits = { context: 200_000, output: 32_000 }

/** Ce que le transport sait réellement rendre en entrée et en sortie. */
export interface RawCapabilities {
  readonly tools: boolean
  readonly input: readonly string[]
  readonly output: readonly string[]
}

/**
 * ⚠️ `input: ["text"]` alors que `copilot --acp` déclare `promptCapabilities.image`
 * et `embeddedContext: true` : c'est un choix, pas un oubli. Le réducteur
 * (`adapters/opencode-protocol.ts`) ne sait rendre que du texte — une image
 * annoncée ici ferait croire à OpenCode qu'il peut en envoyer une, et l'agent
 * recevrait un message vide. Mentir ici produirait un échec **muet** ;
 * annoncer `["text"]` produit un refus, au bon endroit.
 *
 * `tools: true` est exact : c'est le cœur du mécanisme §7.3 — l'agent propose,
 * OpenCode exécute.
 */
export const DEFAULT_CAPABILITIES: RawCapabilities = { tools: true, input: ["text"], output: ["text"] }

// ─────────────────────────────────────────────────────────────────────────────
// Formes brutes publiées
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un `variant` de `Model.Info`, en forme brute.
 *
 * ⚠️ Il n'y a **pas** de variant `"default"`, et c'est délibéré : OpenCode
 * interprète l'id `"default"` comme « aucun variant » et **n'en fusionne pas les
 * `settings`** (cf. `ModelResolver`). Un variant `default` portant
 * `{ effort: … }` serait donc silencieusement ignoré. Sans variant sélectionné,
 * aucun `effort` n'est envoyé et l'agent applique son propre `currentValue` :
 * c'est le comportement correct, et il n'a pas besoin d'être publié.
 */
export interface RawVariant {
  readonly id: string
  /** Valeurs fusionnées par OpenCode dans les settings du provider (§3.1). */
  readonly settings: Readonly<Record<string, string>>
}

/** Un `Model.Info` en forme brute : ce que `/model` doit pouvoir afficher. */
export interface RawModelInfo {
  readonly id: string
  readonly name: string
  readonly capabilities: RawCapabilities
  readonly limit: ModelLimits
  readonly variants: readonly RawVariant[]
}

/** Un `Provider.Info` en forme brute. */
export interface RawProviderInfo {
  readonly id: string
  readonly name: string
  /**
   * Toujours `"enabled"` : à cet instant du `setup`, l'agent a déjà répondu à
   * `initialize`, donc le provider est joignable. `"auto"` — la valeur de
   * `Provider.Info.empty` — ne le prouverait pas ; et sur un transport stdio il
   * n'y a aucun identifiant à demander, donc rien à différer.
   */
  readonly activation: "enabled"
  /** URL `file://` **absolue** du module exportant `model` (§3.1). */
  readonly package: string
  /** Réglages repris tels quels par `model(modelID, settings)` (§3.1). */
  readonly settings: Readonly<Record<string, unknown>>
}

// ─────────────────────────────────────────────────────────────────────────────
// Options de publication
// ─────────────────────────────────────────────────────────────────────────────

/** Ce que le plugin sait de l'agent, et qui n'est pas dans l'inventaire. */
export interface PublishOptions {
  /** Étiquette lisible du provider, p. ex. `"ACP — Copilot"`. */
  readonly label?: string
  /** Réglages du provider, repris par `model()` (§3.1). */
  readonly settings?: Readonly<Record<string, unknown>>
  /** Limites annoncées ; `DEFAULT_LIMITS` sinon. */
  readonly limits?: ModelLimits
}

// ─────────────────────────────────────────────────────────────────────────────
// `Inventory` → formes brutes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valeurs de la catégorie `model` qui ne sont **pas** des modèles.
 *
 * ⚠️ `auto` est une **pseudo-valeur** : c'est l'agent qui choisit le modèle à
 * chaque tour, et il ne le dit pas. On la filtre donc, pour trois raisons :
 *
 * 1. un `Model.Info` promet un modèle *déterministe* — c'est ce qui permet à
 *    OpenCode d'afficher des limites, un coût, et à l'adaptateur d'envoyer
 *    `set_config_option("model", …)` avec une valeur stable. Sous `auto`, les
 *    trois seraient faux sans jamais le dire ;
 * 2. les limites varieraient d'un tour à l'autre ; annoncer celles du modèle
 *    courant serait une information fausse ;
 * 3. la garder donnerait à l'utilisateur l'impression d'un modèle supplémentaire
 *    alors qu'il n'en contrôle pas le choix.
 *
 * Le §5.2 laissait le choix ouvert ; on le tranche ici, et l'inventaire reste
 * lisible dans `/model` sans elle.
 */
export const PSEUDO_MODEL_IDS: readonly string[] = ["auto"]

const isPseudoModel = (id: string): boolean => {
  const normalized = id.trim().toLowerCase()
  return PSEUDO_MODEL_IDS.some((pseudo) => pseudo === normalized)
}

/**
 * Libellé d'un modèle.
 *
 * `AcpModel.name` vient de l'agent (un `name` ACP, ou à défaut la valeur), donc
 * il est déjà lisible. On ne le « embellit » pas : capitaliser un identifiant
 * selon une règle de notre invention produirait `Gpt 5.6 Terra` là où l'agent
 * affiche `GPT-5.6 Terra`, et le modèle dans `/model` ne ressemblerait plus à
 * celui de `/model` côté agent.
 */
const displayName = (model: AcpModel): string => (model.name.trim() === "" ? model.id : model.name)

/**
 * Les niveaux d'effort ACP deviennent des `variants` (§5).
 *
 * ⚠️ Le `settings` de chaque variant est exactement `{ effort: <niveau> }`, le
 * champ que lit `src/settings.ts` ; l'adaptateur le traduit en
 * `set_config_option("reasoning_effort", …)` avant le prompt. Les niveaux sont
 * **dédupliqués et filtrés** : un agent qui répète une valeur donnerait deux
 * variants de même id, et OpenCode rejette alors le modèle entier au moment de
 * résoudre le variant.
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
 * Un `Model.Info` par valeur de la catégorie `model` (§5).
 *
 * ⚠️ L'ordre de l'agent est **conservé** : c'est l'ordre d'affichage qu'il a
 * choisi, et le réordonner par famille ou par date imposerait ici une
 * nomenclature qu'on ne maîtrise pas. Seules les pseudo-valeurs sont retirées,
 * et les doublons d'id sont ignorés (premier exemplaire gagnant) : OpenCode
 * refuse un catalogue contenant deux modèles de même id, et le signalement ici
 * vaut mieux qu'un identifiant inventé pour les distinguer.
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
 * Le `Provider.Info` à enregistrer (§6).
 *
 * `Provider.Info.empty(id)` ne fournit qu'un `id`, un `name` égal à l'id et une
 * `activation` à `"auto"` : il manque `package` (obligatoire) et notre `name`.
 * On construit donc la forme brute ici, et `src/plugin.ts` l'applique sur le
 * `empty` — c'est le seul moyen d'hériter des champs qu'OpenCode ajoutera au
 * `Provider.Info` sans les réinventer.
 */
export const providerInfo = (options: PublishOptions, packageURL: string): RawProviderInfo => ({
  id: PROVIDER_ID,
  name: options.label?.trim() === "" || options.label === undefined ? "ACP" : options.label,
  activation: "enabled",
  package: packageURL,
  settings: options.settings ?? {},
})

/**
 * Empreinte d'un inventaire, pour ne **republier** que ce qui a changé.
 *
 * ⚠️ `ctx.provider.reload()` reconstruit tout le catalogue : l'appeler sans
 * raison ferait recharger `/model` et perdre la sélection en cours. Cette
 * signature — ids, noms, niveaux d'effort, modèle courant — est le plus petit
 * résumé qui distingue « l'inventaire a bougé » de « l'agent a simplement
 * répondu pareil ». Elle n'est pas cryptographique : son seul job est de
 * distinguer deux relevés, pas de les authentifier.
 */
export const inventorySignature = (inventory: Inventory): string =>
  JSON.stringify([
    inventory.models.map((model) => [model.id, model.name]),
    inventory.thoughtLevels,
    inventory.currentModel ?? null,
    inventory.currentThoughtLevel ?? null,
  ])

// ─────────────────────────────────────────────────────────────────────────────
// Options du plugin (`opencode.jsonc` → `plugins[].options`)
// ─────────────────────────────────────────────────────────────────────────────

/** Un agent déclaré dans les options du plugin, avant validation par `settings.ts`. */
export interface RawAgent {
  /** Étiquette choisie par l'utilisateur ; sert aux messages, pas au provider. */
  readonly id: string
  readonly command: string
  readonly args: readonly string[] | undefined
  readonly cwd: string | undefined
  readonly env: Readonly<Record<string, string>> | undefined
  /** ⚠️ ne sert aujourd'hui qu'à un interrupteur tout-ou-rien, cf. `settings.allowedTools`. */
  readonly allowedTools: readonly string[] | undefined
  /** Limites annoncées pour les modèles de cet agent. */
  readonly limits: ModelLimits | undefined
}

/** Options du plugin, normalisées. */
export interface PluginConfig {
  readonly agents: readonly RawAgent[]
  /**
   * Délai minimum entre deux redécouvertes, en ms. `0` désactive le rafraîchissement.
   *
   * ⚠️ Ce n'est **pas** une période de polling : le plugin ne réexamine
   * l'inventaire que lorsqu'OpenCode signale un tour terminé (`session.idle`),
   * et au plus une fois par `refreshMs`. Chaque passe coûte un aller-retour
   * `session/new` — d'où une minute par défaut, et non une seconde.
   */
  readonly refreshMs: number
}

/** Résultat de `parsePluginConfig` : jamais une exception, toujours un diagnostic. */
export type PluginConfigResult =
  | { readonly ok: true; readonly value: PluginConfig }
  | { readonly ok: false; readonly message: string }

/** Agent retenu quand le plugin est configuré sans `agents`. */
export const DEFAULT_AGENT: RawAgent = {
  id: "copilot",
  command: "copilot",
  args: ["--acp"],
  cwd: undefined,
  env: undefined,
  allowedTools: undefined,
  limits: undefined,
}

/** Délai minimum par défaut entre deux redécouvertes. */
export const DEFAULT_REFRESH_MS = 60_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Message d'erreur homogène, avec le chemin du champ fautif — comme `settings.ts`. */
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
  // On **recopie** plutôt que de rendre le tableau reçu : `Array.isArray` ne
  // prouve rien sur le type de ses éléments, et une copie construite ici est
  // nécessairement un `string[]` — sans avoir à mentir sur le typage.
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
 * Valide une entrée d'agent.
 *
 * ⚠️ `command` est le **seul** champ obligatoire, et une commande vide est une
 * erreur franche : sans elle, le plugin tenterait de lancer une commande vide et
 * l'échec remonterait dans le journal d'OpenCode sous la forme d'un `ENOENT`
 * mystérieux. Tout le reste est facultatif, et une clé inconnue est ignorée
 * plutôt que rejetée (même raisonnement que `parseSettings` : OpenCode peut
 * ajouter les siennes).
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
      // L'`id` est une étiquette : le retomber sur la commande garantit que
      // chaque ligne de journal peut nommer l'agent, même si l'utilisateur n'en
      // a pas donné.
      id: id === undefined || id.trim() === "" ? command : id,
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
 * Lit les options du plugin (`opencode.jsonc` → `plugins[].options`).
 *
 * ⚠️ `agents` absent ou vide donne `DEFAULT_AGENT` (`copilot --acp`) plutôt
 * qu'une erreur : un plugin qui ne se charge pas entraîne toute la liste de
 * plugins avec lui, et « rien de configuré » signifie presque toujours
 * « l'agent par défaut » — c'est ce que §5.1 relève sur `copilot --acp`.
 *
 * ⚠️ Les clés inconnues du plugin sont ignorées, jamais rejetées (cf. `readAgent`).
 */
export const parsePluginConfig = (input: unknown): PluginConfigResult => {
  if (input === undefined || input === null) {
    return { ok: true, value: { agents: [DEFAULT_AGENT], refreshMs: DEFAULT_REFRESH_MS } }
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

  const raw = input["agents"]
  if (raw === undefined) {
    return {
      ok: true,
      value: { agents: [DEFAULT_AGENT], refreshMs: refreshMs ?? DEFAULT_REFRESH_MS },
    }
  }
  if (!Array.isArray(raw)) {
    return invalid("agents", 'doit être un tableau d\'objets [{ "command": "copilot", "args": ["--acp"] }]')
  }
  if (raw.length === 0) {
    return { ok: true, value: { agents: [DEFAULT_AGENT], refreshMs: refreshMs ?? DEFAULT_REFRESH_MS } }
  }

  const agents: RawAgent[] = []
  for (const [index, entry] of raw.entries()) {
    const agent = readAgent(entry, `agents[${index}]`)
    if (!agent.ok) return agent
    agents.push(agent.value)
  }
  return { ok: true, value: { agents, refreshMs: refreshMs ?? DEFAULT_REFRESH_MS } }
}

/**
 * Réglages publiés pour l'agent, et redonnés à `model()` par OpenCode (§3.1).
 *
 * ⚠️ Deux choses sont volontairement écartées : `id` (une étiquette, sans
 * sens pour le provider) et `limits` (une valeur d'affichage du catalogue, pas
 * un paramètre de requête — la laisser dans les settings enverrait une clé
 * `limits` que `parseSettings` ignorerait à chaque tour). Les champs
 * indéfinis sont **omis** plutôt que posés : ils écraseraient sinon, à la
 * fusion, la valeur que l'utilisateur a mise dans `opencode.jsonc` sous
 * `providers.acp.settings`.
 */export const providerSettingsOf = (agent: RawAgent): Readonly<Record<string, unknown>> => ({
  command: agent.command,
  ...(agent.args === undefined ? {} : { args: [...agent.args] }),
  ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
  ...(agent.env === undefined ? {} : { env: { ...agent.env } }),
  ...(agent.allowedTools === undefined ? {} : { allowedTools: [...agent.allowedTools] }),
})
