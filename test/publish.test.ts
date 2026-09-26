/**
 * Publishing the ACP inventory.
 *
 * Everything tested here is **pure**: no function in this file spawns a process,
 * opens a session or imports `@opencode/plugin`. That is the benefit of the
 * `core/publish.ts` / `src/plugin.ts` split: what decides what OpenCode sees in
 * `/model` is checkable by function calls, whereas a real `copilot --acp` only
 * lets you observe a catalogue, inside a server, with the inventory already
 * changed.
 *
 * The reference capture is the one measured on `copilot --acp`: 20 `model`
 * category values (including `auto`), 6 effort levels, 3 modes.
 */

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

import {
  DEFAULT_AGENT,
  DEFAULT_DISCOVERY_IDLE_TIMEOUT_MS,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_LIMITS,
  DEFAULT_REFRESH_MS,
  PSEUDO_MODEL_IDS,
  effortVariants,
  inventorySignature,
  inventoryToModels,
  parsePluginConfig,
  normalizeProviderSlug,
  providerIdOf,
  providerInfo,
  providerSettingsOf,
} from "../src/core/publish.js"
import { resolvePackageURL } from "../src/plugin.js"
import { parseSettings } from "../src/settings.js"
import type { RawAgent } from "../src/core/publish.js"
import type { AcpMode, AcpOption, Inventory } from "../src/core/types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures - the real capture
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

/** The inventory measured on `copilot --acp` (agent `Copilot` v1.0.88). */
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

describe("inventoryToModels (pure)", () => {
  test("20 agent values give 19 models: `auto` is filtered out", () => {
    const models = inventoryToModels(copilotInventory())
    expect(MODEL_IDS.length).toBe(20)
    expect(models.length).toBe(19)
    expect(ids(models)).not.toContain("auto")
    // Everything else is kept, in the agent's order.
    expect(ids(models)).toEqual(MODEL_IDS.filter((id) => id !== "auto"))
  })

  test("the filtered pseudo-model really is `auto`, and documented as such", () => {
    // The test locks the *decision*, not only the code: a different future
    // `PSEUDO_MODEL_IDS` must make this test fail, so that changing the contract
    // cannot go unnoticed.
    expect([...PSEUDO_MODEL_IDS]).toEqual(["auto"])
  })

  test("`auto` is filtered whatever its case or surrounding spaces", () => {
    const inventory = copilotInventory()
    const models = inventoryToModels({
      ...inventory,
      models: [{ id: "AUTO", name: "Auto" }, { id: " auto ", name: "Auto" }, { id: "gpt-5.4", name: "GPT-5.4" }],
    })
    expect(ids(models)).toEqual(["gpt-5.4"])
  })

  test("the display name is the agent's, the id stays the ACP identifier", () => {
    const models = inventoryToModels(copilotInventory())
    const sonnet = models.find((model) => model.id === "claude-sonnet-5")
    expect(sonnet?.name).toBe("Claude Sonnet 5")
    // A model with no label falls back to its id rather than becoming invisible.
    const bare = models.find((model) => model.id === "gpt-5.4")
    expect(bare?.name).toBe("gpt-5.4")
    expect(models.find((model) => model.id === "gpt-5.4-mini")?.name).toBe("gpt-5.4-mini")
  })

  test("a model without a description is published like the others", () => {
    // `AcpModel.description` is optional: its absence must neither drop the model
    // nor single it out in the catalogue.
    const models = inventoryToModels({
      ...copilotInventory(),
      models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
    })
    expect(models.length).toBe(1)
    expect(models[0]?.id).toBe("claude-sonnet-5")
  })

  test("an empty name falls back to the id", () => {
    const models = inventoryToModels({ ...emptyInventory(), models: [{ id: "x-1", name: "  " }] })
    expect(models[0]?.name).toBe("x-1")
  })

  test("the capabilities are textual, and `tools` is true", () => {
    for (const model of inventoryToModels(copilotInventory())) {
      expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
    }
  })

  test("the limits are explicit and defaulted, never `undefined`", () => {
    // A missing `limit` would make `Model.Info` fail; a `limit` of 0 would
    // suggest a null window. A **declared**, constant value is wanted.
    const model = inventoryToModels(copilotInventory())[0]
    expect(model?.limit).toEqual({ context: 200_000, output: 32_000 })
    expect(DEFAULT_LIMITS).toEqual({ context: 200_000, output: 32_000 })
  })

  test("the limits are configurable per agent, and apply to all its models", () => {
    const models = inventoryToModels(copilotInventory(), { limits: { context: 32_000, output: 8_000 } })
    expect(models.length).toBe(19)
    for (const model of models) expect(model.limit).toEqual({ context: 32_000, output: 8_000 })
  })

  test("the effort levels become selectable variants", () => {
    const models = inventoryToModels(copilotInventory())
    expect(models[0]?.variants.map((v) => v.id)).toEqual([...EFFORTS])
    // The variant's `settings` is exactly what `settings.ts` reads.
    expect(models[0]?.variants[3]).toEqual({ id: "high", settings: { effort: "high" } })
  })

  test("no variant is called `default` - OpenCode would not merge its settings", () => {
    // Cf. `ModelResolver`: the id `"default"` means "no variant", so its
    // `settings` would be ignored. A `default` variant would carry a silently
    // lost `effort`.
    const models = inventoryToModels(copilotInventory())
    expect(models[0]?.variants.map((v) => v.id)).not.toContain("default")
  })

  test("the variants follow the inventory, including when `none` disappears", () => {
    // Measured: `copilot --acp` no longer offers `none` for `claude-sonnet-5`.
    const inventory = copilotInventory()
    const models = inventoryToModels({ ...inventory, thoughtLevels: ["low", "medium", "high"] })
    expect(models[0]?.variants.map((v) => v.id)).toEqual(["low", "medium", "high"])
  })

  test("an agent with no effort levels gives models with no variant", () => {
    const models = inventoryToModels({ ...copilotInventory(), thoughtLevels: [] })
    expect(models[0]?.variants).toEqual([])
  })

  test("duplicate or empty effort levels do not produce two variants", () => {
    const variants = effortVariants({ ...copilotInventory(), thoughtLevels: ["high", "high", " ", "low"] })
    expect(variants).toEqual([
      { id: "high", settings: { effort: "high" } },
      { id: "low", settings: { effort: "low" } },
    ])
  })

  test("the `default` effort level is not published: OpenCode would drop its settings", () => {
    // Measured on `opencode acp`: `default` sits among the effort values.
    // OpenCode rewrites a variant named `default` to *no* variant before
    // merging its settings, so publishing it would show an entry in `/model`
    // that applies nothing - and duplicate the synthetic "Default" its own
    // variant picker always offers. No variant means the agent's own announced
    // value, which is what `default` asks for.
    const variants = effortVariants({ ...copilotInventory(), thoughtLevels: ["low", "default", "high"] })
    expect(variants).toEqual([
      { id: "low", settings: { effort: "low" } },
      { id: "high", settings: { effort: "high" } },
    ])
  })

  test("an agent whose only effort level is `default` gets no variant at all", () => {
    const variants = effortVariants({ ...copilotInventory(), thoughtLevels: ["default"] })
    expect(variants).toEqual([])
    const models = inventoryToModels({ ...copilotInventory(), thoughtLevels: ["default"] })
    expect(models[0]?.variants).toEqual([])
  })

  test("an empty inventory gives an empty list, not an error", () => {
    expect(inventoryToModels(emptyInventory())).toEqual([])
  })

  test("duplicate model ids take only one slot", () => {
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
// The provider id: one provider per agent
// ─────────────────────────────────────────────────────────────────────────────

describe("the provider id (pure)", () => {
  /** The parsed agents, or a failure that names what the test got wrong. */
  const agentsOf = (input: unknown): readonly RawAgent[] => {
    const result = parsePluginConfig(input)
    if (!result.ok) throw new Error(`attendu ok, obtenu : ${result.message}`)
    return result.value.agents
  }

  test("an unnamed agent keeps the historic `acp`", () => {
    // The single most important backward-compatibility fact: a configuration
    // written before several agents were possible must keep publishing the
    // provider its `providers.acp.settings` refers to.
    expect(providerIdOf(undefined)).toBe("acp")
    expect(providerIdOf("")).toBe("acp")
  })

  test("a named agent gets `acp-<id>`, so it cannot land on a built-in provider", () => {
    expect(providerIdOf("copilot")).toBe("acp-copilot")
    expect(providerIdOf("codex")).toBe("acp-codex")
  })

  test("the id is reduced to what an id may contain", () => {
    // An id is typed after `provider/model`, put in a CLI filter and put in a
    // URL: `acp-Mon Agent!` would need quoting in the first and is a path in
    // the third.
    expect(normalizeProviderSlug("  Copilot  ")).toBe("copilot")
    expect(normalizeProviderSlug("Mon Agent!")).toBe("mon-agent")
    expect(normalizeProviderSlug("codex_acp")).toBe("codex-acp")
    expect(normalizeProviderSlug("--x--")).toBe("x")
    expect(normalizeProviderSlug("../../etc")).toBe("etc")
    expect(normalizeProviderSlug("a..b")).toBe("a-b")
    expect(normalizeProviderSlug("9router")).toBe("9router")
  })

  test("two agents of the same command get two distinct provider ids", () => {
    // The credentials are per agent, and the inventory too: a single provider
    // would make them share a process, its authentication state and its ACP
    // sessions.
    const ids = ["copilot-stable", "copilot-next"].map(providerIdOf)
    expect(new Set(ids).size).toBe(2)
  })

  test("`providerInfo` publishes the id it is given, and `acp` without one", () => {
    const url = "file:///home/user/projet/src/index.ts"
    expect(providerInfo({}, url).id).toBe("acp")
    expect(providerInfo({ id: "acp-copilot" }, url).id).toBe("acp-copilot")
  })

  test("the id travels in the settings, and only when it is not the default", () => {
    // `model(modelID, settings)` is the only thing OpenCode calls on a provider
    // package: this key is the sole channel, which is also why the default is
    // left out - a hand-written `providers.acp.settings` stays as written.
    const agent = agentsOf({ agents: [{ command: "copilot", args: ["--acp"] }] })[0]
    if (agent === undefined) throw new Error("agent manquant")
    expect(providerSettingsOf(agent)).toEqual({ command: "copilot", args: ["--acp"] })
    expect(providerSettingsOf(agent, "acp-copilot")).toEqual({
      command: "copilot",
      args: ["--acp"],
      provider: "acp-copilot",
    })
  })

  test("the published id is read back by `parseSettings`, so the route agrees with the catalogue", () => {
    // The loop that must close: catalogue says `acp-copilot`, the route must
    // declare `acp-copilot`, and the two only meet through these settings.
    const agent = agentsOf({ agents: [{ id: "Copilot", command: "copilot", args: ["--acp"] }] })[0]
    if (agent === undefined) throw new Error("agent manquant")
    const parsed = parseSettings(providerSettingsOf(agent, providerIdOf(agent.providerSlug)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.provider).toBe("acp-copilot")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `providerInfo`
// ─────────────────────────────────────────────────────────────────────────────

describe("providerInfo (pure)", () => {
  const PACKAGE = "file:///home/user/projet/src/index.ts"

  test("the info carries the id, the activation and the package", () => {
    const info = providerInfo({ label: "ACP — Copilot", settings: { command: "copilot" } }, PACKAGE)
    expect(info.id).toBe("acp")
    expect(info.activation).toBe("enabled")
    expect(info.package).toBe(PACKAGE)
    expect(info.name).toBe("ACP — Copilot")
  })

  test("without a label, the provider is called `ACP`", () => {
    expect(providerInfo({}, PACKAGE).name).toBe("ACP")
    expect(providerInfo({ label: "   " }, PACKAGE).name).toBe("ACP")
  })

  test("the provider settings are the agent's, or an empty object", () => {
    expect(providerInfo({ settings: { command: "copilot" } }, PACKAGE).settings).toEqual({
      command: "copilot",
    })
    expect(providerInfo({}, PACKAGE).settings).toEqual({})
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `inventorySignature`
// ─────────────────────────────────────────────────────────────────────────────

describe("inventorySignature (pure)", () => {
  test("two identical captures share the same signature", () => {
    expect(inventorySignature(copilotInventory())).toBe(inventorySignature(copilotInventory()))
  })

  test("adding, removing or renaming a model changes the signature", () => {
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

  test("an effort level or the current model changes the signature", () => {
    const base = inventorySignature(copilotInventory())
    expect(inventorySignature({ ...copilotInventory(), thoughtLevels: ["low"] })).not.toBe(base)
    expect(inventorySignature({ ...copilotInventory(), currentModel: "gpt-5.4" })).not.toBe(base)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Plugin options
// ─────────────────────────────────────────────────────────────────────────────

describe("parsePluginConfig (pure)", () => {
  const ok = (input: unknown) => {
    const result = parsePluginConfig(input)
    if (!result.ok) throw new Error(`attendu ok, obtenu : ${result.message}`)
    return result.value
  }

  test("without options, the default agent is `copilot --acp`", () => {
    expect(ok(undefined).agents[0]).toEqual(DEFAULT_AGENT)
    expect(DEFAULT_AGENT.command).toBe("copilot")
    expect(DEFAULT_AGENT.args).toEqual(["--acp"])
  })

  test("`agents: []` also falls back to the default agent", () => {
    expect(ok({ agents: [] }).agents[0]).toEqual(DEFAULT_AGENT)
  })

  test("a declared agent is read field by field", () => {
    const { agents, refreshMs } = ok({
      agents: [
        {
          id: "codex",
          command: "npx",
          args: ["-y", "@agentclientprotocol/codex-acp"],
          cwd: "/srv/projet",
          env: { HTTPS_PROXY: "http://proxy:3128" },
          allowedTools: ["*"],
          session: "reuse",
          limits: { context: 400_000, output: 64_000 },
        },
      ],
      refreshMs: 5_000,
    })
    expect(agents[0]).toEqual({
      id: "codex",
      providerSlug: "codex",
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp"],
      cwd: "/srv/projet",
      env: { HTTPS_PROXY: "http://proxy:3128" },
      allowedTools: ["*"],
      session: "reuse",
      limits: { context: 400_000, output: 64_000 },
    })
    expect(refreshMs).toBe(5_000)
  })

  test("the default refresh interval is one minute", () => {
    expect(ok({}).refreshMs).toBe(DEFAULT_REFRESH_MS)
    expect(ok({ refreshMs: 0 }).refreshMs).toBe(0)
  })

  test("without an `id`, the agent is named by its command", () => {
    // Without that, no log line could name the agent.
    expect(ok({ agents: [{ command: "gemini" }] }).agents[0]?.id).toBe("gemini")
  })

  test("an explicit `id` is normalised into a provider id, an implicit one is not", () => {
    // The distinction IS the backward compatibility: an agent the user never
    // named keeps `acp`, the id his `providers.acp.settings` is filed under.
    expect(ok({ agents: [{ command: "copilot", args: ["--acp"] }] }).agents[0]?.providerSlug).toBeUndefined()
    expect(ok({ agents: [{ id: "copilot", command: "copilot" }] }).agents[0]?.providerSlug).toBe("copilot")
  })

  test("an `id` with no usable character is refused rather than silently defaulted", () => {
    // The user asked for a name: falling back to `acp` would hide the typo
    // behind a provider that works.
    for (const id of ["///", "  ", "\u00e9\u00e8"]) {
      const result = parsePluginConfig({ agents: [{ id, command: "copilot" }] })
      if (id === "  ") {
        // Blank is not a name: it is the absence of one, which is legal.
        expect(result.ok).toBe(true)
        continue
      }
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.message).toContain("options.agents[0].id")
    }
  })

  test("a missing or empty command is an error naming the field", () => {    for (const agents of [[{}], [{ command: "  " }], [{ command: 12 }]]) {
      const result = parsePluginConfig({ agents })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.message).toContain("options.agents[0].command")
    }
  })

  test("an `agents` that is not an array is refused", () => {
    const result = parsePluginConfig({ agents: { command: "copilot" } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("options.agents")
  })

  test("options that are not an object are refused", () => {
    expect(parsePluginConfig("copilot").ok).toBe(false)
    expect(parsePluginConfig([]).ok).toBe(false)
  })

  test("a badly typed field is named, an unknown key is ignored", () => {
    const bad = parsePluginConfig({ agents: [{ command: "copilot", args: "--acp" }] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message).toContain("options.agents[0].args")

    const env = parsePluginConfig({ agents: [{ command: "copilot", env: { A: 1 } }] })
    expect(env.ok).toBe(false)
    if (!env.ok) expect(env.message).toContain("options.agents[0].env.A")

    const limits = parsePluginConfig({ agents: [{ command: "copilot", limits: { context: 0 } }] })
    expect(limits.ok).toBe(false)
    if (!limits.ok) expect(limits.message).toContain("options.agents[0].limits.context")

    // An unknown key must not bring down the whole plugin.
    expect(ok({ agents: [{ command: "copilot", futureOption: true }] }).agents.length).toBe(1)
  })

  test("`session` is admitted per agent, and a bad value is named", () => {
    // The whole point of the field: one agent `reuse`, another `fresh`, from the
    // place a user configures agents. A typo here would otherwise silently cost a
    // `session/new` per model call, or - worse - be ignored.
    const { agents } = ok({
      agents: [
        { id: "copilot", command: "copilot", session: "reuse" },
        { id: "codex", command: "npx", session: "fresh" },
        { id: "gpt", command: "gemini" },
      ],
    })
    expect(agents.map((agent) => agent.session)).toEqual(["reuse", "fresh", undefined])
    // Absence is not a third value: it has to reach `parseSettings` as `fresh`.
    expect(parseSettings(providerSettingsOf(agents[2]!)).ok).toBe(true)
  })

  test("an invalid `session` is refused, naming the field and the two values", () => {
    for (const value of ["Resume", "", true, 1, ["reuse"], null]) {
      const result = parsePluginConfig({ agents: [{ command: "copilot", session: value }] })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.message).toContain("options.agents[0].session")
      expect(result.message).toContain('"fresh"')
      expect(result.message).toContain('"reuse"')
    }
  })

  test("a negative or non-finite `refreshMs` is refused", () => {
    expect(parsePluginConfig({ refreshMs: -1 }).ok).toBe(false)
    expect(parsePluginConfig({ refreshMs: Number.NaN }).ok).toBe(false)
  })

  test("the published settings omit `id` and `limits`, and absent fields", () => {
    // `id` is a label and `limits` a display value: leaving them in the settings
    // would send them to `parseSettings` on every turn, where they are ignored.
    // `undefined` fields are **omitted** so as not to overwrite, at merge time,
    // what the user put in `opencode.jsonc`.
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

  test("`session` reaches the route, and only when the agent asked for it", () => {
    // The gap this closes: `session` was readable in `AcpProviderSettings` but had
    // no way in from an agent entry, so a multi-agent configuration could not
    // choose a mode per agent.
    const reuse = ok({ agents: [{ command: "copilot", session: "reuse" }] }).agents[0]
    const fresh = ok({ agents: [{ command: "copilot", session: "fresh" }] }).agents[0]
    const silent = ok({ agents: [{ command: "copilot" }] }).agents[0]
    if (reuse === undefined || fresh === undefined || silent === undefined) {
      throw new Error("agent manquant")
    }
    expect(providerSettingsOf(reuse)).toEqual({ command: "copilot", session: "reuse" })

    // Backward compatibility, stated as a test: the default agent now carries
    // `session: undefined`, and that must not reach the route. The published
    // object is compared key by key, so the assertion is about the bytes that
    // OpenCode will merge, not about the provider happening to behave the same.
    expect(providerSettingsOf(silent)).toEqual({ command: "copilot" })
    expect(Object.keys(providerSettingsOf(silent))).not.toContain("session")
    expect(providerSettingsOf(DEFAULT_AGENT)).toEqual(
      providerSettingsOf({ ...DEFAULT_AGENT, session: undefined }),
    )

    for (const [agent, expected] of [
      [reuse, "reuse"],
      [fresh, "fresh"],
      [silent, undefined],
    ] as const) {
      const parsed = parseSettings(providerSettingsOf(agent))
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.value.session).toBe(expected)
    }
  })

  test("the published settings are accepted as-is by `parseSettings`", () => {
    // The contract that matters: what the plugin publishes must be exactly what
    // `model()` will be able to read on the first turn.
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
// The `effort` field: the variant -> settings -> adapter link
// ─────────────────────────────────────────────────────────────────────────────

describe("settings.effort (pure)", () => {
  test("a variant effort is read and kept", () => {
    const parsed = parseSettings({ command: "copilot", effort: "xhigh" })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.effort).toBe("xhigh")
  })

  test("absent, the effort stays `undefined`: the agent keeps its value", () => {
    const parsed = parseSettings({ command: "copilot" })
    if (!parsed.ok) throw new Error("attendu ok")
    expect(parsed.value.effort).toBeUndefined()
  })

  test("an empty or badly typed effort is an error naming the field", () => {
    const empty = parseSettings({ command: "copilot", effort: "" })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.message).toContain("settings.effort")

    const typed = parseSettings({ command: "copilot", effort: 3 })
    expect(typed.ok).toBe(false)
    if (!typed.ok) expect(typed.message).toContain("settings.effort")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The `file://` URL of the provider package, and `resolvePackageURL`
// ─────────────────────────────────────────────────────────────────────────────

describe("discovery bounds", () => {
  test("both bounds are 10 s by default", () => {
    // 10 s, like `opencode-acpx`: what is at stake is not patience but
    // OpenCode's startup, and thirty seconds of frozen screen with no message
    // are indistinguishable from a crash.
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBe(10_000)
    expect(DEFAULT_DISCOVERY_IDLE_TIMEOUT_MS).toBe(10_000)
  })

  test("absent, they fall back to their defaults", () => {
    for (const input of [undefined, null, {}, { agents: [] }]) {
      const parsed = parsePluginConfig(input)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.value.discoveryTimeoutMs).toBe(DEFAULT_DISCOVERY_TIMEOUT_MS)
      expect(parsed.value.discoveryIdleTimeoutMs).toBe(DEFAULT_DISCOVERY_IDLE_TIMEOUT_MS)
    }
  })

  test("they are configurable, for instance for an agent slow to start", () => {
    const parsed = parsePluginConfig({ discoveryTimeoutMs: 120_000, discoveryIdleTimeoutMs: 5_000 })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.discoveryTimeoutMs).toBe(120_000)
    expect(parsed.value.discoveryIdleTimeoutMs).toBe(5_000)
    // The rest of the configuration is untouched.
    expect(parsed.value.refreshMs).toBe(DEFAULT_REFRESH_MS)
  })

  test.each([
    [{ discoveryTimeoutMs: 0 }, "options.discoveryTimeoutMs"],
    [{ discoveryTimeoutMs: -1 }, "options.discoveryTimeoutMs"],
    [{ discoveryTimeoutMs: Number.POSITIVE_INFINITY }, "options.discoveryTimeoutMs"],
    [{ discoveryTimeoutMs: "10s" }, "options.discoveryTimeoutMs"],
    [{ discoveryIdleTimeoutMs: 0 }, "options.discoveryIdleTimeoutMs"],
    [{ discoveryIdleTimeoutMs: Number.NaN }, "options.discoveryIdleTimeoutMs"],
  ])("une borne inutilisable est refusée : %o", (input, fragment) => {
    // Note: a `0`, negative or infinite bound bounds **nothing**: the worst case
    // for a timeout, and it must be refused when the configuration is read, not
    // discovered when OpenCode starts.
    const parsed = parsePluginConfig(input)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain(fragment)
  })
})

describe("resolvePackageURL", () => {
  test("it points at a file that really exists", () => {
    // The only guarantee that matters: OpenCode imports this URL on the first
    // turn. A "plausible" but false URL would produce an `ERR_MODULE_NOT_FOUND`
    // long after the plugin loaded.
    const url = resolvePackageURL(import.meta.url)
    expect(url.startsWith("file://")).toBe(true)
    expect(existsSync(fileURLToPath(url))).toBe(true)
    // The provider entry point really is the package's (the one exporting
    // `model`), not the plugin itself.
    expect(fileURLToPath(url).endsWith("/index.ts")).toBe(true)
    expect(fileURLToPath(url).endsWith("/plugin.ts")).toBe(false)
  })

  test("a module with no entry point fails naming the candidates", () => {
    expect(() => resolvePackageURL("file:///nonexistent/opencode-acp/plugin.js")).toThrow(
      /index\.js.*index\.ts|index\.ts/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The portability invariant, on the new file
// ─────────────────────────────────────────────────────────────────────────────

describe("invariant: publishing does not depend on the host", () => {
  test("core/publish.ts imports nothing from the plugin API", async () => {
    const source = await Bun.file(
      fileURLToPath(new URL("../src/core/publish.ts", import.meta.url)),
    ).text()
    // **Import statements** are searched for, not the bare text: the module
    // documents this very prohibition, so mentioning the name is normal.
    expect(source.match(/from\s+"@opencode\/plugin/)).toBeNull()
    expect(source.match(/from\s+"(effect|@opencode\/ai|@opencode\/schema|@agentclientprotocol\/sdk)[^"]*"/)).toBeNull()
  })
})
