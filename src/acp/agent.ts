/**
 * Couche ACP — glue sur `@agentclientprotocol/sdk` (PLAN.md §2.0).
 *
 * C'est la **seule** partie du projet qui connaît le SDK. Elle ne contient
 * aucune logique métier : elle se contente de lancer un sous-processus,
 * de négocier le protocole, de brancher les handlers client, et de traduire les
 * notifications `session/update` en `AcpEvent` (contrat portable).
 *
 * La construction du prompt vit dans `core/prompt.ts`, **pas ici** : c'est de la
 * logique métier, et un adaptateur qui la réutiliserait ne doit pas se retrouver
 * avec le SDK dans son graphe de dépendances (§2.2). On n'y fait qu'un appel.
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
import { renderRequest } from "../core/prompt.js"
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
  /**
   * Que faire du stderr de l'agent (utile en debug).
   *
   * ⚠️ Défaut `"pipe"` : un hébergeur (futur serveur HTTP, §2.3) ne veut pas
   * voir les logs de l'agent ACP tomber dans **son** journal, qui mélange
   * alors deux sources. Seule la CLI demande `"inherit"`.
   *
   * Quel que soit le mode, les dernières lignes sont conservées pour les
   * messages d'erreur : c'est la seule source qui dise *pourquoi* l'agent est
   * mort. Seule différence entre les modes : `"inherit"` les retransmet vers
   * notre propre stderr, `"pipe"` les transmet à `onStderr`, `"ignore"` n'en
   * fait rien (mais les garde pour l'erreur).
   */
  stderr?: "inherit" | "ignore" | "pipe"
  /** Reçoit chaque chunk de stderr de l'agent (mode `"pipe"`). */
  onStderr?: (chunk: string) => void
  /** Timeout d'`initialize`, en ms. */
  initializeTimeoutMs?: number
}

/**
 * Erreur enrichie du **sujet** de l'échec, pour un diagnostic lisible.
 *
 * ⚠️ Le champ s'appelle `subject` et non `command` parce qu'il ne contient
 * pas toujours une commande : selon l'origine de l'erreur, c'est l'étiquette
 * « commande + arguments », ou le `sessionId` d'une session, ou une chaîne
 * vide. Un champ nommé `command` invitait `log(e.command)` à afficher un UUID
 * en croyant que c'était une ligne de commande.
 */
export class AcpAgentError extends Error {
  constructor(
    message: string,
    /** Commande lancée **ou** `sessionId`, selon l'origine de l'erreur. */
    readonly subject: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "AcpAgentError"
  }
}

const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000

/** Point d'entrée des événements de permission d'une session (voir `createSession`). */
type PermissionSink = (event: AcpEvent) => void

/**
 * Réécrit toute erreur en `AcpAgentError` **en nommant la commande**.
 * C'est la seule garantie exploitable en CI : sans le nom de la commande, un
 * échec se réduit à « ACP connection closed », sans le moindre indice.
 */
const asAgentError = (error: unknown, label: string): AcpAgentError => {
  if (error instanceof AcpAgentError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new AcpAgentError(`${label}: échec du protocole ACP : ${detail}`, label, {
    cause: error,
  })
}

/**
 * Termine le sous-processus : `SIGTERM`, attente bornée, puis `SIGKILL`.
 * Idempotent, et sans effet si le spawn a échoué (pas de `pid`) ou si le
 * processus est déjà mort.
 */
const terminate = async (child: ReturnType<typeof spawn>): Promise<void> => {
  // Spawn impossible (commande inexistante) : `pid` est `undefined` et il n'y a
  // rien à tuer. Idem si le processus est déjà terminé — attendre 2 s un
  // `close` déjà émis n'apporterait rien.
  if (child.pid === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
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

/**
 * Couture assumée : les deux unions sont identiques, le typecheck suffit.
 * Le mapping ne sera nécessaire que si l'un des deux évolue — auquel cas ce
 * fichier est **le** point à retoucher, pas les appelants.
 */
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
      // Fenêtre de contexte, pas coût du tour : les deux sémantiques sont
      // désormais deux variantes distinctes de `usage` (cf. `core/types.ts`).
      return [{ type: "usage", kind: "context", used: update.used }]
    default:
      return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Implémentation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `Usage` ACP (au `stop`) → variante `turn` de l'`AcpEvent`.
 *
 * On ne propage que les champs **présents** : l'union les déclare optionnels
 * pour que le réducteur puisse les distinguer, pas pour qu'on invente des zéros.
 * `reasoning` / `cacheRead` / `cacheWrite` alimenteront directement la classe
 * `Usage` d'OpenCode en P1 (§4.1) — d'où leur présence ici plutôt qu'un simple
 * `input`/`output`.
 */
const toUsageEvent = (usage: acp.Usage): AcpEvent => ({
  type: "usage",
  kind: "turn",
  input: usage.inputTokens,
  output: usage.outputTokens,
  total: usage.totalTokens,
  ...(usage.thoughtTokens == null ? {} : { reasoning: usage.thoughtTokens }),
  ...(usage.cachedReadTokens == null ? {} : { cacheRead: usage.cachedReadTokens }),
  ...(usage.cachedWriteTokens == null ? {} : { cacheWrite: usage.cachedWriteTokens }),
})

/** Réponse `session/request_permission` + l'option réellement retenue. */
interface PermissionOutcome {
  response: acp.RequestPermissionResponse
  /** `undefined` quand le tour est annulé : rien n'a été proposé à l'agent. */
  selectedOptionId?: string
}

/**
 * Traduit une décision de policy en réponse `session/request_permission`.
 * Un `reject` sans `optionId` explicite désigne la première option `reject_*`
 * proposée par l'agent ; s'il n'y en a aucune, on annule le tour. Idem pour
 * `select` sans `optionId` avec les options `allow_*`.
 */
const toPermissionResponse = (
  decision: PermissionDecision,
  request: PermissionRequest,
): PermissionOutcome => {
  if (decision.action === "cancel") {
    return { response: { outcome: { outcome: "cancelled" } } }
  }
  if (decision.optionId !== undefined) {
    return {
      response: { outcome: { outcome: "selected", optionId: decision.optionId } },
      selectedOptionId: decision.optionId,
    }
  }
  const fallback = request.options.find((o) =>
    decision.action === "reject" ? o.kind.startsWith("reject_") : o.kind.startsWith("allow_"),
  )
  if (fallback === undefined) {
    // L'agent ne propose rien de compatible : on annule plutôt que d'accorder.
    return { response: { outcome: { outcome: "cancelled" } } }
  }
  return {
    response: { outcome: { outcome: "selected", optionId: fallback.id } },
    selectedOptionId: fallback.id,
  }
}

const createSession = (
  connection: acp.ClientConnection,
  session: acp.ActiveSession,
  permissionSinks: Map<string, PermissionSink>,
): AcpSession => {
  // Les `configOptions` évoluent en cours de vie (§5.2) : on conserve le
  // **dernier relevé brut** renvoyé par l'agent, et `parseInventory` (fonction
  // pure) le traduit à la demande. On ne re-parse jamais une `AcpOption`
  // déjà normalisée : la forme brute et la forme normalisée n'ont pas les
  // mêmes noms de champs (`options` vs `values`).
  let raw: readonly unknown[] = session.newSessionResponse.configOptions ?? []
  // `parseInventory` est pur : le résultat ne dépend que de `raw`. On le
  // mémoïse pour ne pas re-parcourir le relevé à chaque `inventory()`,
  // `setModel` et `setOption`, et on l'invalide à chaque écriture de `raw`.
  let parsedInventory: Inventory | undefined

  /** Invariant : `raw` est toujours un relevé exploitable, jamais `undefined`. */
  const setRaw = (next: readonly unknown[] | undefined): void => {
    // Un agent tiers peut omettre `configOptions`. `?? []` perdrait
    // l'inventaire courant ; on **conserve l'état précédent** plutôt que de
    // le vider — c'est le seul choix qui ne fasse pas régresser l'agent.
    if (next === undefined) return
    raw = next
    parsedInventory = undefined
  }

  /**
   * Invariant : `closed` passe à `true` **une fois** et ne revient jamais en
   * arrière, donc `assertOpen` est une garde suffisante pour tout le cycle de
   * vie de la session (aucune réouverture, aucune course possible).
   */
  let closed = false
  /** Invariant : armé à l'entrée de tout tour, désarmé dans son `finally`. */
  let turnInFlight = false

  const assertOpen = (): void => {
    if (closed) {
      throw new AcpAgentError(`session ${session.sessionId}: session fermée`, session.sessionId)
    }
  }

  const setOption = async (configId: string, value: string): Promise<void> => {
    assertOpen()
    const option = inventory().options.find((o) => o.id === configId)
    if (option === undefined) {
      throw new AcpAgentError(
        `session ${session.sessionId}: option de configuration inconnue « ${configId} »`,
        session.sessionId,
      )
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
    setRaw(response.configOptions)
  }

  const inventory = (): Inventory => (parsedInventory ??= parseInventory(raw))

  const prompt = (
    request: NormalizedRequest,
    options_?: { signal?: AbortSignal },
  ): AsyncIterable<AcpEvent> => {
    assertOpen()
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<AcpEvent> {
        const signal = options_?.signal

        // ⚠️ Invariant : **un seul tour à la fois** par session. Armé dès
        // l'entrée du générateur, désarmé dans le `finally`.
        //
        // Sans cette garde, deux `prompt()` concurrents partagent le même
        // `session.nextUpdate()` : les `session/update` des deux tours
        // seraient indiscernables, et surtout le second
        // `permissionSinks.set(sessionId, …)` **écraserait** celui du premier —
        // dont les permissions deviendraient invisibles, pendant que le
        // `finally` du premier les supprimerait. Un refus de permission muet est
        // le pire échec possible en mode « cerveau brut » (§7.4).
        if (turnInFlight) {
          throw new AcpAgentError(
            `session ${session.sessionId}: un tour est déjà en cours sur cette session`,
            session.sessionId,
          )
        }
        turnInFlight = true

        // Les décisions de permission sont prises **pendant** le tour, depuis un
        // handler qui n'a pas accès au générateur : on les tamponne et on les
        // réinjecte à chaque tour de boucle. Sans ça la politique est invisible
        // dans le flux.
        const pending: AcpEvent[] = []
        permissionSinks.set(session.sessionId, (event) => {
          pending.push(event)
        })

        /** `session/cancel` est une notification : on ne peut pas `await` ici. */
        const sendCancel = (): void => {
          void connection.agent
            .notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
            .catch(() => undefined)
        }
        const onAbort = (): void => {
          sendCancel()
        }
        if (signal?.aborted === true) onAbort()
        else signal?.addEventListener("abort", onAbort, { once: true })

        // `prompt()` résout avec la même completion que le message `stop`.
        // `settled` n'est **jamais** rejeté (les deux branches convertissent) :
        // c'est un filet anti-rejection orpheline, pas une attente.
        const pendingPrompt = session.prompt(renderRequest(request))
        const settled = pendingPrompt.then(
          () => undefined,
          (error: unknown) => error,
        )

        let completed = false
        try {
          for (;;) {
            const message = await session.nextUpdate()
            // Les permissions demandées pendant l'attente arrivent ici.
            for (const event of pending.splice(0)) yield event

            if (message.kind === "stop") {
              const usage = message.response.usage
              if (usage !== undefined && usage !== null) yield toUsageEvent(usage)
              // Invariant : `completed` est armé **avant** le `yield done` — à
              // cet instant le tour est fini, et il ne faut surtout pas envoyer
              // un `session/cancel` dans le vide si le consommateur s'arrête
              // dessus. L'armer après laisserait le `finally` annuler un tour
              // déjà terminé.
              completed = true
              yield { type: "done", stopReason: toStopReason(message.stopReason) }
              return
            }
            const update = message.update
            if (update.sessionUpdate === "config_option_update") {
              setRaw(update.configOptions)
              continue
            }
            for (const event of updateToEvents(update)) yield event
          }
        } catch (error) {
          yield { type: "error", message: error instanceof Error ? error.message : String(error) }
          // §4.0 : un flux qui s'arrête sans `done` fait échouer la chaîne
          // `@opencode/ai` avec « The provider response ended unexpectedly. ».
          // On ferme donc explicitement le tour.
          completed = true
          yield { type: "done", stopReason: "cancelled" }
        } finally {
          // ⚠️ Invariant : le tour se désarme dans **tous** les cas de sortie —
          // chemin nominal, `error`, ou abandon du consommateur. Sans cela, un
          // seul tour interrompu rendrait la session inutilisable à jamais.
          turnInFlight = false
          signal?.removeEventListener("abort", onAbort)
          permissionSinks.delete(session.sessionId)
          if (completed) {
            // Chemin nominal : le tour est fini, `settled` est déjà résolu.
            // On l'attend pour ne jamais laisser quoi que ce soit en suspens.
            await settled
          } else {
            // ⚠️ Le consommateur a abandonné (break / return / throw), possiblement
            // **sans** avoir fourni d'`AbortSignal`. Attendre `settled` ici
            // pouvait bloquer jusqu'à 80 s le tick suivant. On annule le tour et
            // on rend la main immédiatement ; `settled` ne rejette jamais, donc
            // aucune rejection ne peut devenir orpheline.
            sendCancel()
          }
        }
      },
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    session.dispose()
    try {
      await connection.agent.request(acp.methods.agent.session.close, {
        sessionId: session.sessionId,
      })
    } catch {
      // `session/close` est optionnel (§ sessionCapabilities.close) : son absence
      // n'est pas une erreur, on se contente de libérer le routage local.
    }
  }

  return {
    sessionId: session.sessionId,
    inventory,
    async setModel(modelId: string): Promise<void> {
      const options = inventory().options
      const modelOption = options.find((o) => o.category === "model")
      if (modelOption === undefined) {
        // On liste les `configId` existants : « aucune option de catégorie
        // model » ne dit pas à l'utilisateur quoi tenter à la place.
        const known = options.map((o) => o.id).join(", ") || "(aucune)"
        throw new AcpAgentError(
          `session ${session.sessionId}: aucune option de catégorie « model »` +
            ` ; options disponibles : ${known}`,
          session.sessionId,
        )
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
 *
 * ⚠️ Invariant de processus : *tout* chemin qui sort de cette fonction sans avoir
 * rendu l'objet doit avoir tué l'enfant. Avant, un `initialize` en timeout ou un
 * agent mort laissait un processus orphelin adopté par init — soit **un cumul par
 * requête** pour un agent qui timeoute systématiquement. C'est ce que garantit le
 * `try/catch` unique enveloppant toute la phase de démarrage.
 */
export const createAcpAgent = async (options: AcpAgentOptions): Promise<AcpAgent> => {
  const policy = options.policy ?? denyAllPermissions
  // Défaut `"pipe"` : un hébergeur ne veut pas que les logs de l'agent ACP
  // atterrissent dans son propre journal. Seule la CLI demande `"inherit"`.
  const stderrMode = options.stderr ?? "pipe"
  const args = [...(options.args ?? [])]
  // Étiquette lisible présente dans **tous** les messages d'erreur : sans elle,
  // un échec se réduit à « ACP connection closed », sans le nom de la commande.
  const label = [options.command, ...args].join(" ").trim()

  // Le stderr est **toujours** capté, quel que soit le mode : c'est la seule
  // source qui dise *pourquoi* l'agent est mort. Le mode ne décide que de la
  // **redistribution** (voir `AcpAgentOptions.stderr`), jamais de la capture.
  // (L'ancienne version ne captait qu'en mode `pipe`, que la CLI n'exposait pas :
  // la queue était donc toujours vide — du code mort.)
  const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"]
  const child = spawn(options.command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env },
    stdio,
  })

  let stderrTail = ""
  const tailOf = (): string =>
    stderrTail === "" ? "" : `\n--- stderr de l'agent ---\n${stderrTail.trim()}`
  const fail = (reason: string, cause?: unknown): AcpAgentError =>
    new AcpAgentError(
      `${label}: ${reason}${tailOf()}`,
      label,
      cause === undefined ? undefined : { cause },
    )
  const captureStderr = child.stderr
  if (captureStderr !== null) {
    captureStderr.setEncoding("utf8")
    captureStderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2_000)
      // `"inherit"` retransmet vers notre stderr, `"pipe"` vers l'hôte qui a
      // fourni `onStderr`, `"ignore"` nulle part — mais les trois modes
      // alimentent `stderrTail`, seule source du diagnostic de mort.
      if (stderrMode === "inherit") process.stderr.write(chunk)
      else if (stderrMode === "pipe") options.onStderr?.(chunk)
    })
  }

  // Permissions demandées pendant un tour, par `sessionId` : c'est le seul moyen
  // de les rendre observables dans le flux `AcpEvent` (§7.4).
  //
  // Invariant : **au plus une entrée par session ouverte**, posée par le tour en
  // cours et retirée par son `finally`. C'est pourquoi `prompt()` refuse deux
  // tours concurrents : un `set` aurait écrasé l'entrée du premier tour.
  const permissionSinks = new Map<string, PermissionSink>()

  let connection: acp.ClientConnection | undefined
  let terminated = false
  const shutdown = async (): Promise<void> => {
    if (terminated) return
    terminated = true
    await terminate(child)
  }

  // Garde-fou « l'agent est mort », unique et réellement atteignable. Le premier
  // des trois signaux observés sur un sous-processus l'emporte :
  //   · `error` → le spawn a échoué (commande inexistante) ; `exit` n'est alors
  //     jamais émis, c'est `close` qui l'est ;
  //   · `exit`  → mort avec un code ;
  //   · `close` → fin des stdio (couvre le cas sans code).
  let deathReason: AcpAgentError | undefined
  const death = new Promise<never>((_resolve, reject) => {
    const die = (error: AcpAgentError): void => {
      deathReason ??= error
      // On propage notre cause aux requêtes **en vol** : sinon elles ne
      // verraient que « ACP connection closed », sans nom de commande.
      connection?.close(deathReason)
      reject(deathReason)
    }
    child.once("error", (error: Error) => {
      die(fail(`impossible de lancer l'agent : ${error.message}`, error))
    })
    child.once("exit", (code, signal) => {
      die(fail(`l'agent s'est arrêté (code=${String(code)}, signal=${String(signal)})`))
    })
    child.once("close", () => {
      die(deathReason ?? fail("l'agent s'est arrêté sans code de sortie"))
    })
  })
  // `death` ne rejette pas toujours : l'agent peut mourir après coup, à la
  // fermeture. On neutralise son rejet pour éviter un `unhandledRejection`.
  death.catch(() => undefined)

  /**
   * Attend **brièvement** le constat de mort de l'agent. Renvoie `undefined`
   * s'il est toujours vivant au bout du délai.
   */
  const deathSoon = async (ms: number): Promise<AcpAgentError | undefined> =>
    await Promise.race([
      death,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
    ])

  let initResponse: acp.InitializeResponse
  try {
    // Un stdout illisible est un symptôme classique (l'agent a écrit sur stdout
    // avant de démarrer le protocole) : le message d'erreur le dira.
    const stream = acp.ndJsonStream(
      Writable.toWeb(requireStream(child.stdin, "stdin")),
      Readable.toWeb(requireStream(child.stdout, "stdout")),
    )

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
        const decision = await policy(request)
        const outcome = toPermissionResponse(decision, request)
        permissionSinks.get(ctx.params.sessionId)?.({
          type: "permission",
          request,
          decision,
          ...(outcome.selectedOptionId === undefined
            ? {}
            : { selectedOptionId: outcome.selectedOptionId }),
        })
        return outcome.response
      })

    connection = app.connect(stream)

    const request = connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        // Mode « cerveau brut » : on ne sait ni lire ni écrire sur le disque.
        // Déclarer `true` était une **capacité mensongère** — l'agent croyait
        // pouvoir nous faire lire des fichiers et n'obtenait que du vide. On
        // déclare donc explicitement `false` plutôt que d'ôter les handlers.
        fs: { readTextFile: false, writeTextFile: false },
      },
    })
    const timeout = AbortSignal.timeout(
      options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
    )
    initResponse = await Promise.race([request, death, rejectOn(timeout, label)])
  } catch (error) {
    // ⚠️ Correction de la fuite de processus : *aucune* sortie d'erreur ne doit
    // rendre la main avec l'enfant vivant. Ça couvre aussi une exception pendant
    // la construction du stream ou l'enregistrement des handlers.
    //
    // Quand l'agent est mort, **sa mort est la cause** : le SDK ne sait que dire
    // « ACP connection closed », ce qui est inutilisable. On attend donc brièvement
    // le constat de mort pour préférer le message qui nomme la commande, le code de
    // sortie et le stderr. Borné à 250 ms, et sans surcoût si l'agent est vivant
    // (timeout explicite) car on ne le consulte que sur une erreur non typée.
    const cause =
      error instanceof AcpAgentError ? undefined : (deathReason ?? (await deathSoon(250)))
    connection?.close(cause ?? error)
    await shutdown()
    throw cause ?? asAgentError(error, label)
  }

  const info: AcpAgentInfo = {
    name: initResponse.agentInfo?.name ?? options.command,
    version: initResponse.agentInfo?.version ?? "unknown",
  }

  let closed = false
  const assertAlive = (): void => {
    if (closed) throw new AcpAgentError(`${label}: agent fermé`, label)
  }

  const openSession = async (
    openOptions: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<AcpSession> => {
    assertAlive()
    const active = await connection.agent
      .buildSession(openOptions.cwd ?? options.cwd ?? process.cwd())
      .start()
    return createSession(connection, active, permissionSinks)
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
      // Les sessions encore ouvertes perdent leur capacité à émettre : on
      // libère le routage avant de fermer le canal.
      permissionSinks.clear()
      connection?.close()
      await shutdown()
    },
  }
}

/** `stdio` est fixé à `"pipe"` ci-dessus : ce garde-fou n'est qu'un filet de sécurité. */
const requireStream = <T>(stream: T | null, name: string): T => {
  if (stream === null) throw new AcpAgentError(`spawn produced no ${name} stream`, "")
  return stream
}

const rejectOn = (signal: AbortSignal, subject: string): Promise<never> =>
  new Promise((_resolve, reject) => {
    const onAbort = (): void =>
      reject(new AcpAgentError(`${subject}: initialize a expiré`, subject))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
