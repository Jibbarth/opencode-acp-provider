/**
 * Tests de la phase P3a : la publication de l'inventaire ACP.
 *
 * Tout ce qui est testé ici est **pur** : aucune fonction de ce fichier ne
 * lance de process, n'ouvre de session et n'importe `@opencode/plugin`. C'est
 * le bénéfice du découpage `core/publish.ts` ↔ `src/plugin.ts` : ce qui décide
 * de ce qu'OpenCode voit dans `/model` se vérifie par des appels de fonction,
 * alors qu'un vrai `copilot --acp` ne permet d'observer qu'un catalogue, dans
 * un serveur, avec l'inventaire déjà changé.
 *
 * Le relevé de référence est celui du §5.1 du plan, mesuré sur `copilot --acp`
 * : 20 valeurs de catégorie `model` (dont `auto`), 6 niveaux d'effort, 3 modes.
 */

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

import {
  DEFAULT_AGENT,
  DEFAULT_LIMITS,
  DEFAULT_REFRESH_MS,
  PSEUDO_MODEL_IDS,
  effortVariants,
  inventorySignature,
  inventoryToModels,
  parsePluginConfig,
  providerInfo,
  providerSettingsOf,
} from "../src/core/publish.js"
import { resolvePackageURL } from "../src/plugin.js"
import { parseSettings } from "../src/settings.js"
import type { AcpMode, AcpOption, Inventory } from "../src/core/types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — le relevé réel du §5.1
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_IDS = [
  "auto",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5-mini",
  "claude-sonnet-5",
  "claude-haiku-4.5",
  "mai-code-1.1-flash",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "grok-4.5",
  "kimi-k3",
  "kimi-k2.7-code",
  "gpt-6-luna",
  "grok-4.6",
  "grok-4.7",
] as const

const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const

const MODES: readonly AcpMode[] = [
  { id: "agent", rawId: "https://agentclientprotocol.com/modes#agent", name: "Agent" },
  { id: "plan", rawId: "https://agentclientprotocol.com/modes#plan", name: "Plan" },
  { id: "autopilot", rawId: "https://agentclientprotocol.com/modes#autopilot", name: "Autopilot" },
]

const option = (id: string, category: string, currentValue: string, values: readonly string[]): AcpOption => ({
  id,
  name: id,
  category,
  type: "select",
  currentValue,
  values,
})

/** L'inventaire mesuré sur `copilot --acp` (agent `Copilot` v1.0.88). */
const copilotInventory = (): Inventory => ({
  models: MODEL_IDS.map((id) =>
    id === "claude-sonnet-5"
      ? { id, name: "Claude Sonnet 5", description: "Le meilleur modèle de codage" }
      : { id, name: id === "auto" ? "Auto" : id },
  ),
  thoughtLevels: [...EFFORTS],
  modes: MODES,
  options: [
    option("mode", "mode", "https://agentclientprotocol.com/modes#agent", MODES.map((m) => m.rawId)),
    option("model", "model", "gpt-5.6-terra", MODEL_IDS),
    option("reasoning_effort", "thought_level", "medium", EFFORTS),
    option("allow_all", "permissions", "off", ["on", "off"]),
  ],
  currentModel: "gpt-5.6-terra",
  currentThoughtLevel: "medium",
  currentMode: "agent",
})

const emptyInventory = (): Inventory => ({ models: [], thoughtLevels: [], modes: [], options: [] })

const ids = (models: readonly { readonly id: string }[]): readonly string[] => models.map((m) => m.id)

// ─────────────────────────────────────────────────────────────────────────────
// `inventoryToModels`
// ─────────────────────────────────────────────────────────────────────────────

describe("inventoryToModels (pur)", () => {
  test("20 valeurs de l'agent donnent 19 modèles : `auto` est filtré", () => {
    const models = inventoryToModels(copilotInventory())
    expect(MODEL_IDS.length).toBe(20)
    expect(models.length).toBe(19)
    expect(ids(models)).not.toContain("auto")
    // Tout le reste est conservé, dans l'ordre de l'agent.
    expect(ids(models)).toEqual(MODEL_IDS.filter((id) => id !== "auto"))
  })

  test("le pseudo-modèle filtré est bien `auto`, et documenté comme tel", () => {
    // Le test verrouille la *décision*, pas seulement le code : un futur
    // `PSEUDO_MODEL_IDS` différent doit faire échouer ce test, pour qu'on se
    // rende compte qu'on change le contrat.
    expect([...PSEUDO_MODEL_IDS]).toEqual(["auto"])
  })

  test("`auto` est filtré quelle que soit sa casse ou son espaces", () => {
    const inventory = copilotInventory()
    const models = inventoryToModels({
      ...inventory,
      models: [{ id: "AUTO", name: "Auto" }, { id: " auto ", name: "Auto" }, { id: "gpt-5.4", name: "GPT-5.4" }],
    })
    expect(ids(models)).toEqual(["gpt-5.4"])
  })

  test("le nom affiché est celui de l'agent, l'id reste l'identifiant ACP", () => {
    const models = inventoryToModels(copilotInventory())
    const sonnet = models.find((model) => model.id === "claude-sonnet-5")
    expect(sonnet?.name).toBe("Claude Sonnet 5")
    // Un modèle sans libellé retombe sur son id plutôt que d'être invisible.
    const bare = models.find((model) => model.id === "gpt-5.4")
    expect(bare?.name).toBe("gpt-5.4")
    expect(models.find((model) => model.id === "gpt-5.4-mini")?.name).toBe("gpt-5.4-mini")
  })

  test("un modèle sans description est publié comme les autres", () => {
    // `AcpModel.description` est facultatif : son absence ne doit ni supprimer le
    // modèle ni le distinguer dans le catalogue.
    const models = inventoryToModels({
      ...copilotInventory(),
      models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
    })
    expect(models.length).toBe(1)
    expect(models[0]?.id).toBe("claude-sonnet-5")
  })

  test("un nom vide retombe sur l'id", () => {
    const models = inventoryToModels({ ...emptyInventory(), models: [{ id: "x-1", name: "  " }] })
    expect(models[0]?.name).toBe("x-1")
  })

  test("les capacités sont textuelles, et `tools` est vrai", () => {
    for (const model of inventoryToModels(copilotInventory())) {
      expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
    }
  })

  test("les limites sont explicites et par défaut, jamais `undefined`", () => {
    // Un `limit` absent ferait échouer `Model.Info` ; un `limit` à 0 ferait croire
    // à une fenêtre nulle. On veut une valeur **déclarée** et constante.
    const model = inventoryToModels(copilotInventory())[0]
    expect(model?.limit).toEqual({ context: 200_000, output: 32_000 })
    expect(DEFAULT_LIMITS).toEqual({ context: 200_000, output: 32_000 })
  })

  test("les limites se règlent par agent, et s'appliquent à tous ses modèles", () => {
    const models = inventoryToModels(copilotInventory(), { limits: { context: 32_000, output: 8_000 } })
    expect(models.length).toBe(19)
    for (const model of models) expect(model.limit).toEqual({ context: 32_000, output: 8_000 })
  })

  test("les niveaux d'effort deviennent des variants réglables", () => {
    const models = inventoryToModels(copilotInventory())
    expect(models[0]?.variants.map((v) => v.id)).toEqual([...EFFORTS])
    // Le `settings` du variant est exactement ce que lira `settings.ts`.
    expect(models[0]?.variants[3]).toEqual({ id: "high", settings: { effort: "high" } })
  })

  test("aucun variant ne s'appelle `default` — OpenCode n'en fusionnerait pas les settings", () => {
    // Cf. `ModelResolver` : l'id `"default"` signifie « aucun variant », ses
    // `settings` seraient donc ignorées. Un variant `default` porterait un
    // `effort` silencieusement perdu.
    const models = inventoryToModels(copilotInventory())
    expect(models[0]?.variants.map((v) => v.id)).not.toContain("default")
  })

  test("les variants suivent l'inventaire, y compris quand `none` disparaît", () => {
    // Mesuré : `copilot --acp` ne propose plus `none` pour `claude-sonnet-5`.
    const inventory = copilotInventory()
    const models = inventoryToModels({ ...inventory, thoughtLevels: ["low", "medium", "high"] })
    expect(models[0]?.variants.map((v) => v.id)).toEqual(["low", "medium", "high"])
  })

  test("un agent sans niveaux d'effort donne des modèles sans variant", () => {
    const models = inventoryToModels({ ...copilotInventory(), thoughtLevels: [] })
    expect(models[0]?.variants).toEqual([])
  })

  test("des niveaux d'effort dupliqués ou vides ne produisent pas deux variants", () => {
    const variants = effortVariants({ ...copilotInventory(), thoughtLevels: ["high", "high", " ", "low"] })
    expect(variants).toEqual([
      { id: "high", settings: { effort: "high" } },
      { id: "low", settings: { effort: "low" } },
    ])
  })

  test("un inventaire vide donne une liste vide, pas une erreur", () => {
    expect(inventoryToModels(emptyInventory())).toEqual([])
  })

  test("des ids de modèles dupliqués n'occupent qu'une place", () => {
    const models = inventoryToModels({
      ...emptyInventory(),
      models: [
        { id: "gpt-5.4", name: "GPT-5.4" },
        { id: "gpt-5.4", name: "doublon" },
      ],
    })
    expect(models.length).toBe(1)
    expect(models[0]?.name).toBe("GPT-5.4")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `providerInfo`
// ─────────────────────────────────────────────────────────────────────────────

describe("providerInfo (pur)", () => {
  const PACKAGE = "file:///home/user/projet/src/index.ts"

  test("l'info porte l'id, l'activation et le package", () => {
    const info = providerInfo({ label: "ACP — Copilot", settings: { command: "copilot" } }, PACKAGE)
    expect(info.id).toBe("acp")
    expect(info.activation).toBe("enabled")
    expect(info.package).toBe(PACKAGE)
    expect(info.name).toBe("ACP — Copilot")
  })

  test("sans étiquette, le provider s'appelle `ACP`", () => {
    expect(providerInfo({}, PACKAGE).name).toBe("ACP")
    expect(providerInfo({ label: "   " }, PACKAGE).name).toBe("ACP")
  })

  test("les settings du provider sont ceux de l'agent, ou un objet vide", () => {
    expect(providerInfo({ settings: { command: "copilot" } }, PACKAGE).settings).toEqual({
      command: "copilot",
    })
    expect(providerInfo({}, PACKAGE).settings).toEqual({})
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `inventorySignature`
// ─────────────────────────────────────────────────────────────────────────────

describe("inventorySignature (pur)", () => {
  test("deux relevés identiques ont la même empreinte", () => {
    expect(inventorySignature(copilotInventory())).toBe(inventorySignature(copilotInventory()))
  })

  test("un modèle ajouté, retiré ou renommé change l'empreinte", () => {
    const base = inventorySignature(copilotInventory())
    const added = { ...copilotInventory(), models: [...MODEL_IDS.map((id) => ({ id, name: id })), { id: "x", name: "X" }] }
    const removed = { ...copilotInventory(), models: copilotInventory().models.slice(1) }
    const renamed = {
      ...copilotInventory(),
      models: copilotInventory().models.map((m) => (m.id === "gpt-5.4" ? { ...m, name: "Renommé" } : m)),
    }
    expect(inventorySignature(added)).not.toBe(base)
    expect(inventorySignature(removed)).not.toBe(base)
    expect(inventorySignature(renamed)).not.toBe(base)
  })

  test("un niveau d'effort ou un modèle courant change l'empreinte", () => {
    const base = inventorySignature(copilotInventory())
    expect(inventorySignature({ ...copilotInventory(), thoughtLevels: ["low"] })).not.toBe(base)
    expect(inventorySignature({ ...copilotInventory(), currentModel: "gpt-5.4" })).not.toBe(base)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Options du plugin
// ─────────────────────────────────────────────────────────────────────────────

describe("parsePluginConfig (pur)", () => {
  const ok = (input: unknown) => {
    const result = parsePluginConfig(input)
    if (!result.ok) throw new Error(`attendu ok, obtenu : ${result.message}`)
    return result.value
  }

  test("sans options, l'agent par défaut est `copilot --acp`", () => {
    expect(ok(undefined).agents[0]).toEqual(DEFAULT_AGENT)
    expect(DEFAULT_AGENT.command).toBe("copilot")
    expect(DEFAULT_AGENT.args).toEqual(["--acp"])
  })

  test("`agents: []` retombe aussi sur l'agent par défaut", () => {
    expect(ok({ agents: [] }).agents[0]).toEqual(DEFAULT_AGENT)
  })

  test("un agent déclaré est lu champ par champ", () => {
    const { agents, refreshMs } = ok({
      agents: [
        {
          id: "codex",
          command: "npx",
          args: ["-y", "@agentclientprotocol/codex-acp"],
          cwd: "/srv/projet",
          env: { HTTPS_PROXY: "http://proxy:3128" },
          allowedTools: ["*"],
          limits: { context: 400_000, output: 64_000 },
        },
      ],
      refreshMs: 5_000,
    })
    expect(agents[0]).toEqual({
      id: "codex",
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp"],
      cwd: "/srv/projet",
      env: { HTTPS_PROXY: "http://proxy:3128" },
      allowedTools: ["*"],
      limits: { context: 400_000, output: 64_000 },
    })
    expect(refreshMs).toBe(5_000)
  })

  test("l'intervalle de rafraîchissement par défaut est d'une minute", () => {
    expect(ok({}).refreshMs).toBe(DEFAULT_REFRESH_MS)
    expect(ok({ refreshMs: 0 }).refreshMs).toBe(0)
  })

  test("sans `id`, l'agent est nommé par sa commande", () => {
    // Sans ça, aucune ligne de journal ne pourrait nommer l'agent.
    expect(ok({ agents: [{ command: "gemini" }] }).agents[0]?.id).toBe("gemini")
  })

  test("une commande absente ou vide est une erreur qui nomme le champ", () => {
    for (const agents of [[{}], [{ command: "  " }], [{ command: 12 }]]) {
      const result = parsePluginConfig({ agents })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.message).toContain("options.agents[0].command")
    }
  })

  test("un `agents` qui n'est pas un tableau est refusé", () => {
    const result = parsePluginConfig({ agents: { command: "copilot" } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("options.agents")
  })

  test("des options qui ne sont pas un objet sont refusées", () => {
    expect(parsePluginConfig("copilot").ok).toBe(false)
    expect(parsePluginConfig([]).ok).toBe(false)
  })

  test("un champ mal typé est nommé, une clé inconnue est ignorée", () => {
    const bad = parsePluginConfig({ agents: [{ command: "copilot", args: "--acp" }] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message).toContain("options.agents[0].args")

    const env = parsePluginConfig({ agents: [{ command: "copilot", env: { A: 1 } }] })
    expect(env.ok).toBe(false)
    if (!env.ok) expect(env.message).toContain("options.agents[0].env.A")

    const limits = parsePluginConfig({ agents: [{ command: "copilot", limits: { context: 0 } }] })
    expect(limits.ok).toBe(false)
    if (!limits.ok) expect(limits.message).toContain("options.agents[0].limits.context")

    // Une clé qu'on ne connaît pas ne doit pas faire tomber tout le plugin.
    expect(ok({ agents: [{ command: "copilot", futureOption: true }] }).agents.length).toBe(1)
  })

  test("un `refreshMs` négatif ou non fini est refusé", () => {
    expect(parsePluginConfig({ refreshMs: -1 }).ok).toBe(false)
    expect(parsePluginConfig({ refreshMs: Number.NaN }).ok).toBe(false)
  })

  test("les settings publiés omettent `id` et `limits`, et les champs absents", () => {
    // `id` est une étiquette, `limits` une valeur d'affichage : les laisser dans
    // les settings les enverrait à `parseSettings` à chaque tour, où ils sont
    // ignorés. Les champs `undefined` sont **omis** pour ne pas écraser, à la
    // fusion, ce que l'utilisateur a mis dans `opencode.jsonc`.
    expect(providerSettingsOf(DEFAULT_AGENT)).toEqual({ command: "copilot", args: ["--acp"] })
    expect(
      providerSettingsOf({
        id: "codex",
        command: "npx",
        args: ["-y"],
        cwd: "/srv",
        env: { A: "1" },
        allowedTools: ["*"],
        limits: { context: 1, output: 1 },
      }),
    ).toEqual({ command: "npx", args: ["-y"], cwd: "/srv", env: { A: "1" }, allowedTools: ["*"] })
  })

  test("les settings publiés sont acceptés tels quels par `parseSettings`", () => {
    // Le contrat qui compte : ce que le plugin publie doit être exactement ce que
    // `model()` saura lire au premier tour.
    const agent = ok({
      agents: [{ id: "copilot", command: "copilot", args: ["--acp"], env: { A: "1" } }],
    }).agents[0]
    if (agent === undefined) throw new Error("agent manquant")
    const parsed = parseSettings(providerSettingsOf(agent))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.command).toBe("copilot")
    expect(parsed.value.env).toEqual({ A: "1" })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Le champ `effort` : le chainon variant → settings → adaptateur
// ─────────────────────────────────────────────────────────────────────────────

describe("settings.effort (pur)", () => {
  test("un effort de variant est lu et conservé", () => {
    const parsed = parseSettings({ command: "copilot", effort: "xhigh" })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.effort).toBe("xhigh")
  })

  test("absent, l'effort reste `undefined` : l'agent garde sa valeur", () => {
    const parsed = parseSettings({ command: "copilot" })
    if (!parsed.ok) throw new Error("attendu ok")
    expect(parsed.value.effort).toBeUndefined()
  })

  test("un effort vide ou mal typé est une erreur qui nomme le champ", () => {
    const empty = parseSettings({ command: "copilot", effort: "" })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.message).toContain("settings.effort")

    const typed = parseSettings({ command: "copilot", effort: 3 })
    expect(typed.ok).toBe(false)
    if (!typed.ok) expect(typed.message).toContain("settings.effort")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// L'URL `file://` du package provider
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePackageURL", () => {
  test("elle pointe sur un fichier qui existe vraiment", () => {
    // La seule garantie qui compte : OpenCode importe cette URL au premier tour.
    // Une URL « plausible » mais fausse produirait un `ERR_MODULE_NOT_FOUND`
    // bien après le chargement du plugin.
    const url = resolvePackageURL(import.meta.url)
    expect(url.startsWith("file://")).toBe(true)
    expect(existsSync(fileURLToPath(url))).toBe(true)
    // Le point d'entrée provider est bien celui du paquet (celui qui exporte
    // `model`), pas le plugin lui-même.
    expect(fileURLToPath(url).endsWith("/index.ts")).toBe(true)
    expect(fileURLToPath(url).endsWith("/plugin.ts")).toBe(false)
  })

  test("un module qui n'a pas de point d'entrée échoue en nommant les candidats", () => {
    expect(() => resolvePackageURL("file:///nonexistent/opencode-acp/plugin.js")).toThrow(
      /index\.js.*index\.ts|index\.ts/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// L'invariant de portabilité, sur le nouveau fichier
// ─────────────────────────────────────────────────────────────────────────────

describe("invariant : la publication ne dépend pas de l'hôte", () => {
  test("core/publish.ts n'importe rien de l'API plugin", async () => {
    const source = await Bun.file(
      fileURLToPath(new URL("../src/core/publish.ts", import.meta.url)),
    ).text()
    // On cherche des **instructions d'import**, pas le texte : le module
    // documente précisément cette interdiction, donc en Mentionner le nom est
    // normal.
    expect(source.match(/from\s+"@opencode\/plugin/)).toBeNull()
    expect(source.match(/from\s+"(effect|@opencode\/ai|@opencode\/schema|@agentclientprotocol\/sdk)[^"]*"/)).toBeNull()
  })
})
