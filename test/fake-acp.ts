#!/usr/bin/env bun
/**
 * Agent ACP factice, construit avec le **vrai** SDK (`acp.agent()`) et parlant
 * sur stdio, exactement comme `copilot --acp`. Les tests le lancent comme un
 * sous-processus : on teste donc la chaîne complète spawn → ndJsonStream →
 * initialize → session/new → session/prompt, pas une version simplifiée in
 * process.
 *
 * Comportement observable (déterministe, sans latence par défaut) :
 *   - `initialize`  → protocole v1, `agentInfo: { name: "fake-acp", … }`
 *   - `session/new`  → 4 `configOptions` réalistes (3 modèles, 3 niveaux
 *                      d'effort, 2 modes dont un à URL longue, permissions)
 *   - `session/prompt` (les mots-clés sont cherchés dans le **dernier message
 *     utilisateur** du transcript, pas dans tout le prompt — voir `userText`) :
 *       · contient `PING`           → un chunk texte : `{"type":"text","text":"PONG"}`
 *       · contient `TICK`           → un `thought`, longue latence interruptible,
 *                                     puis `{"type":"text","text":"TOK"}`
 *       · contient `TOOL_PROPOSAL`  → une proposition d'outil au format JSON (§7.3)
 *       · contient `TOOL`           → `tool_call` puis deux `tool_call_update`,
 *                                     puis `{"type":"text","text":"TOOL_OK"}`
 *       · contient `PLAN`           → une notification `plan`, puis `PLAN_OK`
 *       · contient `NEED_PERMISSION`→ permission, puis `ALLOWED`/`DENIED`/`CANCELLED`
 *       · sinon                      → `{"type":"text","text":"ACK: <prompt>"}`
 *     puis `stop` avec un `usage`.
 *
 * ⚠️ **Pourquoi tout ceci respecte le contrat JSON de `core/prompt.ts` (§7.3).**
 * Depuis P2b, le provider **tamponne** le texte de l'agent et le décode au `done` :
 * un faux agent qui répond « ACK: … » en texte brut ferait échouer **tous** les
 * tours du bout-en-bout avec un `provider-error`. Un agent trop gentil laisse
 * passer des mutations, et le premier réflexe d'un faux est d'être inexact : il
 * obéit donc au contrat, et `FAKE_OUTPUT` permet de reprendre ponctuellement le
 * rôle d'un agent qui ne l'obéit pas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Paramétrage par variables d'environnement
 *
 * Le faux est paramétrable parce qu'un agent trop « gentil » laisse passer des
 * mutations : `tool_call`, `stopReason ≠ end_turn`, options `boolean`, repli de
 * policy, bruit sur stdout, mort en cours de prompt… n'étaient pas testables.
 * Chaque variable rend un cas trivial à atteindre depuis `acp.test.ts`.
 *
 * | Variable                       | Effet                                                      |
 * | ------------------------------ | ---------------------------------------------------------- |
 * | `FAKE_EMIT_TOOL_CALL=1`        | émet `tool_call` + `tool_call_update` (pending→in_progress→completed) |
 * | `FAKE_EMIT_USAGE_UPDATE=1`     | émet une notification `usage_update` (fenêtre de contexte) |
 * | `FAKE_STOP_REASON=<x>`         | `stopReason` du tour (`max_tokens`, `refusal`, `cancelled`) |
 * | `FAKE_BOOLEAN_OPTION=1`        | ajoute une `configOption` de `type: "boolean"`              |
 * | `FAKE_NO_CONFIG_OPTIONS=1`     | `session/new` **omet** `configOptions` (agent tiers non conforme) |
 * | `FAKE_SET_OMITS_CONFIG_OPTIONS=1` | `set_config_option` répond sans `configOptions`           |
 * | `FAKE_ECHO_CONFIG=1`           | `PING` répond `PONG <modèle> <effort>` : les options courantes    |
 * | `FAKE_REJECT_UNKNOWN_MODEL=1`  | `set_config_option` refuse une valeur hors de la liste (`Invalid model`) |
 * | `FAKE_PERMISSION_OPTIONS=<x>`  | `reject` \| `allow` \| `cancel` : seules ces options sont proposées |
 * | `FAKE_DIE_ON_PROMPT=1`         | quitte au milieu du prompt (avant le `stop`)                |
 * | `FAKE_NOISY_STDOUT=1`          | écrit du non-JSON sur stdout avant le protocole              |
 * | `FAKE_EXIT_AT_INIT=1`          | quitte avant de répondre à `initialize`                     |
 * | `FAKE_SLOW_INIT_MS=<n>`         | `initialize` ne répond qu'après `<n>` ms (teste le timeout)  |
 * | `FAKE_SLOW_MS=<n>`             | latence volontaire, interruptible par `session/cancel`      |
 * | `FAKE_OUTPUT=<x>`              | forme de la réponse : `contract` (défaut), `raw`, `fenced`, `hallucinated`, `bad-type` |
 */

import { writeFileSync } from "node:fs"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

// ─────────────────────────────────────────────────────────────────────────────
// Configuration par variables d'environnement
// ─────────────────────────────────────────────────────────────────────────────

const flag = (name: string): boolean => process.env[name] === "1"

/** Lit un entier positif ; `0` (ou une valeur absente / invalide) = pas de latence. */
const positiveInt = (name: string): number => {
  const raw = process.env[name]
  if (raw === undefined) return 0
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** Les seuls `stopReason` qu'un agent est censé pouvoir renvoyer. */
const STOP_REASONS = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"] as const

const STOP_REASON = ((): acp.StopReason => {
  const raw = process.env["FAKE_STOP_REASON"]
  const found = STOP_REASONS.find((reason) => reason === raw)
  return found ?? "end_turn"
})()

/** Latence d'`initialize` : sert à déclencher le timeout côté client. */
const SLOW_INIT_MS = positiveInt("FAKE_SLOW_INIT_MS")

/** Latence partagée par `wait()`. */
const SLOW_MS = positiveInt("FAKE_SLOW_MS")

/**
 * Forme de la réponse du faux agent — §7.3.
 *
 * `contract` est le seul mode « honnête » : c'est ce qu'un agent qui a compris
 * la consigne produit, et c'est donc le mode par défaut des tours de bout-en-bout.
 * Les autres rejouent les mutations les plus coûteuses à atteindre avec un vrai
 * agent : ne pas répondre du tout dans le format demandé, l'enfermer dans un
 * bloc de markdown, proposer un outil qui n'existe pas, ou se tromper de `type`.
 */
type OutputMode = "contract" | "raw" | "fenced" | "hallucinated" | "bad-type"

const OUTPUT_MODE = ((): OutputMode => {
  const raw = process.env["FAKE_OUTPUT"]
  if (raw === "raw" || raw === "fenced" || raw === "hallucinated" || raw === "bad-type") return raw
  return "contract"
})()

/** Le JSON du contrat, éventuellement déformé selon `FAKE_OUTPUT`. */
const answer = (text: string): string => {
  const contract = JSON.stringify({ type: "text", text })
  switch (OUTPUT_MODE) {
    case "raw":
      return text
    case "fenced":
      return `Voici ma réponse :\n\`\`\`json\n${contract}\n\`\`\`\n`
    case "hallucinated":
      return JSON.stringify({ type: "tool", name: "outil_qui_nexiste_pas", arguments: {} })
    case "bad-type":
      return JSON.stringify({ type: "réponse", text })
    default:
      return contract
  }
}

/** Un `thought` : le seul contenu encore streamé en direct depuis P2b. */
const thought = (text: string): acp.SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
})

/** La forme « tool » du contrat, déformée elle aussi par `FAKE_OUTPUT`. */
const answerTool = (name: string, args: Record<string, unknown>): string => {
  if (OUTPUT_MODE === "raw") return `${name} ${JSON.stringify(args)}`
  return JSON.stringify({ type: "tool", name, arguments: args })
}

/** Jeu d'options de permission proposé lors d'une `session/request_permission`. */
type PermissionFlavor = "mixed" | "reject" | "allow" | "cancel"

const PERMISSION_FLAVOR = ((): PermissionFlavor => {
  const raw = process.env["FAKE_PERMISSION_OPTIONS"]
  if (raw === "reject" || raw === "allow" || raw === "cancel") return raw
  return "mixed"
})()

const ALLOW_OPTION: acp.PermissionOption = {
  optionId: "allow-once",
  name: "Autoriser une fois",
  kind: "allow_once",
}
const REJECT_OPTION: acp.PermissionOption = {
  optionId: "reject-once",
  name: "Refuser",
  kind: "reject_once",
}

const PERMISSION_OPTIONS: readonly acp.PermissionOption[] = (() => {
  switch (PERMISSION_FLAVOR) {
    case "allow":
      return [ALLOW_OPTION]
    case "reject":
      return [REJECT_OPTION]
    // Aucune option du tout : force le repli `cancelled` de la policy.
    case "cancel":
      return []
    default:
      return [ALLOW_OPTION, REJECT_OPTION]
  }
})()

// ─────────────────────────────────────────────────────────────────────────────
// Données de l'inventaire
// ─────────────────────────────────────────────────────────────────────────────

const MODELS = [
  { value: "auto", name: "Auto", description: "Laisse l'agent choisir" },
  { value: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { value: "claude-sonnet-5", name: "Claude Sonnet 5" },
]

const THOUGHT_LEVELS = ["none", "medium", "high"]

/** Les identifiants de mode sont des URLs : c'est le cas réel qu'on veut couvrir. */
const MODES = [
  { value: "https://agentclientprotocol.com/registry/modes/agent#agent", name: "Agent" },
  { value: "https://agentclientprotocol.com/registry/modes/plan#plan", name: "Plan" },
]

const BOOLEAN_OPTION: acp.SessionConfigOption = {
  id: "telemetry",
  name: "Telemetry",
  type: "boolean",
  category: "permissions",
  currentValue: false,
}

const CONFIG_OPTIONS: acp.SessionConfigOption[] = [
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "gpt-5.6-terra",
    options: MODELS,
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    type: "select",
    category: "thought_level",
    currentValue: "medium",
    options: THOUGHT_LEVELS.map((value) => ({ value, name: value })),
  },
  {
    id: "mode",
    name: "Mode",
    type: "select",
    category: "mode",
    currentValue: MODES[0]?.value ?? "",
    options: MODES,
  },
  {
    id: "allow_all",
    name: "Allow all tools",
    type: "select",
    category: "permissions",
    currentValue: "off",
    options: [
      { value: "on", name: "On" },
      { value: "off", name: "Off" },
    ],
  },
  // `FAKE_BOOLEAN_OPTION=1` : c'est le seul moyen d'exercer le payload typé
  // `{ type: "boolean", value: bool }` de `session/set_config_option`.
  ...(flag("FAKE_BOOLEAN_OPTION") ? [BOOLEAN_OPTION] : []),
]

/**
 * Compteurs du tour, avec les champs optionnels réellement renseignés : c'est
 * la forme relevée sur `copilot --acp` (§4.1), et elle doit survivre jusqu'à
 * l'`AcpEvent` pour alimenter la classe `Usage` d'OpenCode en P1.
 */
const USAGE = {
  totalTokens: 42,
  inputTokens: 40,
  outputTokens: 2,
  thoughtTokens: 1,
  cachedReadTokens: 7,
  cachedWriteTokens: 9,
}

/** Fenêtre de contexte, dans `usage_update`. */
const CONTEXT_USED = 12_345

const chunk = (text: string): acp.SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
})

// ─────────────────────────────────────────────────────────────────────────────
// Implémentation
// ─────────────────────────────────────────────────────────────────────────────

/** État par session : permet à `session/set_config_option` d'être réellement mutable. */
class FakeAgent {
  private readonly sessions = new Map<string, acp.SessionConfigOption[]>()
  /** Sessions dont le tour en cours a été annulé par `session/cancel`. */
  private readonly cancelled = new Set<string>()

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    // `FAKE_CAPABILITIES_FILE=<chemin>` : on note ce que le client **a déclaré**
    // pouvoir faire. C'est le seul moyen de vérifier depuis l'extérieur que
    // `initialize` n'annonce pas de fausses capacités.
    const capabilities = process.env["FAKE_CAPABILITIES_FILE"]
    if (capabilities !== undefined) {
      writeFileSync(capabilities, JSON.stringify(params.clientCapabilities ?? null))
    }
    if (SLOW_INIT_MS > 0) {
      // Répond tard mais correctement : c'est le **timeout du client** qui doit
      // se déclencher, et qui doit tuer l'agent en sortant en erreur.
      await new Promise((resolve) => setTimeout(resolve, SLOW_INIT_MS))
    }
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
      agentInfo: { name: "fake-acp", version: "0.1.0" },
    }
  }

  newSession(): acp.NewSessionResponse {
    const sessionId = `fake-${Math.random().toString(16).slice(2, 10)}`
    this.sessions.set(sessionId, structuredClone(CONFIG_OPTIONS))
    const response: acp.NewSessionResponse = {
      sessionId,
      configOptions: structuredClone(CONFIG_OPTIONS),
    }
    // `FAKE_NO_CONFIG_OPTIONS=1` : on **omet** le champ. Un agent tiers n'est
    // pas tenu de l'envoyer, et le client ne doit pas exploser sur du
    // `undefined` au prochain `inventory()`. (`Reflect.deleteProperty` car
    // `delete` exigerait un champ optionnel — et le test doit envoyer un objet
    // *réellement* dépourvu du champ, pas un objet typé `undefined`.)
    if (flag("FAKE_NO_CONFIG_OPTIONS")) Reflect.deleteProperty(response, "configOptions")
    return response
  }

  setConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): acp.SetSessionConfigOptionResponse {
    // `FAKE_REJECT_UNKNOWN_MODEL=1` : on se comporte comme `copilot`, qui
    // répond -32602 « Invalid model » avec la liste des valeurs acceptées.
    if (
      flag("FAKE_REJECT_UNKNOWN_MODEL") &&
      params.configId === "model" &&
      !MODELS.some((m) => m.value === params.value)
    ) {
      // Une `RequestError` explicite : un `throw` d'`Error` brut serait
      // remonté en -32603 « Internal error », sans le message utile.
      throw acp.RequestError.invalidParams(
        { supported: MODELS.map((m) => m.value) },
        `Invalid model: ${String(params.value)}`,
      )
    }
    const current = this.sessions.get(params.sessionId) ?? structuredClone(CONFIG_OPTIONS)
    const next = current.map((option) => {
      if (option.id !== params.configId) return option
      if (option.type === "boolean") {
        return { ...option, currentValue: params.value === true }
      }
      return { ...option, currentValue: String(params.value) }
    })
    this.sessions.set(params.sessionId, next)
    // La spec impose de renvoyer l'état complet. Un agent non conforme l'omet :
    // le client doit alors **conserver** son état courant, pas le vider.
    const response: acp.SetSessionConfigOptionResponse = { configOptions: next }
    if (flag("FAKE_SET_OMITS_CONFIG_OPTIONS")) {
      Reflect.deleteProperty(response, "configOptions")
    }
    return response
  }

  /** `session/cancel` : on mémorise la session, `wait()` le remarque au tick suivant. */
  cancel(params: acp.CancelNotification): void {
    this.cancelled.add(params.sessionId)
  }

  /**
   * Valeurs courantes du modèle et de l'effort, pour les tests qui vérifient
   * que l'adaptateur les a **appliquées** avant le prompt (§5.2).
   *
   * Sans cela, `set_config_option` serait un aller-retour JSON-RPC sans
   * contrepartie observable : le test passerait même si le câblage du variant
   * disparaissait, ce qui est précisément la régression à surveiller.
   */
  private echoConfig(sessionId: string): string {
    const current = this.sessions.get(sessionId) ?? CONFIG_OPTIONS
    const read = (id: string): string => {
      const option = current.find((entry) => entry.id === id)
      return option === undefined ? "?" : String(option.currentValue)
    }
    return `PONG ${read("model")} ${read("reasoning_effort")}`
  }

  /**
   * Latence interruptible : unlike à `setTimeout`, elle **réagit** à
   * `session/cancel`, ce qui permet de tester l'annulation sans.course.
   */
  private async wait(sessionId: string): Promise<void> {
    const deadline = Date.now() + SLOW_MS
    while (!this.cancelled.has(sessionId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  async prompt(
    params: acp.PromptRequest,
    cx: acp.AgentContext,
  ): Promise<acp.PromptResponse> {
    const text = userText(promptText(params))
    const notify = (update: acp.SessionUpdate): Promise<void> =>
      cx.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update })
    const finish = (stopReason: acp.StopReason = STOP_REASON): acp.PromptResponse => ({
      stopReason,
      usage: USAGE,
    })
    const interrupted = (): boolean => this.cancelled.has(params.sessionId)

    // Cas « TICK » : un `thought` tout de suite, puis une longue latence. Le
    // `thought` est ce qui reste streamé en direct depuis P2b (le texte, lui, est
    // tamponné jusqu'au `done`), donc c'est lui qui permet de vérifier que le
    // tour avance et que l'abandon du consommateur rend la main sans attendre.
    if (text.includes("TICK")) {
      await notify(thought("TICK"))
      await this.wait(params.sessionId)
      if (interrupted()) return finish("cancelled")
      await notify(chunk(answer("TOK")))
      return finish()
    }

    await this.wait(params.sessionId)
    if (interrupted()) return finish("cancelled")

    // `usage_update` est une sémantique **différente** du `usage` de fin de tour
    // (fenêtre de contexte vs coût du tour) : les deux doivent rester
    // distinguables dans le flux, d'où deux variantes distinctes de `AcpEvent`.
    if (flag("FAKE_EMIT_USAGE_UPDATE")) {
      await notify({ sessionUpdate: "usage_update", used: CONTEXT_USED, size: 200_000 })
    }

    if (text.includes("NEED_PERMISSION")) {
      const response = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "call-perm-1",
          title: "Écrire dans config.json",
          kind: "edit",
          status: "pending",
        },
        options: [...PERMISSION_OPTIONS],
      })
      const selected = response.outcome.outcome === "selected" ? response.outcome.optionId : ""
      const verdict =
        selected === "allow-once" ? "ALLOWED" : selected === "reject-once" ? "DENIED" : "CANCELLED"
      await notify(chunk(answer(verdict)))
    } else if (text.includes("TOOL_PROPOSAL")) {
      // ⚠️ Le chemin §7.3 : l'agent **propose** un outil d'OpenCode et
      // n'exécute rien lui-même. C'est du texte ordinaire côté ACP — c'est le
      // réducteur qui le décode et en fait un `tool-call`.
      await notify(chunk(answerTool("read", { filePath: "README.md" })))
    } else if (text.includes("TOOL")) {
      // §4 : `tool_call` puis `tool_call_update` (pending → in_progress →
      // completed), avec `content`/`rawOutput` sur la mise à jour finale.
      const toolCallId = "call-tool-1"
      await notify({
        sessionUpdate: "tool_call",
        toolCallId,
        name: "read_file",
        title: "Lire README.md",
        kind: "read",
        status: "pending",
        rawInput: { path: "README.md" },
      })
      await this.wait(params.sessionId)
      await notify({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" })
      await this.wait(params.sessionId)
      await notify({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "# README" } }],
        rawOutput: { bytes: 1234 },
      })
      await notify(chunk(answer("TOOL_OK")))
    } else if (text.includes("PLAN")) {
      await notify({
        sessionUpdate: "plan",
        entries: [
          { content: "Analyser", priority: "high", status: "completed" },
          { content: "Implémenter", priority: "medium", status: "in_progress" },
        ],
      })
      await notify(chunk(answer("PLAN_OK")))
    } else if (text.includes("PING")) {
      await notify(chunk(answer(flag("FAKE_ECHO_CONFIG") ? this.echoConfig(params.sessionId) : "PONG")))
    } else {
      // Le défaut « echo » : il renvoie le prompt **qu'il a reçu**, ce qui est le
      // seul moyen de vérifier `fromRequest` et `renderRequest` de bout en bout.
      //
      // ⚠️ En mode `raw` on n'échoie que le message utilisateur : le prompt
      // complet contient le contrat de sortie et ses exemples, donc l'extracteur
      // tolérant de `parseAgentOutput` y trouverait un objet **valide** — et
      // « raw » passerait par un chemin vert, exactement le faux positif que ce
      // mode est censé produire.
      await notify(chunk(answer(OUTPUT_MODE === "raw" ? text : `ACK: ${promptText(params)}`)))
    }

    if (flag("FAKE_DIE_ON_PROMPT") && text.includes("DIE")) {
      // Mort en plein tour : le client doit voir un `error` **puis** un `done`,
      // jamais une troncature muette.
      process.exit(7)
    }

    return finish()
  }

  closeSession(params: acp.CloseSessionRequest): acp.CloseSessionResponse {
    this.sessions.delete(params.sessionId)
    this.cancelled.delete(params.sessionId)
    return {}
  }
}

const promptText = (params: acp.PromptRequest): string =>
  params.prompt
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")

/** Ce qui interrompt un message utilisateur : un autre rôle, ou la section suivante. */
const END_OF_USER_MESSAGE = /(?:\n## |\n(?:Utilisateur|Assistant|Outil [^\n]*) : )/

/** Début de ligne du préfixe de rôle écrit par `renderRequest`. */
const USER_LINE = /^Utilisateur : /gm

/**
 * Le **dernier message utilisateur** du prompt.
 *
 * ⚠️ Les mots-clés du faux agent (`PING`, `TOOL`…) ne doivent porter que sur ce
 * que l'utilisateur a réellement demandé. Les chercher dans tout le prompt était
 * tenable tant qu'il ne contenait que le transcript ; depuis P2b il contient le
 * **contrat de sortie**, ses exemples et le nom de tous les outils — n'importe
 * lequel de ces mots rendrait le faux incapable de choisir sa branche. On isole
 * donc le segment, du préfixe « Utilisateur : » jusqu'au premier début de ligne
 * qui en est un autre ou au début de la section suivante.
 */
const userText = (full: string): string => {
  const starts = [...full.matchAll(USER_LINE)]
  const last = starts[starts.length - 1]
  if (last?.index === undefined) return full
  const after = full.slice(last.index + last[0].length)
  const end = after.search(END_OF_USER_MESSAGE)
  return end === -1 ? after : after.slice(0, end)
}

// ─────────────────────────────────────────────────────────────────────────────
// Câblage stdio
// ─────────────────────────────────────────────────────────────────────────────

const agent = new FakeAgent()

// `FAKE_PID_FILE=<chemin>` : on écrit notre pid sur disque. C'est ce qui permet
// au test de fuité de vérifier **précisément** que *ce* processus-là est mort,
// plutôt que de compter des `ps` et d'attendre assez longtemps pour qu'un
// orphelin disparaisse tout seul.
const PID_FILE = process.env["FAKE_PID_FILE"]
if (PID_FILE !== undefined) {
  writeFileSync(PID_FILE, `${process.pid}\n`)
}

// `FAKE_NOISY_STDOUT=1` : un agent bavard écrit avant de démarrer le protocole,
// sur stdout **et** sur stderr. Le client doit absorber le bruit sur stdout, et
// le stderr doit apparaître dans le message d'erreur — c'est la seule source qui
// dise pourquoi l'agent est mort, et c'était du code mort tant que le CLI
// n'exposait pas `stderr: "pipe"`.
if (flag("FAKE_NOISY_STDOUT")) {
  process.stdout.write("Ceci n'est pas du JSON, désolé.\n")
  process.stderr.write("fake-acp: avertissement de démarrage\n")
}

if (flag("FAKE_EXIT_AT_INIT")) {
  // Mort avant même de répondre à `initialize` : le garde-fou « l'agent est
  // mort » doit produire une erreur nommant la commande et son code de sortie.
  acp
    .agent({ name: "fake-acp" })
    .onRequest(acp.methods.agent.initialize, () => process.exit(3))
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout),
        Readable.toWeb(process.stdin),
      ),
    )
} else {
  acp
    .agent({ name: "fake-acp" })
    .onRequest(acp.methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
    .onRequest(acp.methods.agent.session.new, () => agent.newSession())
    .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => agent.setConfigOption(ctx.params))
    .onRequest(acp.methods.agent.session.prompt, (ctx) => agent.prompt(ctx.params, ctx.client))
    .onRequest(acp.methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onNotification(acp.methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout),
        Readable.toWeb(process.stdin),
      ),
    )
}
