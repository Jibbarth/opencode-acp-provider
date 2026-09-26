/**
 * Le `Transport` ACP sur stdio — PLAN.md §3.3.
 *
 * C'est **la seule** coquille du projet qui dépende à la fois d'`@opencode/ai`
 * et d'`effect` (§2.2 : ~150 lignes à jeter si les internels bougent). Elle ne
 * contient aucune logique métier : tout ce qu'elle fait, c'est
 *
 *   1. obtenir un `AcpAgent` (**mis en cache au niveau module**),
 *   2. ouvrir une session, y brancher le `Scope` de la requête,
 *   3. transformer le flux `AcpEvent` en trames, sans jamais s'arrêter avant le
 *      `finally` du `Scope`.
 *
 * ⚠️ Le cache de processus n'est pas une optimisation facultative : un
 * `initialize` ACP coûte une poignée de secondes, et le provider est appelé
 * **à chaque tour** d'une conversation. Sans cache, une session de chat
 * ganhou un `spawn` par message.
 *
 * ⚠️ `TransportExecution.http` est volontairement **absent** : il n'y a pas de
 * requête HTTP, et le fournir ferait croire au core qu'un contexte réseau existe
 * (URL, statut) alors que la seule chose qui peut échouer, c'est un pipe.
 * C'est aussi pourquoi une panne de pipe est rapportée en `ProviderInternalError`
 * et non en `TransportError` : le champ `transport` de ce dernier est un union
 * **fermé** à `["http","websocket"]`, sans valeur `stdio` (§8.a).
 */

import { Effect, Scope, Stream } from "effect"
import { Auth, Endpoint, Route } from "@opencode/ai/route"
import type { TransportDef, TransportExecution, TransportRuntime } from "@opencode/ai/route"
import type { TransportPrepareInput } from "@opencode/ai/route/transport/index"
import { AIError, InvalidRequestError, ProviderID, ProviderInternalError } from "@opencode/ai/schema/index"
import type { LLMRequest } from "@opencode/ai/schema/index"

import { AcpAgentError, createAcpAgent } from "../acp/agent.js"
import type { AcpAgent, AcpEvent, AcpPermissionPolicy, AcpSession, NormalizedRequest } from "../core/types.js"
import { allowAllPermissions, denyAllPermissions } from "../core/types.js"
import { agentKey, agentLabel, allowsEveryTool } from "../settings.js"
import type { AcpProviderSettings } from "../settings.js"
import { makeProtocol } from "./opencode-protocol.js"
import type { AcpBody, AcpFrame, ReducerState } from "./opencode-protocol.js"

/** Identifiant de la route : stable, et lisible dans un diagnostic. */
export const ROUTE_ID = "acp-stdio"

/** Valeur de `route.provider` : l'identité du provider telle que rapportée par OpenCode. */
export const PROVIDER = ProviderID.make("acp")

/**
 * URL **factice** mais valide.
 *
 * ⚠️ Elle n'est jamais appelée : le transport ACP ne fait pas de HTTP. Mais
 * `compileRequest` rend l'endpoint **avant** de choisir le transport, et
 * `Route.model` refuse une route sans `baseURL`. Un placeholder non valide
 * (`"acp"`) ferait échouer la route pour une raison qui n'a rien à voir avec le
 * fonctionnement réel.
 */
const PLACEHOLDER_BASE_URL = "http://acp.local"

// ─────────────────────────────────────────────────────────────────────────────
// Requête préparée
// ─────────────────────────────────────────────────────────────────────────────

/** Ce que `prepare` produit : exactement ce dont `execute` a besoin. */
export interface AcpPrepared {
  /** Valeur d'option de modèle à appliquer avant le prompt (§5.2). */
  readonly model: string
  /** La requête normalisée, déjà rendue par le protocole. */
  readonly request: NormalizedRequest
}

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs
// ─────────────────────────────────────────────────────────────────────────────

/** Étiquette commune à tous les messages : sans elle, « ACP connection closed » ne dit rien. */
const labelOf = (settings: AcpProviderSettings): string => agentLabel(settings)

/**
 * Traduit n'importe quelle exception en `AIError`.
 *
 * §8.a : pas de `TransportError.transport: "stdio"`, donc on reste dans
 * `ProviderInternalError` — qui reste dans l'union `AIError`, donc dans le
 * `retry` hook d'OpenCode, mais **sans** `status`. C'est une limite assumée :
 * `RateLimitError` et `QuotaExceededError` restent atteignables pour l'erreur
 * *signalée par l'agent* (§8.b), pas pour la mort du pipe.
 */
export const toAiError = (error: unknown, settings: AcpProviderSettings): AIError => {
  if (error instanceof AIError) return error
  const label = labelOf(settings)
  // `AcpAgentError` porte déjà la commande et la queue de stderr : ne pas
  // l'entourer d'un second message qui la noierait dans du jargon Effect.
  const detail =
    error instanceof AcpAgentError
      ? error.message
      : `${error instanceof Error ? error.message : String(error)}`
  return new AIError({
    reason: new ProviderInternalError({ message: `${label}: ${detail}`, cause: error }),
  })
}

/** `Effect.tryPromise` qui ne peut rien laisser fuir hors de l'union `AIError`. */
const attempt = <A>(settings: AcpProviderSettings, run: () => Promise<A>): Effect.Effect<A, AIError> =>
  Effect.tryPromise({
    try: run,
    catch: (error: unknown) => toAiError(error, settings),
  })

// ─────────────────────────────────────────────────────────────────────────────
// Cache de processus
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Politique de permissions appliquée à l'agent.
 *
 * ⚠️ `allowedTools` n'est appliqué que comme un **interrupteur** : tout ou rien.
 * Une liste blanche de noms exigerait de connaître le nom de l'outil au moment de
 * la demande de permission — or `PermissionRequest` (contrat portable, P0) n'a
 * pas de champ `name`, parce que la spec ACP rend `toolCallUpdate.name`
 * optionnel. Dégrader une liste blanche en « tout refuser » est le choix
 * **fail-safe** : qui whiteliste des outils attend une restriction, il n'en
 * obtient pas. P4 ajoutera `name` au contrat portable, et donc la liste blanche.
 */
const policyOf = (settings: AcpProviderSettings): AcpPermissionPolicy =>
  allowsEveryTool(settings) ? allowAllPermissions : denyAllPermissions

/**
 * Agents ACP vivants, indexés par `agentKey`.
 *
 * ⚠️ La clé de `Map` est conservée **en plus** de la promesse : sans elle, deux
 * providers qui veulent exactement le même agent ne partageraient rien, puisque
 * la clé n'est pas dérivable de la valeur.
 */
const agents = new Map<string, Promise<AcpAgent>>()

/**
 * Agent ACP correspondant aux settings, lancé si besoin.
 *
 * ⚠️ Une promesse **rejetée** est retirée du cache : sans ça, une commande
 * inexistante resterait en échec « pour l'éternité » dans ce processus, et le
 * message d'erreur de la **première** tentative (installation incomplète ?)
 * continuerait d'être renvoyé après que l'utilisateur a corrigé sa configuration.
 */
export const acquireAgent = (settings: AcpProviderSettings): Promise<AcpAgent> => {
  const key = agentKey(settings)
  const existing = agents.get(key)
  if (existing !== undefined) return existing
  const started = createAcpAgent({
    command: settings.command,
    ...(settings.args === undefined ? {} : { args: settings.args }),
    ...(settings.cwd === undefined ? {} : { cwd: settings.cwd }),
    ...(settings.env === undefined ? {} : { env: settings.env }),
    // La politique est une **valeur** de settings, pas une fonction : un package
    // provider ne reçoit que du JSON (§3.2).
    policy: policyOf(settings),
    stderr: settings.stderr ?? "pipe",
    // Le stderr de l'agent est **toujours** capté, mais il n'est relayé que si
    // quelqu'un l'écoute : en « provider », personne n'a fourni de `onStderr`, et
    // perdre ces lignes reviendrait à perdre la seule source qui dit pourquoi
    // l'agent est mort (§8.c). Le mode `"inherit"` écrit déjà sur notre stderr.
    onStderr:
      settings.stderr === "inherit"
        ? undefined
        : (chunk: string) => {
            process.stderr.write(`[${labelOf(settings)}] ${chunk}`)
          },
  })
  agents.set(key, started)
  started.catch(() => {
    if (agents.get(key) === started) agents.delete(key)
  })
  return started
}

/** Ferme tous les agents en cache et vide le cache (tests, arrêt du serveur). */
export const closeCachedAgents = async (): Promise<void> => {
  const pending = [...agents.values()]
  agents.clear()
  await Promise.all(pending.map(async (started) => {
    const agent = await started.catch(() => undefined)
    await agent?.close()
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applique une valeur d'option de session **avant** le prompt (§5.2).
 *
 * ⚠️ Trois cas, trois traitements : l'agent n'a pas d'option de cette catégorie
 * (il n'a qu'un modèle, ou qu'un effort : on n'a rien à faire) ; la valeur
 * demandée est déjà la courante (on n'envoie pas un `set_config_option`
 * inutile, qui ferait un aller-retour JSON-RPC par tour) ; la valeur n'est
 * **pas** dans la liste — on échoue avec la liste sous le nez de l'utilisateur
 * plutôt que de laisser l'agent refuser une valeur muette, ou pire, d'en
 * choisir une autre.
 *
 * ⚠️ `label` nomme la chose demandée (« modèle », « niveau d'effort ») : le même
 * code sert pour les deux, et un message qui dirait « le modèle "high" » serait
 * pire qu'inexploitable.
 */
const applyOption = async (
  session: AcpSession,
  category: "model" | "thought_level",
  label: string,
  value: string,
  settings: AcpProviderSettings,
): Promise<void> => {
  const option = session.inventory().options.find((entry) => entry.category === category)
  if (option === undefined) return
  if (option.currentValue === value) return
  if (!option.values.includes(value)) {
    throw new AcpAgentError(
      `${labelOf(settings)}: ${label} « ${value} » n'est pas proposé par cet agent ` +
        `(valeurs acceptées : ${option.values.join(", ")})`,
      labelOf(settings),
    )
  }
  await session.setOption(option.id, value)
}

/** Applique le modèle demandé (§5.2) — le `Model.ID` vient de la requête. */
const applyModel = async (
  session: AcpSession,
  model: string,
  settings: AcpProviderSettings,
): Promise<void> => applyOption(session, "model", "le modèle", model, settings)

/**
 * Applique le niveau d'effort du `variant` sélectionné (§5.2).
 *
 * ⚠️ C'est **après** `applyModel`, jamais avant : la liste des niveaux acceptés
 * dépend du modèle courant côté agent (`none` disparaît sur `claude-sonnet-5`
 * pour `copilot --acp`), et `setOption` relaie l'état complet renvoyé par
 * l'agent — c'est donc la seule façon de valider contre la bonne liste.
 *
 * ⚠️ Un effort absent des settings n'envoie rien : l'agent garde la valeur
 * qu'il annonce dans `session/new`. C'est le comportement correct pour un
 * `/model` sans variant sélectionné.
 */
const applyEffort = async (
  session: AcpSession,
  settings: AcpProviderSettings,
): Promise<void> => {
  const effort = settings.effort
  if (effort === undefined) return
  await applyOption(session, "thought_level", "le niveau d'effort", effort, settings)
}

/** Ouvre la session, en garantie de fermeture par le `Scope` de la requête. */
const openSession = (settings: AcpProviderSettings): Effect.Effect<
  AcpSession,
  AIError,
  Scope.Scope
> =>
  Effect.acquireRelease(
    Effect.flatMap(
      attempt(settings, () => acquireAgent(settings)),
      (agent) => attempt(settings, () => agent.open(settings.cwd === undefined ? {} : { cwd: settings.cwd })),
    ),
    (session) =>
      // Une session qui ne se ferme pas laisse un tour en vol côté agent et
      // bloque les tours suivants sur `turnInFlight` : on ne laisse **jamais**
      // remonter une erreur de fermeture.
      Effect.promise(() => session.close()).pipe(Effect.ignore),
  )

/**
 * Signal d'annulation du tour, armé par la fermeture du `Scope`.
 *
 * ⚠️ **Pourquoi ne pas se contenter d'abandonner l'itérateur.** Le `TransportRuntime`
 * d'`@opencode/ai` ne porte **aucun** signal d'interruption : quand OpenCode
 * abandonne le stream, le `Scope` se ferme et… rien d'autre ne se passe. Or le
 * générateur ACP est alors **suspendu** dans `await session.nextUpdate()`, et
 * l'agent, lui, continue de travailler. Renderer la main ne suffit donc pas :
 * il faut *dire* à l'agent d'arrêter, sinon il brûle un tour complet dans notre
 * dos et garde sa session occupée.
 *
 * D'où ce contrôleur : il est armé par un finalizer du **même** `Scope` que la
 * session, donc il se déclenche exactement quand la requête est interrompue.
 * Et comme les finalizers d'un `Scope` s'exécutent en **ordre inverse** de leur
 * enregistrement, celui-ci (enregistré après `openSession`) passe **avant** la
 * fermeture de la session : l'ordre sur le fil est donc
 * `session/cancel` puis `session/close`, comme le veut la spécification.
 */
const turnCancellation = Effect.acquireRelease(
  Effect.sync(() => new AbortController()),
  (controller) =>
    Effect.sync(() => {
      if (!controller.signal.aborted) controller.abort()
    }),
)

// ─────────────────────────────────────────────────────────────────────────────
// Trames
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Une trame = une chaîne JSON.
 *
 * ⚠️ Sérialiser, plutôt qu'émettre l'objet, n'est pas un caprice : le `Protocol`
 * décode chaque trame par `Schema.decodeUnknownEffect`, et `jsonEvent` est le seul
 * codec `string → Event` de l'API publique. Le gain — une trame inspectable dans
 * un log — vaut le round-trip JSON sur quelques centaines d'octets.
 *
 * ⚠️ `input` est normalisé à `{}` quand l'agent n'en a pas envoyé. La raison est
 * technique et sans exception possible : `JSON.stringify` **supprime** les clés
 * `undefined`, le décodeur du core exige la présence de la clé, et une
 * `tool_call_update` d'ACP qui ne fait qu'un changement de statut n'a pas
 * d'`rawInput`. Sans cette normalisation, le tour échouerait avec « Invalid
 * acp/acp-stdio stream event » — un message qui ne mentionne ni l'outil ni
 * l'agent.
 */
const toFrame = (event: AcpEvent): string =>
  JSON.stringify(
    event.type === "tool" ? { ev: { ...event, input: event.input ?? {} } } satisfies AcpFrame : { ev: event } satisfies AcpFrame,
  )

/** Traduit l'exception du générateur ACP en `AIError` (une trame avortée, pas une trame muette). */
const toFrameError = (error: unknown, settings: AcpProviderSettings): AIError => toAiError(error, settings)

// ─────────────────────────────────────────────────────────────────────────────
// Le transport
// ─────────────────────────────────────────────────────────────────────────────

/** `prepare` : le corps déjà rendu par le protocole, validé avant tout spawn. */
const prepare = (input: TransportPrepareInput<AcpBody>): Effect.Effect<AcpPrepared, AIError> => {
  const body = input.body
  if (body.request.messages.length === 0) {
    // Un tour sans message est un bug en amont, pas une réponse vide : l'agent
    // répondrait « ACK: » et l'utilisateur verrait un tour vide se terminer sans
    // comprendre pourquoi.
    return Effect.fail(
      new AIError({
        reason: new InvalidRequestError({
          message: "requête sans aucun message : il n'y a rien à envoyer à l'agent ACP",
        }),
      }),
    )
  }
  return Effect.succeed({ model: body.model, request: body.request })
}

/**
 * `execute` : un `Scope` par requête, une session par `Scope`.
 *
 * Le `Scope` est ce qui rend l'annulation propre : quand OpenCode interrompt le
 * stream (ou que le TUI abandonne le tour), le `Scope` se ferme, le contrôleur
 * d'annulation part — donc l'agent reçoit `session/cancel` — puis la session se
 * ferme (`session/close`). C'est aussi le filet qui garantit qu'un stream oublié
 * ne laisse ni session ni processus vivant.
 */
const execute = (
  prepared: AcpPrepared,
  _request: LLMRequest,
  _runtime: TransportRuntime,
  settings: AcpProviderSettings,
): Effect.Effect<TransportExecution<string>, AIError, Scope.Scope> =>
  Effect.gen(function* () {
    const session = yield* openSession(settings)
    // ⚠️ Enregistré **après** `openSession` : les finalizers d'un `Scope` sont
    // exécutés en ordre inverse, donc l'annulation part avant la fermeture.
    const cancellation = yield* turnCancellation
    yield* attempt(settings, () => applyModel(session, prepared.model, settings))
    yield* attempt(settings, () => applyEffort(session, settings))
    const frames: Stream.Stream<string, AIError> = Stream.fromAsyncIterable(
      // Le signal est passé **et** l'itérateur reste abandonnable : les deux
      // chemins d'annulation (interruption du stream, signal armé par le Scope)
      // convergent vers le même `session/cancel`, et l'agent est arrêté même si
      // le générateur reste suspendu dans `nextUpdate()`.
      session.prompt(prepared.request, { signal: cancellation.signal }),
      // Une exception du générateur devient un échec de flux : mieux vaut une
      // `AIError` qui nomme la commande qu'une trame avortée en silence.
      (error: unknown) => toFrameError(error, settings),
    ).pipe(Stream.map(toFrame))
    // ⚠️ Pas de `complete` : le core l'appelle après avoir consommé le flux *et*
    // l'avoir fermé, ce qui est trop tard pour une session ACP. La fermeture est
    // portée par le `Scope`, qui se ferme exactement au même moment.
    return { frames }
  })

/** Le transport, clos sur ses settings (la route est reconstruite pour chacun). */
export const makeTransport = (
  settings: AcpProviderSettings,
): TransportDef<AcpBody, AcpPrepared, string> => ({
  id: `${ROUTE_ID}/transport`,
  prepare,
  execute: (prepared, request, runtime) => execute(prepared, request, runtime, settings),
})

// ─────────────────────────────────────────────────────────────────────────────
// La route
// ─────────────────────────────────────────────────────────────────────────────

/** La route complète, prête à produire un `LanguageModel`. */
export const makeRoute = (settings: AcpProviderSettings): Route<AcpBody, AcpPrepared> =>
  Route.make({
    id: ROUTE_ID,
    provider: PROVIDER,
    // Le protocole est construit **ici**, donc avec les settings : c'est ce qui
    // permet au `systemSuffix` d'atteindre `body.from` sans état global.
    protocol: makeProtocol(settings),
    // Placeholder obligatoire — voir `PLACEHOLDER_BASE_URL`.
    endpoint: Endpoint.path("/", { baseURL: PLACEHOLDER_BASE_URL }),
    // stdio : ni token ni en-tête. `Auth.none` dit explicitement « pas
    // d'authentification HTTP » au lieu de laisser croire qu'il en manque une.
    auth: Auth.none,
    compact: undefined,
    transport: makeTransport(settings),
  })

/** L'état du réducteur, réexporté pour que les tests n'importent que l'adaptateur. */
export type { ReducerState }
