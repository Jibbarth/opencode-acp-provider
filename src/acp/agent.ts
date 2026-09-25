/**
 * Couche ACP — glue sur `@agentclientprotocol/sdk` (PLAN.md §2.0).
 *
 * C'est la **seule** partie du projet qui connaît le SDK. Elle ne contient
 * aucune logique métier : elle se contente de lancer un sous-processus,
 * de négocier le protocole, de brancher les handlers client, et de traduire les
 * notifications `session/update` en `AcpEvent` (contrat portable).
 *
 * Point de conception important : `client().connectWith(stream, fn)` lie la durée
 * de vie de `fn` à celle de la connexion. On utilise donc `client().connect(stream)`
 * qui renvoie une `ClientConnection` persistante (`{ agent, signal, closed, close() }`),
 * et on expose des méthodes `open()` / `inventory()` sur l'objet retourné.
 */

import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

import { parseInventory } from "../core/models.js"
import type {
  AcpAgent,
  AcpAgentInfo,
  AcpEvent,
  AcpPermissionPolicy,
  AcpSession,
  AcpStopReason,
  Inventory,
  NormalizedRequest,
  PermissionDecision,
  PermissionRequest,
} from "../core/types.js"
import { denyAllPermissions } from "../core/types.js"

/** Options de construction d'un agent ACP. */
export interface AcpAgentOptions {
  /** La commande à lancer, p. ex. `"copilot"` ou `"npx"`. */
  command: string
  /** Arguments, p. ex. `["--acp"]`. */
  args?: readonly string[]
  /** Répertoire de travail du sous-processus. */
  cwd?: string
  /** Variables d'environnement supplémentaires. */
  env?: Readonly<Record<string, string>>
  /**
   * Politique de décision pour `session/request_permission`.
   * ⚠️ Défaut : **refuser** tout (mode « cerveau brut », §7.4).
   */
  policy?: AcpPermissionPolicy
  /** Nom annoncé par le client ACP dans `initialize`. */
  clientName?: string
  /** Que faire du stderr de l'agent (utile en debug). */
  stderr?: "inherit" | "ignore" | "pipe"
  /** Timeout d'`initialize`, en ms. */
  initializeTimeoutMs?: number
}

/** Erreur enrichie du chemin de la commande, pour un diagnostic lisible. */
export class AcpAgentError extends Error {
  constructor(
    message: string,
    readonly command: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "AcpAgentError"
  }
}

const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation du prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rendu texte minimal d'une `NormalizedRequest`.
 *
 * ⚠️ Volontairement provisoire : la construction complète du prompt
 * (système + catalogue d'outils + contrat de sortie JSON, §7.3) arrive en P2b
 * et remplacera cette fonction par `core/prompt.ts`. Pour l'instant on se
 * contente de garder tout le texte visible, ce qui suffit à valider la chaîne
 * spawn → initialize → session/new → prompt → events.
 */
export const renderRequest = (request: NormalizedRequest): string => {
  const parts: string[] = []
  if (request.system.length > 0) parts.push(request.system.join("\n\n"))
  for (const message of request.messages) {
    switch (message.role) {
      case "user":
        parts.push(message.text)
        break
      case "assistant":
        parts.push(message.text)
        break
      case "tool":
        parts.push(`${message.name}: ${message.output}`)
        break
    }
  }
  return parts.join("\n\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// Traduction des notifications ACP en `AcpEvent`
// ─────────────────────────────────────────────────────────────────────────────

const textOf = (content: acp.ContentBlock | undefined): string | undefined => {
  if (content === undefined) return undefined
  if (content.type === "text") return content.text
  // Les images / audio / ressources ne sont pas traduits en texte : on les
  // ignore plutôt que de mentir sur leur contenu.
  return undefined
}

const toStopReason = (reason: acp.StopReason): AcpStopReason => reason

/**
 * Traduit une `session/update` en zéro ou plusieurs `AcpEvent`.
 * Les notifications purement métadonnées (`session_info_update`,
 * `available_commands_update`, `notice`, `compaction_*`…) ne produisent rien :
 * leur gestion appartient à l'adaptateur, pas au cœur.
 */
export const updateToEvents = (update: acp.SessionUpdate): AcpEvent[] => {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf(update.content)
      return text === undefined || text === "" ? [] : [{ type: "text", text }]
    }
    case "agent_thought_chunk": {
      const text = textOf(update.content)
      return text === undefined || text === "" ? [] : [{ type: "thought", text }]
    }
    case "tool_call":
      return [{
        type: "tool",
        id: update.toolCallId,
        name: update.name ?? "",
        title: update.title,
        kind: update.kind ?? "other",
        status: update.status ?? "pending",
        input: update.rawInput,
      }]
    case "tool_call_update": {
      // Une mise à jour peut être partielle : `output` n'est présent que si
      // l'agent l'envoie. On n'émet l'`output` que dans ce cas.
      const event: AcpEvent = {
        type: "tool",
        id: update.toolCallId,
        name: update.name ?? "",
        title: update.title ?? update.toolCallId,
        kind: update.kind ?? "other",
        status: update.status ?? "in_progress",
        input: update.rawInput,
      }
      return update.rawOutput === undefined ? [event] : [{ ...event, output: update.rawOutput }]
    }
    case "plan":
      return [{ type: "plan", entries: update.entries }]
    case "plan_update":
      // `plan_update` (API v1 héritée) porte un contenu *ou* du markdown :
      // seuls les items structurés sont traduisibles en `PlanEntry`.
      return update.plan.type === "items" ? [{ type: "plan", entries: update.plan.entries }] : []
    case "usage_update":
      return [{ type: "usage", context: update.used }]
    default:
      return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Implémentation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Traduit une décision de policy en réponse `session/request_permission`.
 * Un `reject` sans `optionId` explicite désigne la première option `reject_*`
 * proposée par l'agent ; s'il n'y en a aucune, on annule le tour.
 */
const toPermissionResponse = (
  decision: PermissionDecision,
  request: PermissionRequest,
): acp.RequestPermissionResponse => {
  if (decision.action === "cancel") return { outcome: { outcome: "cancelled" } }
  if (decision.optionId !== undefined) {
    return { outcome: { outcome: "selected", optionId: decision.optionId } }
  }
  const fallback = request.options.find((o) =>
    decision.action === "reject" ? o.kind.startsWith("reject_") : o.kind.startsWith("allow_"),
  )
  return fallback === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: fallback.id } }
}

const createSession = (
  connection: acp.ClientConnection,
  session: acp.ActiveSession,
): AcpSession => {
  // Les `configOptions` évoluent en cours de vie (§5.2) : on conserve le
  // **dernier relevé brut** renvoyé par l'agent, et `parseInventory` (fonction
  // pure) le traduit à la demande. On ne re-parse jamais une `AcpOption`
  // déjà normalisée : la forme brute et la forme normalisée n'ont pas les
  // mêmes noms de champs (`options` vs `values`).
  let raw: readonly unknown[] = session.newSessionResponse.configOptions ?? []
  let closed = false

  const assertOpen = (): void => {
    if (closed) throw new AcpAgentError("session closed", session.sessionId)
  }

  const setOption = async (configId: string, value: string): Promise<void> => {
    assertOpen()
    const option = parseInventory(raw).options.find((o) => o.id === configId)
    if (option === undefined) {
      throw new AcpAgentError(`unknown config option "${configId}"`, session.sessionId)
    }
    // Un booléen exige un payload typé : `{ type: "boolean", value: bool }`.
    const params: acp.SetSessionConfigOptionRequest = option.type === "boolean"
      ? { sessionId: session.sessionId, configId, type: "boolean", value: value === "true" }
      : { sessionId: session.sessionId, configId, value }
    const response = await connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      params,
    )
    // La spécification impose de renvoyer l'état complet : on le relaie tel quel.
    raw = response.configOptions
  }

  const inventory = (): Inventory => parseInventory(raw)

  const prompt = (
    request: NormalizedRequest,
    options_?: { signal?: AbortSignal },
  ): AsyncIterable<AcpEvent> => {
    assertOpen()
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<AcpEvent> {
        const signal = options_?.signal
        const onAbort = (): void => {
          // `session/cancel` est une notification : on ne peut pas await ici.
          void connection.agent
            .notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
            .catch(() => undefined)
        }
        if (signal?.aborted === true) onAbort()
        else signal?.addEventListener("abort", onAbort, { once: true })

        // `prompt()` résout avec la même completion que le message `stop` :
        // on s'en sert uniquement pour ne jamais laisser une rejection orpheline
        // si le consommateur abandonne l'itérateur.
        const pending = session.prompt(renderRequest(request))
        const settled = pending.then(
          () => undefined,
          (error: unknown) => error,
        )

        try {
          for (;;) {
            const message = await session.nextUpdate()
            if (message.kind === "stop") {
              const usage = message.response.usage
              if (usage !== undefined && usage !== null) {
                yield { type: "usage", input: usage.inputTokens, output: usage.outputTokens }
              }
              yield { type: "done", stopReason: toStopReason(message.stopReason) }
              return
            }
            const update = message.update
            if (update.sessionUpdate === "config_option_update") {
              raw = update.configOptions
              continue
            }
            for (const event of updateToEvents(update)) yield event
          }
        } catch (error) {
          yield { type: "error", message: error instanceof Error ? error.message : String(error) }
        } finally {
          signal?.removeEventListener("abort", onAbort)
          // Si l'itérateur a été abandonné avant la fin du tour, `prompt()`
          // résout (ou rejette) en arrière-plan : on l'attend pour ne jamais
          // laisser une rejection orpheline.
          await settled
        }
      },
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    session.dispose()
    try {
      await connection.agent.request(acp.methods.agent.session.close, { sessionId: session.sessionId })
    } catch {
      // `session/close` est optionnel (§ sessionCapabilities.close) : son absence
      // n'est pas une erreur, on se contente de libérer le routage local.
    }
  }

  return {
    sessionId: session.sessionId,
    inventory,
    async setModel(modelId: string): Promise<void> {
      const modelOption = parseInventory(raw).options.find((o) => o.category === "model")
      if (modelOption === undefined) {
        throw new AcpAgentError('agent exposes no "model" config option', session.sessionId)
      }
      await setOption(modelOption.id, modelId)
    },
    setOption,
    prompt,
    close,
  }
}

/**
 * Lance l'agent ACP et négocie `initialize`.
 * Renvoie un objet **persistant** : la connexion reste ouverte jusqu'à `close()`.
 */
export const createAcpAgent = async (options: AcpAgentOptions): Promise<AcpAgent> => {
  const policy = options.policy ?? denyAllPermissions
  const stderrMode = options.stderr ?? "inherit"

  // `stdio` est typé comme une union : on le fixe en amont pour que TypeScript
  // sache que stdin/stdout sont bien des pipes (condition de l'échange ACP).
  const stdio: ["pipe", "pipe", "pipe" | "inherit" | "ignore"] = [
    "pipe",
    "pipe",
    stderrMode,
  ]
  const child = spawn(options.command, [...(options.args ?? [])], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env },
    stdio,
  })

  const stream = acp.ndJsonStream(
    Writable.toWeb(requireStream(child.stdin, "stdin")),
    Readable.toWeb(requireStream(child.stdout, "stdout")),
  )

  // Un stdout illisible est un symptôme classique (l'agent a écrit sur stdout
  // avant de démarrer le protocole) : on remonte son stderr dans l'erreur.
  let stderrTail = ""
  if (child.stderr !== null) {
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000)
    })
  }

  let exited: Error | undefined
  child.once("error", (error: Error) => {
    exited = new AcpAgentError(`failed to spawn agent: ${error.message}`, options.command, {
      cause: error,
    })
  })
  const exit = new Promise<never>((_resolve, reject) => {
    child.once("exit", (code, signal) => {
      reject(
        new AcpAgentError(
          `agent exited (code=${String(code)}, signal=${String(signal)})${
            stderrTail ? `\n${stderrTail}` : ""
          }`,
          options.command,
        ),
      )
    })
  })
  // On n'observe jamais ce rejet directement : il sert de garde-fou « l'agent
  // est mort » pour les requêtes en vol.
  exit.catch(() => undefined)

  const app = acp
    .client({ name: options.clientName ?? "opencode-acp-provider" })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      const request: PermissionRequest = {
        sessionId: ctx.params.sessionId,
        toolCallId: ctx.params.toolCall.toolCallId,
        title: ctx.params.toolCall.title ?? ctx.params.toolCall.toolCallId,
        kind: ctx.params.toolCall.kind ?? "other",
        options: ctx.params.options.map((o) => ({
          id: o.optionId,
          name: o.name,
          kind: o.kind,
        })),
      }
      return toPermissionResponse(await policy(request), request)
    })
    // On déclare le support fs mais on ne lit ni n'écrit : c'est le mode
    // « cerveau brut », l'agent ne doit rien faire sur le disque (§7.4).
    .onRequest(acp.methods.client.fs.readTextFile, () => ({ content: "" }))
    .onRequest(acp.methods.client.fs.writeTextFile, () => ({}))

  const connection = app.connect(stream)

  const initialize = async (): Promise<acp.InitializeResponse> => {
    if (exited !== undefined) throw exited
    const request = connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    })
    const timeout = AbortSignal.timeout(options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS)
    try {
      return await Promise.race([request, exit, rejectOn(timeout, options.command)])
    } catch (error) {
      connection.close(error)
      throw error
    }
  }

  const initResponse = await initialize()

  const info: AcpAgentInfo = {
    name: initResponse.agentInfo?.name ?? options.command,
    version: initResponse.agentInfo?.version ?? "unknown",
  }

  let closed = false
  const assertAlive = (): void => {
    if (closed) throw new AcpAgentError("agent closed", options.command)
  }

  const openSession = async (
    openOptions: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<AcpSession> => {
    assertAlive()
    const active = await connection.agent
      .buildSession(openOptions.cwd ?? options.cwd ?? process.cwd())
      .start()
    return createSession(connection, active)
  }

  // L'inventaire vit dans la réponse de `session/new` : on ouvre une session
  // jetable, on lit, on referme.
  const inventory = async (): Promise<Inventory> => {
    const session = await openSession()
    try {
      return session.inventory()
    } finally {
      await session.close()
    }
  }

  return {
    info,
    protocolVersion: initResponse.protocolVersion,

    inventory,

    async models() {
      return (await inventory()).models
    },

    open: openSession,

    async close(): Promise<void> {
      if (closed) return
      closed = true
      connection.close()
      child.kill("SIGTERM")
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ])
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    },
  }
}

/** `stdio` est fixé à `"pipe"` ci-dessus : ce garde-fou n'est qu'un filet de sécurité. */
const requireStream = <T>(stream: T | null, name: string): T => {
  if (stream === null) throw new AcpAgentError(`spawn produced no ${name} stream`, "")
  return stream
}

const rejectOn = (signal: AbortSignal, command: string): Promise<never> =>
  new Promise((_resolve, reject) => {
    const onAbort = (): void =>
      reject(new AcpAgentError(`initialize timed out for "${command}"`, command))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
