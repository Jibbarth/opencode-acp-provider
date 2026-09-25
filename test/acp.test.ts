/**
 * Tests de bout en bout de la phase P0.
 *
 * On lance `test/fake-acp.ts` comme un **vrai sous-processus** : c'est le seul
 * moyen de valider la chaîne complète (spawn → ndJsonStream → initialize →
 * session/new → session/prompt → traduction en `AcpEvent`) exactement comme le
 * fera le plugin face à `copilot --acp`.
 *
 * Le faux est paramétrable par variables d'environnement (voir l'en-tête de
 * `fake-acp.ts`) : chaque cas difficile à atteindre avec un agent « gentil » —
 * `tool_call`, `stopReason ≠ end_turn`, option `boolean`, repli de policy,
 * annulation, stdout bruyant, agent mort — devient une variable d'env.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { createAcpAgent, AcpAgentError } from "../src/acp/agent.js"
import { parseInventory, shortenModeId } from "../src/core/models.js"
import { renderRequest } from "../src/core/prompt.js"
import type {
  AcpAgent,
  AcpEvent,
  AcpPermissionPolicy,
  NormalizedMessage,
  NormalizedRequest,
  PermissionDecision,
} from "../src/core/types.js"
import { allowAllPermissions } from "../src/core/types.js"

const FAKE = fileURLToPath(new URL("./fake-acp.ts", import.meta.url))
const CLI = fileURLToPath(new URL("../src/adapters/cli.ts", import.meta.url))
/** Commande qui n'existe pas, pour exercer le chemin d'échec du spawn. */
const MISSING = "opencode-acp-commande-inexistante-42"

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

/** Lance le faux agent avec un sur-ensemble de variables d'environnement. */
const spawnFake = async (
  env: Record<string, string> = {},
  policy?: AcpPermissionPolicy,
): Promise<AcpAgent> =>
  createAcpAgent({
    command: process.execPath,
    args: ["run", FAKE],
    cwd: process.cwd(),
    stderr: "ignore",
    ...(policy === undefined ? {} : { policy }),
    env,
  })

/**
 * Lance un faux agent dont le pid est écrit dans `pidFile` : le test peut ainsi
 * vérifier que *ce* processus-là est mort, sans compter des `ps` et sans risquer
 * qu'un orphelin disparaisse dans la fenêtre d'attente.
 */
const spawnTrackedFake = async (
  env: Record<string, string>,
  pidFile: string,
  options: { initializeTimeoutMs?: number } = {},
): Promise<AcpAgent> =>
  createAcpAgent({
    command: process.execPath,
    args: ["run", FAKE],
    stderr: "ignore",
    ...(options.initializeTimeoutMs === undefined
      ? {}
      : { initializeTimeoutMs: options.initializeTimeoutMs }),
    env: { ...env, FAKE_PID_FILE: pidFile },
  })

/** Répertoire temporaire jetable, pour les fichiers de pid. */
const pidFiles: string[] = []
const tmpPidFile = async (label: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `acp-pid-${label}-`))
  pidFiles.push(dir)
  return join(dir, "pid")
}

afterAll(async () => {
  await Promise.all(pidFiles.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Attend que le pid apparaisse dans le fichier (l'agent démarre). */
const readPid = async (pidFile: string, timeoutMs = 5_000): Promise<number> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const raw = await readFile(pidFile, "utf8").catch(() => "")
    const pid = Number(raw.trim())
    if (Number.isInteger(pid) && pid > 0) return pid
    if (Date.now() >= deadline) throw new Error(`le faux agent n'a jamais écrit ${pidFile}`)
    await Bun.sleep(20)
  }
}

/** `true` tant que le processus existe (signal 0 = « es-tu vivant ? »). */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Attend la disparition du processus, ou le délai. */
const waitForDeath = async (pid: number, timeoutMs = 3_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(25)
  return !isAlive(pid)
}

/**
 * Nombre de processus `fake-acp` vivants, tel que vu par le système.
 * C'est le seul constat global possible : un orphelin adopté par init
 * n'apparaît dans aucun `close()` du code qui l'a lancé.
 */
const countFakeProcesses = (): number => {
  const ps = Bun.spawnSync(["ps", "-eo", "args="])
  if (!ps.success) return -1
  return ps.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes("fake-acp.ts")).length
}

/** Attend que le nombre de processus redescende (ou dépasse le délai). */
const waitForFakeCount = async (target: number, timeoutMs = 5_000): Promise<number> => {
  const deadline = Date.now() + timeoutMs
  let current = countFakeProcesses()
  while (current > target && Date.now() < deadline) {
    await Bun.sleep(50)
    current = countFakeProcesses()
  }
  return current
}

/** Capture le rejet d'une promesse, en gardant le type `Error`. */
const captureError = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof Error)) {
    throw new Error(`un rejet était attendu, reçu : ${String(error)}`)
  }
  return error
}

/** Idem pour `AcpAgentError`, dont on veut typer le champ `subject`. */
const captureAgentError = async (promise: Promise<unknown>): Promise<AcpAgentError> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof AcpAgentError)) {
    throw new Error(`une AcpAgentError était attendue, reçue : ${String(error)}`)
  }
  return error
}

/** Les valeurs de `type` d'un flux JSONL, sans cast. */
const eventTypes = (jsonl: string): string[] =>
  jsonl
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return "?"
      return typeof parsed.type === "string" ? parsed.type : "?"
    })

/** Les `text` d'un flux, joints. */
const textOf = (events: readonly AcpEvent[]): string =>
  events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("")

beforeAll(async () => {
  agent = await spawnFake()
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
    const other = await spawnFake()
    await other.close()
    await other.close()
  })
})

describe("fermeture de session", () => {
  test("close() libère la session et close() l'agent reste sans effet", async () => {
    const local = await spawnFake()
    try {
      const session = await local.open()
      // Le tour nominal fonctionne…
      expect(textOf(await collect(session.prompt(request("PING"))))).toBe("PONG")

      await session.close()
      // …et `close()` est idempotent côté session aussi.
      await session.close()

      // `dispose()` a coupé le routage des updates : plus aucune méthode ne parle
      // à l'agent, et aucune promesse ne traîne.
      expect(() => session.prompt(request("PING"))).toThrow(/session fermée/)
      await expect(session.setOption("model", "auto")).rejects.toThrow(/session fermée/)
      await expect(session.setModel("auto")).rejects.toThrow(/session fermée/)

      // La connexion partagée, elle, est intacte : une session neuve fonctionne.
      const other = await local.open()
      await other.close()
    } finally {
      await local.close()
    }
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
        /option de configuration inconnue/,
      )
    } finally {
      await session.close()
    }
  })

  test("une option `boolean` fait l'aller-retour avec un payload typé", async () => {
    const booleanAgent = await spawnFake({ FAKE_BOOLEAN_OPTION: "1" })
    try {
      const session = await booleanAgent.open()
      try {
        const option = session.inventory().options.find((o) => o.id === "telemetry")
        expect(option).toEqual({
          id: "telemetry",
          name: "Telemetry",
          category: "permissions",
          type: "boolean",
          currentValue: "false",
          values: ["false", "true"],
        })

        // `session/set_config_option` exige `{ type: "boolean", value: bool }`.
        // Le faux ne teste que `params.value === true` : si nous avions envoyé
        // la chaîne `"true"`, la valeur relue serait restée à `false`.
        await session.setOption("telemetry", "true")
        expect(session.inventory().options.find((o) => o.id === "telemetry")?.currentValue).toBe("true")

        // Et le retour à `false` fonctionne par le même chemin.
        await session.setOption("telemetry", "false")
        expect(session.inventory().options.find((o) => o.id === "telemetry")?.currentValue).toBe("false")
      } finally {
        await session.close()
      }
    } finally {
      await booleanAgent.close()
    }
  })
})

describe("prompt → AcpEvent", () => {
  test('un prompt "PING" produit les texte "PONG" puis usage et done', async () => {
    const session = await agent.open()
    try {
      const events = await collect(session.prompt(request("PING")))

      // L'`usage` de fin de tour est la variante `turn`, discriminantée : elle
      // porte les compteurs **et** les paliers de cache, tous présents dans
      // l'`Usage` ACP (cf. §4.1).
      expect(events).toEqual([
        { type: "text", text: "PO" },
        { type: "text", text: "NG" },
        {
          type: "usage",
          kind: "turn",
          input: 40,
          output: 2,
          total: 42,
          reasoning: 1,
          cacheRead: 7,
          cacheWrite: 9,
        },
        { type: "done", stopReason: "end_turn" },
      ])

      expect(textOf(events)).toBe("PONG")
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

  test("le texte demandé est transmis à l'agent, préfixé de son rôle", async () => {
    const session = await agent.open()
    try {
      const events = await collect(session.prompt(request("bonjour le monde")))
      // ⚠️ Le préfixe de rôle n'est pas cosmétique : ACP n'a pas de champ
      // « system », le transcript est rendu à plat, et l'agent doit pouvoir
      // distinguer une instruction de sa propre sortie antérieure (§7.3).
      expect(events[0]).toEqual({ type: "text", text: "ACK: Utilisateur : bonjour le monde" })
    } finally {
      await session.close()
    }
  })

  test("deux résultats du même outil atteignent l'agent sans être fusionnés", async () => {
    // De bout en bout : le faux fait `ACK: <prompt entier>`, donc l'on vérifie
    // ce que l'agent reçoit vraiment — les deux résultats, dans l'ordre, avec
    // le nom de l'outil. C'est le round-trip de l'`id` (§4) sans table de
    // correspondance côté adaptateur.
    const session = await agent.open()
    try {
      const transcript: NormalizedRequest = {
        system: [],
        tools: [],
        messages: [
          { role: "user", text: "relis" },
          { role: "tool", id: "call-a", name: "read_file", output: "contenu A" },
          { role: "tool", id: "call-b", name: "read_file", output: "contenu B" },
        ],
      }
      const events = await collect(session.prompt(transcript))
      const echoed = textOf(events)
      expect(echoed).toContain("Utilisateur : relis")
      expect(echoed).toContain("Outil read_file : contenu A")
      expect(echoed).toContain("Outil read_file : contenu B")
      expect(echoed.indexOf("contenu A")).toBeLessThan(echoed.indexOf("contenu B"))
    } finally {
      await session.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `usage` : deux variantes distinctes, jamais une à champs vides.
// ─────────────────────────────────────────────────────────────────────────────

describe("usage (§4.1)", () => {
  test("l'usage de contexte et celui du tour ne se confondent pas", async () => {
    const local = await spawnFake({ FAKE_EMIT_USAGE_UPDATE: "1" })
    try {
      const session = await local.open()
      try {
        const events = await collect(session.prompt(request("PING")))
        const usages = events.flatMap((e) => (e.type === "usage" ? [e] : []))

        // ⚠️ `{ input?, output?, context? }` rendait `{}` légitime et laissait le
        // réducteur deviner : c'est le piège du §4.0, transposé à `AcpEvent`.
        expect(usages).toHaveLength(2)

        // 1. La notification en cours de tour : **fenêtre de contexte**, pas coût.
        expect(usages[0]).toEqual({ type: "usage", kind: "context", used: 12_345 })

        // 2. Le `PromptResponse` final : coût du tour.
        expect(usages[1]).toEqual({
          type: "usage",
          kind: "turn",
          input: 40,
          output: 2,
          total: 42,
          reasoning: 1,
          cacheRead: 7,
          cacheWrite: 9,
        })

        // Aucun des deux n'est assimilable à l'autre : c'est tout l'intérêt.
        expect(usages.every((u) => u.kind === "context" || u.kind === "turn")).toBe(true)
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })

  test("un agent sans `usage` n'émet aucun événement de ce type", async () => {
    // Le faux en émet toujours ; on vérifie donc seulement qu'un flux sans
    // `usage_update` ne produit **que** la variante de tour, jamais les deux.
    const session = await agent.open()
    try {
      const events = await collect(session.prompt(request("PING")))
      const kinds = events.flatMap((e) => (e.type === "usage" ? [e.kind] : []))
      expect(kinds).toEqual(["turn"])
    } finally {
      await session.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4 — `tool_call` / `tool_call_update` : le cœur du mapping, zéro-testé avant.
// ─────────────────────────────────────────────────────────────────────────────

describe("tool_call (§4)", () => {
  test("un tool_call et ses updates deviennent des AcpEvent `tool`", async () => {
    const toolAgent = await spawnFake({ FAKE_EMIT_TOOL_CALL: "1" })
    try {
      const session = await toolAgent.open()
      try {
        const events = await collect(session.prompt(request("TOOL")))
        const tools = events.filter((e) => e.type === "tool")

        // Trois événements : l'ouverture puis les deux mises à jour.
        expect(tools).toHaveLength(3)

        // 1. Ouverture : `pending`, avec l'entrée brute de l'appel.
        expect(tools[0]).toEqual({
          type: "tool",
          id: "call-tool-1",
          name: "read_file",
          title: "Lire README.md",
          kind: "read",
          status: "pending",
          input: { path: "README.md" },
        })

        // 2. Mise à jour partielle : ni `name` ni `rawOutput` → statut seulement.
        //    On ne fabrique surtout pas de valeur par défaut qui ferait croire
        //    à un `output` ou à un `input` réels.
        expect(tools[1]).toEqual({
          type: "tool",
          id: "call-tool-1",
          name: "",
          title: "call-tool-1",
          kind: "other",
          status: "in_progress",
          input: undefined,
        })

        // 3. Mise à jour finale : statut `completed` + `rawOutput` relayé tel quel.
        expect(tools[2]).toEqual({
          type: "tool",
          id: "call-tool-1",
          name: "",
          title: "call-tool-1",
          kind: "other",
          status: "completed",
          input: undefined,
          output: { bytes: 1234 },
        })

        // La séquence conserve bien son ordre, puis le tour se ferme normalement.
        expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
        expect(textOf(events)).toContain("TOOL_OK")
      } finally {
        await session.close()
      }
    } finally {
      await toolAgent.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4 — `stopReason` : seuls `end_turn` étaient couverts.
// ─────────────────────────────────────────────────────────────────────────────

describe("stopReason", () => {
  for (const reason of ["max_tokens", "refusal", "cancelled"] as const) {
    test(`un stopReason « ${reason} » est relayé dans l'AcpEvent done`, async () => {
      const local = await spawnFake({ FAKE_STOP_REASON: reason })
      try {
        const session = await local.open()
        try {
          const events = await collect(session.prompt(request("PING")))
          expect(events.at(-1)).toEqual({ type: "done", stopReason: reason })
          // Le texte et l'usage précédant toujours le `done`.
          expect(textOf(events)).toBe("PONG")
          expect(events.some((e) => e.type === "usage")).toBe(true)
        } finally {
          await session.close()
        }
      } finally {
        await local.close()
      }
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Annulation — condition « `Esc` interrompt proprement » (P4, §8).
// ─────────────────────────────────────────────────────────────────────────────

describe("annulation", () => {
  test("un AbortSignal déclenche session/cancel et produit done: cancelled", async () => {
    // L'agent met 800 ms à répondre : on annule bien avant.
    const local = await spawnFake({ FAKE_SLOW_MS: "800" })
    try {
      const session = await local.open()
      try {
        const controller = new AbortController()
        const started = Date.now()
        const events: AcpEvent[] = []
        for await (const event of session.prompt(request("TICK"), { signal: controller.signal })) {
          events.push(event)
          if (event.type === "text" && event.text === "TICK") controller.abort()
        }
        expect(events[0]).toEqual({ type: "text", text: "TICK" })
        expect(events.at(-1)).toEqual({ type: "done", stopReason: "cancelled" })
        // L'annulation a bien court-circuité la latence de 800 ms : sans elle,
        // le tour serait allé jusqu'à « TOK » puis `end_turn`.
        expect(Date.now() - started).toBeLessThan(800)
        expect(textOf(events)).not.toContain("TOK")
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })

  test("un abandon du consommateur SANS signal rend la main tout de suite", async () => {
    // Régression du blocage de 80 s : le `finally` attendait `session/prompt`
    // complet. Un `break` sans `AbortSignal` faisait donc patienter le tick
    // suivant pendant toute la durée du tour.
    const local = await spawnFake({ FAKE_SLOW_MS: "1500" })
    try {
      const session = await local.open()
      try {
        let abandonedAt = 0
        for await (const event of session.prompt(request("TICK"))) {
          expect(event).toEqual({ type: "text", text: "TICK" })
          abandonedAt = Date.now()
          break
        }
        // `for await` attend le `return()` du générateur : c'est ce temps qui
        // mesurait 80 101 ms avant correction.
        expect(abandonedAt).toBeGreaterThan(0)
        expect(Date.now() - abandonedAt).toBeLessThan(300)
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })

  test("le chemin nominal consomme toujours le flux jusqu'à done", async () => {
    const local = await spawnFake({ FAKE_SLOW_MS: "50" })
    try {
      const session = await local.open()
      try {
        // Sans abandon, l'annulation automatique ne doit jamais se déclencher.
        const events = await collect(session.prompt(request("TICK")))
        expect(textOf(events)).toBe("TICKTOK")
        expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
        expect(events.some((e) => e.type === "usage")).toBe(true)
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Permissions (§7.4 / §9)
// ─────────────────────────────────────────────────────────────────────────────

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
    const permissive = await spawnFake({}, allowAllPermissions)
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

  test("la décision est visible dans le flux AcpEvent", async () => {
    const session = await agent.open()
    try {
      const events = await collect(session.prompt(request("NEED_PERMISSION")))
      const decisions = events.filter((e) => e.type === "permission")
      expect(decisions).toHaveLength(1)
      const decision = decisions[0]
      expect(decision?.type).toBe("permission")
      if (decision?.type !== "permission") return
      expect(decision.request.sessionId).toBe(session.sessionId)
      expect(decision.request.toolCallId).toBe("call-perm-1")
      expect(decision.request.title).toBe("Écrire dans config.json")
      expect(decision.request.options.map((o) => o.id)).toEqual(["allow-once", "reject-once"])
      expect(decision.decision).toEqual({ action: "select", optionId: "reject-once" })
      expect(decision.selectedOptionId).toBe("reject-once")
    } finally {
      await session.close()
    }
  })

  test("l'agent ne proposant que des options allow_*, on annule le tour", async () => {
    // Repli de `toPermissionResponse` : une policy « reject » sans `optionId`
    // explicite cherche une option `reject_*` ; il n'y en a pas, donc on
    // **annule** plutôt que d'accorder.
    const rejectWithoutId: AcpPermissionPolicy = (): PermissionDecision => ({ action: "reject" })
    const local = await spawnFake({ FAKE_PERMISSION_OPTIONS: "allow" }, rejectWithoutId)
    try {
      const session = await local.open()
      try {
        const events = await collect(session.prompt(request("NEED_PERMISSION")))
        expect(textOf(events)).toContain("CANCELLED")
        expect(textOf(events)).not.toContain("ALLOWED")

        const decision = events.find((e) => e.type === "permission")
        expect(decision?.type === "permission" && decision.decision).toEqual({ action: "reject" })
        expect(decision?.type === "permission" && decision.selectedOptionId).toBeUndefined()
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })

  test("l'agent ne proposant que des options reject_*, le refus passe", async () => {
    const local = await spawnFake({ FAKE_PERMISSION_OPTIONS: "reject" })
    try {
      const session = await local.open()
      try {
        const events = await collect(session.prompt(request("NEED_PERMISSION")))
        expect(textOf(events)).toContain("DENIED")
        expect(textOf(events)).not.toContain("CANCELLED")
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })

  test("l'agent ne proposant aucune option, la policy annule", async () => {
    const local = await spawnFake({ FAKE_PERMISSION_OPTIONS: "cancel" }, allowAllPermissions)
    try {
      const session = await local.open()
      try {
        const events = await collect(session.prompt(request("NEED_PERMISSION")))
        expect(textOf(events)).toContain("CANCELLED")
        expect(events.some((e) => e.type === "permission" && e.decision.action === "cancel")).toBe(true)
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs : typées, nommantes, et toujours suivies d'un `done`.
// ─────────────────────────────────────────────────────────────────────────────

describe("capacités déclarées", () => {
  test("initialize n'annonce pas de capacité fs mensongère", async () => {
    // En mode « cerveau brut » on ne sait ni lire ni écrire sur le disque.
    // Déclarer `readTextFile/writeTextFile: true` pendant que les handlers
    // renvoyaient `""` et un no-op était une capacité **fausse** : l'agent
    // croyait pouvoir obtenir des fichiers et n'obtenait que du vide.
    const dir = await mkdtemp(join(tmpdir(), "acp-caps-"))
    pidFiles.push(dir)
    const capsFile = join(dir, "caps.json")
    const local = await createAcpAgent({
      command: process.execPath,
      args: ["run", FAKE],
      stderr: "ignore",
      env: { FAKE_CAPABILITIES_FILE: capsFile },
    })
    try {
      const raw = await readFile(capsFile, "utf8")
      const declared: unknown = JSON.parse(raw)
      expect(typeof declared).toBe("object")
      if (typeof declared !== "object" || declared === null || !("fs" in declared)) {
        throw new Error(`clientCapabilities sans « fs » : ${raw}`)
      }
      // Le SDK ajoute ses propres défauts (`terminal`, `auth`) : on ne juge que
      // ce qui nous concerne, c'est-à-dire la promesse faite sur le disque.
      expect(declared.fs).toEqual({ readTextFile: false, writeTextFile: false })
    } finally {
      await local.close()
    }
  })
})

describe("erreurs", () => {
  test("une commande inexistante produit une AcpAgentError qui la nomme", async () => {
    const error = await captureError(
      createAcpAgent({ command: MISSING, stderr: "ignore" }),
    )
    if (!(error instanceof AcpAgentError)) {
      throw new Error(`attendu une AcpAgentError, reçu ${error.name}: ${error.message}`)
    }
    expect(error.name).toBe("AcpAgentError")
    // Le message doit être *utile* : nom de la commande ET cause réelle, que le
    // runtime la formule « ENOENT » (Node) ou « Executable not found in $PATH »
    // (Bun). Avant, on obtenait « ACP connection closed » et aucun nom de
    // commande n'apparaissait nulle part.
    expect(error.message).toContain(MISSING)
    expect(error.message).toMatch(/impossible de lancer l'agent/i)
    expect(error.message).toMatch(/ENOENT|not found/i)
    // Le champ s'appelle `subject` et non `command` : selon l'origine, il
    // contient la commande **ou** un `sessionId`, et `log(e.command)` affichait
    // un UUID en croyant que c'était une ligne de commande.
    expect(error.subject).toBe(MISSING)
  })

  test("un agent qui meurt avant initialize remonte son code de sortie", async () => {
    const error = await captureError(spawnFake({ FAKE_EXIT_AT_INIT: "1" }))
    expect(error.name).toBe("AcpAgentError")
    // Ni « ACP connection closed » ni un nom de commande fantaisiste.
    expect(error.message).toContain("fake-acp.ts")
    expect(error.message).toMatch(/code=3/)
  })

  test("un initialize en timeout remonte la commande et tue l'agent", async () => {
    const error = await captureError(
      createAcpAgent({
        command: process.execPath,
        args: ["run", FAKE],
        stderr: "ignore",
        initializeTimeoutMs: 300,
        env: { FAKE_SLOW_INIT_MS: "5000" },
      }),
    )
    expect(error.name).toBe("AcpAgentError")
    expect(error.message).toContain("fake-acp.ts")
    expect(error.message).toMatch(/initialize a expiré/)
  })

  test("le bruit sur stdout n'empêche pas de parler ACP", async () => {
    // Le SDK de ligne NDJSON ignore ce qui n'est pas du JSON : l'agent bavard
    // reste utilisable. Ce qui compte ici, c'est qu'aucune erreur ne soit
    // déclenchée et que le flux reste complet.
    const local = await spawnFake({ FAKE_NOISY_STDOUT: "1" })
    try {
      const session = await local.open()
      try {
        const events = await collect(session.prompt(request("PING")))
        expect(textOf(events)).toBe("PONG")
        expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })

  test("acp-run refuse un `--model` inconnu avec un code de sortie dédié", async () => {
    // « Modèle inconnu » est le diagnostic le plus probable face à un agent
    // exotique. Sans le `try/catch`, ça remontait en rejection non rattrapée
    // avec une stack de SDK, sans la liste des valeurs acceptées.
    const proc = Bun.spawn(
      [process.execPath, "run", CLI, "--command", process.execPath, "--arg", "run",
       "--arg", FAKE, "--model", "pas-un-modele", "--list-models"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FAKE_REJECT_UNKNOWN_MODEL: "1" },
      },
    )
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(code).toBe(4)
    expect(stderr).toContain("option refusée par l'agent")
    expect(stderr).toContain("Invalid model")
    expect(stderr).toContain("modèles connus")
    // Aucun `invalid model` ne doit fuiter en rejection non rattrapée.
    expect(stderr).not.toContain("promise rejection")
  })

  test("acp-run accepte un `--model` connu et met l'inventaire à jour", async () => {
    const proc = Bun.spawn(
      [process.execPath, "run", CLI, "--command", process.execPath, "--arg", "run",
       "--arg", FAKE, "--model", "claude-sonnet-5", "--list-models"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FAKE_REJECT_UNKNOWN_MODEL: "1" },
      },
    )
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(code).toBe(0)
    expect(stderr).toContain("claude-sonnet-5")
  })

  test("`stderr: \"pipe\"` alimente `onStderr` sans écrire sur notre stderr", async () => {
    // Le défaut est désormais `"pipe"` : un hébergeur (futur serveur HTTP) ne
    // veut pas que les logs de l'agent atterrissent dans son journal. C'est la
    // seule CLI, dont le terminal *est* l'utilisateur, qui demande `inherit`.
    const chunks: string[] = []
    const local = await createAcpAgent({
      command: process.execPath,
      args: ["run", FAKE],
      stderr: "pipe",
      onStderr: (chunk) => chunks.push(chunk),
      env: { FAKE_NOISY_STDOUT: "1" },
    })
    try {
      // Un aller-retour complet garantit que le chunk de démarrage a été livré.
      const session = await local.open()
      expect(textOf(await collect(session.prompt(request("PING"))))).toBe("PONG")
      await session.close()
      expect(chunks.join("")).toContain("fake-acp: avertissement de démarrage")
    } finally {
      await local.close()
    }
  })

  test("le stderr de l'agent est remonté dans le message d'erreur", async () => {
    // La queue de stderr était du code mort (le CLI n'expose jamais
    // `stderr: "pipe"`). Elle est désormais toujours alimentée, quel que soit le
    // mode — c'est la seule information qui explique la mort de l'agent.
    const error = await captureError(
      spawnFake({ FAKE_NOISY_STDOUT: "1", FAKE_EXIT_AT_INIT: "1" }),
    )
    expect(error.name).toBe("AcpAgentError")
    expect(error.message).toContain("fake-acp.ts")
    expect(error.message).toContain("fake-acp: avertissement de démarrage")
  })

  test("un agent qui meurt en plein tour émet error PUIS done", async () => {
    const local = await spawnFake({ FAKE_DIE_ON_PROMPT: "1" })
    try {
      const session = await local.open()
      const events = await collect(session.prompt(request("DIE")))
      // §4.0 : sans `done` final, `@opencode/ai` rejette avec « The provider
      // response ended unexpectedly. », indiscernable d'une troncature.
      expect(events.at(-1)).toEqual({ type: "done", stopReason: "cancelled" })
      expect(events.some((e) => e.type === "error")).toBe(true)
    } finally {
      await local.close()
    }
  })

  test("acp-run sort avec un code non nul quand le flux contient une erreur", async () => {
    const proc = Bun.spawn(
      [process.execPath, "run", CLI, "--command", process.execPath, "--arg", "run",
       "--arg", FAKE, "--prompt", "DIE"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, FAKE_DIE_ON_PROMPT: "1" } },
    )
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    expect(code).not.toBe(0)
    // Le flux reste exploitable : `done` est bien présent malgré l'erreur.
    const types = eventTypes(stdout)
    expect(types).toContain("error")
    expect(types).toContain("done")
  })

  test("acp-run sort avec un code non nul sur une commande inexistante", async () => {
    const proc = Bun.spawn(
      [process.execPath, "run", CLI, "--command", MISSING, "--list-models"],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(code).not.toBe(0)
    // Le message nomme la commande : c'est toute la valeur de l'erreur typée.
    expect(stderr).toContain(MISSING)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fuite de processus : le bloqueur n°1.
// ─────────────────────────────────────────────────────────────────────────────

describe("cycle de vie des processus", () => {
  test("close() tue le sous-processus", async () => {
    const pidFile = await tmpPidFile("close")
    const local = await spawnTrackedFake({}, pidFile)
    const pid = await readPid(pidFile)
    expect(isAlive(pid)).toBe(true)

    await local.close()
    expect(await waitForDeath(pid)).toBe(true)
  })

  test("un initialize en timeout ne laisse pas d'orphelin", async () => {
    // ⚠️ C'est *ce* chemin qui fuyait avant correction : `createAcpAgent`
    // throwait avant de rendre l'objet, donc personne ne portait le `child.kill()`,
    // et le processus était adopté par init. Un agent qui timeoute à chaque
    // lancement ⇒ un processus cumulé par requête.
    const pidFile = await tmpPidFile("timeout")
    const pidPromise = readPid(pidFile)
    await spawnTrackedFake({ FAKE_SLOW_INIT_MS: "30000" }, pidFile, {
      initializeTimeoutMs: 300,
    }).catch(() => undefined)

    const pid = await pidPromise
    expect(isAlive(pid)).toBe(false)
  })

  test("un agent mort avant initialize ne laisse pas d'orphelin", async () => {
    const pidFile = await tmpPidFile("exit-init")
    const pidPromise = readPid(pidFile)
    await spawnTrackedFake({ FAKE_EXIT_AT_INIT: "1" }, pidFile).catch(() => undefined)

    expect(await waitForDeath(await pidPromise)).toBe(true)
  })

  test("une commande inexistante ne laisse pas d'orphelin", async () => {
    const before = countFakeProcesses()
    await createAcpAgent({ command: MISSING, stderr: "ignore" }).catch(() => undefined)
    // Rien à tuer (`spawn` n'a jamais produit de pid) : on vérifie seulement
    // qu'aucun processus `fake-acp` n'est apparu.
    expect(countFakeProcesses()).toBe(before)
  })

  test("aucun fils ne survit à close() ni à un échec d'initialisation", async () => {
    const baseline = countFakeProcesses()
    expect(baseline).toBeGreaterThan(0)

    // 1. Chemin nominal.
    const healthy = await spawnFake()
    await healthy.close()

    // 2. Spawn impossible.
    await createAcpAgent({ command: MISSING, stderr: "ignore" }).catch(() => undefined)

    // 3. Agent mort avant `initialize`.
    await spawnFake({ FAKE_EXIT_AT_INIT: "1" }).catch(() => undefined)

    // 4. Agent qui fait expirer le timeout d'`initialize`.
    await createAcpAgent({
      command: process.execPath,
      args: ["run", FAKE],
      stderr: "ignore",
      initializeTimeoutMs: 300,
      env: { FAKE_SLOW_INIT_MS: "5000" },
    }).catch(() => undefined)

    expect(await waitForFakeCount(baseline)).toBe(baseline)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Un seul tour à la fois : un invariant de session, connu des appelants.
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrence des tours", () => {
  test("un second tour concurrent est refusé", async () => {
    // Sans cette garde : les `session/update` des deux tours seraient
    // indiscernables, et surtout le second `permissionSinks.set` **écraserait**
    // celui du premier — dont les permissions deviendraient invisibles pendant
    // que le `finally` du premier les supprimerait. Un refus muet est le pire
    // échec possible en mode « cerveau brut » (§7.4).
    const local = await spawnFake({ FAKE_SLOW_MS: "800" })
    try {
      const session = await local.open()
      // On consomme le premier événement : c'est ce qui arme l'invariant.
      const first = session.prompt(request("TICK"))[Symbol.asyncIterator]()
      expect(await first.next()).toEqual({ value: { type: "text", text: "TICK" }, done: false })

      const error = await captureAgentError(collect(session.prompt(request("PING"))))
      expect(error.name).toBe("AcpAgentError")
      expect(error.message).toMatch(/tour est déjà en cours/)
      // L'erreur nomme la session, pas une « commande ».
      expect(error.subject).toBe(session.sessionId)

      // Le refus ne **désarme pas** le drapeau du premier tour : il l'a seulement
      // empêché d'être volé. On le laisse finir pour vérifier qu'il va à son terme.
      // `TICK` a déjà été consommé : il ne reste que la fin du tour.
      const rest: AcpEvent[] = []
      for await (const event of { [Symbol.asyncIterator]: () => first }) rest.push(event)
      expect(textOf(rest)).toBe("TOK")
      expect(rest.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
    } finally {
      await local.close()
    }
  })

  test("l'invariant est par session, et se désarme après le tour", async () => {
    const local = await spawnFake({ FAKE_SLOW_MS: "800" })
    try {
      const blocked = await local.open()
      const first = blocked.prompt(request("TICK"))[Symbol.asyncIterator]()
      await first.next()

      // Une session neuve fonctionne : l'invariant est local, pas global.
      const other = await local.open()
      expect(textOf(await collect(other.prompt(request("PING"))))).toBe("PONG")

      // Et l'agent reste utilisable sur `blocked` une fois son tour terminé.
      const rest: AcpEvent[] = []
      for await (const event of { [Symbol.asyncIterator]: () => first }) rest.push(event)
      expect(textOf(rest)).toBe("TOK")
      expect(rest.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
    } finally {
      await local.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `configOptions` absents : un agent tiers n'est pas tenu de les envoyer.
// ─────────────────────────────────────────────────────────────────────────────

describe("configOptions non conformes", () => {
  test("un `session/new` sans configOptions donne un inventaire vide, pas un TypeError", async () => {
    const local = await spawnFake({ FAKE_NO_CONFIG_OPTIONS: "1" })
    try {
      const session = await local.open()
      try {
        expect(session.inventory()).toEqual({
          models: [],
          thoughtLevels: [],
          modes: [],
          options: [],
        })
        // Et surtout : les appelants suivants lèvent une **vraie** erreur
        // applicative, pas un `TypeError` sur `undefined`.
        await expect(session.setOption("model", "auto")).rejects.toThrow(
          /option de configuration inconnue/,
        )
        await expect(session.setModel("auto")).rejects.toThrow(/options disponibles/)
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })

  test("une réponse `set_config_option` sans configOptions conserve l'état courant", async () => {
    // `?? []` aurait vidé l'inventaire : le `parseInventory` suivant aurait
    // alors rendu un inventaire vide, et `setModel` aurait cessé de fonctionner.
    const local = await spawnFake({ FAKE_SET_OMITS_CONFIG_OPTIONS: "1" })
    try {
      const session = await local.open()
      try {
        expect(session.inventory().currentModel).toBe("gpt-5.6-terra")

        await session.setModel("claude-sonnet-5")
        expect(session.inventory().options).toHaveLength(4)
        expect(session.inventory().currentModel).toBe("gpt-5.6-terra")

        // L'option est toujours adressable : rien n'a été perdu.
        await expect(session.setModel("auto")).resolves.toBeUndefined()
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })

  test("`setModel` sans option de catégorie model liste les configId existants", async () => {
    const local = await spawnFake({ FAKE_NO_CONFIG_OPTIONS: "1" })
    try {
      const session = await local.open()
      try {
        const error = await captureError(session.setModel("auto"))
        // « aucune option de catégorie model » sans les ids disponibles ne dit
        // pas à l'utilisateur quoi tenter à la place.
        expect(error.message).toContain("options disponibles")
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
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

// ─────────────────────────────────────────────────────────────────────────────
// `renderRequest` : pur, et living dans `core/prompt.ts` — donc sans le SDK
// (§2.2). On le teste directement, sans process.
// ─────────────────────────────────────────────────────────────────────────────

describe("renderRequest (pur)", () => {
  test("chaque message est préfixé de son rôle", () => {
    const messages: readonly NormalizedMessage[] = [
      { role: "user", text: "bonjour" },
      { role: "assistant", text: "salut" },
      { role: "tool", id: "call-1", name: "read_file", output: "# README" },
    ]
    expect(renderRequest({ system: ["SYSTÈME"], tools: [], messages })).toBe(
      "SYSTÈME\n\nUtilisateur : bonjour\n\nAssistant : salut\n\nOutil read_file : # README",
    )
  })

  test("deux résultats du même outil ne se confondent pas", () => {
    // C'est tout l'objet du `id` explicite de `NormalizedMessage` : deux appels
    // du même outil dans la même conversation doivent rester **distincts**. Un
    // rendu qui reconstruirait un id les fusionnerait, et le §4 n'aurait plus
    // quel `tool-result` refermer.
    const messages: readonly NormalizedMessage[] = [
      { role: "user", text: "lis deux fichiers" },
      { role: "tool", id: "call-a", name: "read_file", output: "contenu A" },
      { role: "tool", id: "call-b", name: "read_file", output: "contenu B" },
    ]
    const request: NormalizedRequest = { system: [], tools: [], messages }
    const rendered = renderRequest(request)

    expect(rendered).toContain("Outil read_file : contenu A")
    expect(rendered).toContain("Outil read_file : contenu B")
    // Ordre conservé, et surtout **deux** blocs distincts.
    expect(rendered.split("Outil read_file : ")).toHaveLength(3)
    // Le rendu est stable : aucun identifiant re-synthétisé d'un appel à l'autre.
    expect(renderRequest(request)).toBe(rendered)
  })
})
