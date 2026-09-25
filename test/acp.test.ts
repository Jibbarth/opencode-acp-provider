/**
 * Tests de bout en bout de la phase P0.
 *
 * On lance `test/fake-acp.ts` comme un **vrai sous-processus** : c'est le seul
 * moyen de valider la chaîne complète (spawn → ndJsonStream → initialize →
 * session/new → session/prompt → traduction en `AcpEvent`) exactement comme le
 * fera le plugin face à `copilot --acp`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import { createAcpAgent } from "../src/acp/agent.js"
import { parseInventory, shortenModeId } from "../src/core/models.js"
import type { AcpAgent, AcpEvent, NormalizedRequest } from "../src/core/types.js"
import { allowAllPermissions } from "../src/core/types.js"

const FAKE = fileURLToPath(new URL("./fake-acp.ts", import.meta.url))

let agent: AcpAgent

/** Requête minimale : un seul message utilisateur. */
const request = (text: string): NormalizedRequest => ({
  system: [],
  tools: [],
  messages: [{ role: "user", text }],
})

const collect = async (events: AsyncIterable<AcpEvent>): Promise<AcpEvent[]> => {
  const out: AcpEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

beforeAll(async () => {
  agent = await createAcpAgent({
    command: process.execPath, // `bun` quand les tests tournent sous bun
    args: ["run", FAKE],
    cwd: process.cwd(),
    stderr: "ignore",
  })
})

afterAll(async () => {
  await agent?.close()
})

// ─────────────────────────────────────────────────────────────────────────────

describe("cycle de vie", () => {
  test("initialize renvoie l'identité et la version de protocole", () => {
    expect(agent.info).toEqual({ name: "fake-acp", version: "0.1.0" })
    expect(agent.protocolVersion).toBe(1)
  })

  test("close() est idempotent", async () => {
    const other = await createAcpAgent({
      command: process.execPath,
      args: ["run", FAKE],
      stderr: "ignore",
    })
    await other.close()
    await other.close()
  })
})

describe("inventaire (configOptions)", () => {
  test("models() renvoie les trois modèles de la catégorie `model`", async () => {
    const models = await agent.models()
    expect(models.map((m) => m.id)).toEqual(["auto", "gpt-5.6-terra", "claude-sonnet-5"])
    // Le libellé lisible accompagne l'id, et la description quand l'agent en fournit.
    expect(models[0]).toEqual({ id: "auto", name: "Auto", description: "Laisse l'agent choisir" })
    expect(models[1]?.name).toBe("GPT-5.6 Terra")
    expect(models[2]?.name).toBe("Claude Sonnet 5")
  })

  test("l'inventaire complet est correctement parsé", async () => {
    const session = await agent.open()
    try {
      const inventory = session.inventory()

      expect(inventory.currentModel).toBe("gpt-5.6-terra")
      expect(inventory.thoughtLevels).toEqual(["none", "medium", "high"])
      expect(inventory.currentThoughtLevel).toBe("medium")

      // Les modes arrivent avec des URLs : on les raccourcit.
      expect(inventory.modes).toEqual([
        {
          id: "agent",
          rawId: "https://agentclientprotocol.com/registry/modes/agent#agent",
          name: "Agent",
        },
        {
          id: "plan",
          rawId: "https://agentclientprotocol.com/registry/modes/plan#plan",
          name: "Plan",
        },
      ])
      expect(inventory.currentMode).toBe("agent")

      // La catégorie `permissions` est bien isolée de `mode` et `model`.
      expect(inventory.permissions).toEqual({
        id: "allow_all",
        name: "Allow all tools",
        category: "permissions",
        type: "select",
        currentValue: "off",
        values: ["on", "off"],
      })
      expect(inventory.options).toHaveLength(4)
    } finally {
      await session.close()
    }
  })

  test("setModel met à jour l'inventaire de session", async () => {
    const session = await agent.open()
    try {
      await session.setModel("claude-sonnet-5")
      expect(session.inventory().currentModel).toBe("claude-sonnet-5")
      // Le changement ne doit pas déborder sur les autres options.
      expect(session.inventory().currentThoughtLevel).toBe("medium")
    } finally {
      await session.close()
    }
  })

  test("setOption refuse une valeur inconnue", async () => {
    const session = await agent.open()
    try {
      await expect(session.setOption("pas-une-option", "x")).rejects.toThrow(
        /unknown config option/,
      )
    } finally {
      await session.close()
    }
  })
})

describe("prompt → AcpEvent", () => {
  test('un prompt "PING" produit les texte "PONG" puis usage et done', async () => {
    const session = await agent.open()
    try {
      const events = await collect(session.prompt(request("PING")))

      expect(events).toEqual([
        { type: "text", text: "PO" },
        { type: "text", text: "NG" },
        { type: "usage", input: 40, output: 2 },
        { type: "done", stopReason: "end_turn" },
      ])

      const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")
      expect(text).toBe("PONG")
    } finally {
      await session.close()
    }
  })

  test("un plan ACP devient un unique événement `plan`", async () => {
    const session = await agent.open()
    try {
      const events = await collect(session.prompt(request("PLAN")))
      const plans = events.filter((e) => e.type === "plan")
      expect(plans).toHaveLength(1)
      expect(plans[0]).toEqual({
        type: "plan",
        entries: [
          { content: "Analyser", priority: "high", status: "completed" },
          { content: "Implémenter", priority: "medium", status: "in_progress" },
        ],
      })
      expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
    } finally {
      await session.close()
    }
  })

  test("le texte demandé est transmis tel quel à l'agent", async () => {
    const session = await agent.open()
    try {
      const events = await collect(session.prompt(request("bonjour le monde")))
      expect(events[0]).toEqual({ type: "text", text: "ACK: bonjour le monde" })
    } finally {
      await session.close()
    }
  })
})

describe("permissions (§7.4)", () => {
  test("la policy par défaut refuse", async () => {
    const session = await agent.open()
    try {
      const events = await collect(session.prompt(request("NEED_PERMISSION")))
      const texts = events.flatMap((e) => (e.type === "text" ? [e.text] : []))
      expect(texts).toContain("DENIED")
      expect(texts).not.toContain("ALLOWED")
    } finally {
      await session.close()
    }
  })

  test("une policy « allow » reçoit bien l'option allow_once", async () => {
    const permissive = await createAcpAgent({
      command: process.execPath,
      args: ["run", FAKE],
      stderr: "ignore",
      policy: allowAllPermissions,
    })
    try {
      const session = await permissive.open()
      try {
        const events = await collect(session.prompt(request("NEED_PERMISSION")))
        const texts = events.flatMap((e) => (e.type === "text" ? [e.text] : []))
        expect(texts).toContain("ALLOWED")
      } finally {
        await session.close()
      }
    } finally {
      await permissive.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `parseInventory` est pur : on le teste sans process, sur des relevés bruts.
// ─────────────────────────────────────────────────────────────────────────────

describe("parseInventory (pur)", () => {
  test("tolère une entrée vide, nulle ou du bruit", () => {
    expect(parseInventory([])).toEqual({ models: [], thoughtLevels: [], modes: [], options: [] })
    expect(parseInventory([null, 42, "nope", {}])).toEqual({
      models: [],
      thoughtLevels: [],
      modes: [],
      options: [],
    })
  })

  test("retombe sur l'id quand la catégorie est absente", () => {
    const inventory = parseInventory([
      { id: "reasoning_effort", name: "Effort", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
    ])
    expect(inventory.thoughtLevels).toEqual(["high"])
    expect(inventory.currentThoughtLevel).toBe("high")
  })

  test("développe une option `boolean` en valeurs textuelles", () => {
    const inventory = parseInventory([
      { id: "telemetry", name: "Telemetry", type: "boolean", currentValue: true, category: "permissions" },
    ])
    expect(inventory.permissions).toEqual({
      id: "telemetry",
      name: "Telemetry",
      category: "permissions",
      type: "boolean",
      currentValue: "true",
      values: ["false", "true"],
    })
  })

  test("aplatit les `select` groupés", () => {
    const inventory = parseInventory([
      {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: "b",
        options: [
          { group: "g1", name: "Groupe 1", options: [{ value: "a", name: "A" }] },
          { group: "g2", name: "Groupe 2", options: [{ value: "b", name: "B" }] },
        ],
      },
    ])
    expect(inventory.models.map((m) => m.id)).toEqual(["a", "b"])
    expect(inventory.models.map((m) => m.name)).toEqual(["A", "B"])
    expect(inventory.currentModel).toBe("b")
  })

  test("shortenModeId : fragment, sinon dernier segment, sinon brut", () => {
    expect(shortenModeId("https://example.com/a/b#plan")).toBe("plan")
    expect(shortenModeId("https://example.com/a/b")).toBe("b")
    expect(shortenModeId("mode")).toBe("mode")
    expect(shortenModeId("")).toBe("")
  })
})
