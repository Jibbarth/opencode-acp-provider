/**
 * Le contrat portable du projet — PLAN.md §2.1.
 *
 * ⚠️ Ce fichier n'importe **rien** : ni le SDK ACP, ni `@opencode/ai`, ni `effect`.
 * C'est la garantie que le cœur (`core/`) survit à un changement de transport,
 * de SDK ou d'hôte (§2.2 du plan). Toute référence au protocole ACP passe par
 * les types structurels déclarés ici.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Événements de sortie d'un agent ACP
// ─────────────────────────────────────────────────────────────────────────────

/** Raison d'arrêt d'un tour de prompt, alignée sur le `StopReason` d'ACP. */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"

/**
 * L'unique flux que partagent les trois adaptateurs (OpenCode, HTTP, CLI).
 * C'est le « point de bascule » du plan : tout ce qui est au-dessus ne parle
 * que `AcpEvent`, tout ce qui est en dessous parle ACP.
 */
export type AcpEvent =
  /** Morceau de texte produit par l'agent (réponse visible). */
  | { type: "text"; text: string }
  /** Réflexion de l'agent — à router vers `reasoning-*` côté OpenCode. */
  | { type: "thought"; text: string }
  /** Ouverture ou mise à jour d'un appel d'outil natif de l'agent. */
  | {
      type: "tool"
      id: string
      /** Nom programmatique de l'outil ; vide si l'agent n'en fournit pas. */
      name: string
      /** Titre lisible, toujours présent côté ACP. */
      title: string
      kind: string
      status: string
      input: unknown
      output?: unknown
    }
  /** Plan d'exécution de l'agent. */
  | { type: "plan"; entries: readonly PlanEntry[] }
  /**
   * Compteurs de tokens, en **deux variantes discriminées par `kind`**.
   *
   * ⚠️ Pourquoi deux variantes plutôt qu'un objet à champs optionnels : les
   * deux sémantiques viennent de **deux producteurs distincts** et ne se
   * recoupent pas. `usage_update` ne parle que de la fenêtre de contexte
   * (combien de tokens sont *réservés*), le `PromptResponse` final ne parle que
   * de ce que le tour a *coûté*. Un `{ input?, output?, context? }` à champs
   * tous optionnels rend `{}` légitime : le réducteur de l'adaptateur devrait
   * alors deviner de quel côté on parle — exactement le piège documenté au
   * §4.0 pour `LLMEvent`, où un objet mal formé produit « The provider
   * response ended unexpectedly. », indiscernable d'une troncature.
   *
   * - `context` : notification `usage_update`, en cours de tour (monotonique).
   * - `turn` : le `PromptResponse` final du tour. `reasoning` / `cacheRead` /
   *   `cacheWrite` correspondent à `thoughtTokens` / `cachedReadTokens` /
   *   `cachedWriteTokens` de l'`Usage` ACP (§4.1) et alimentent directement la
   *   classe `Usage` d'OpenCode en P1, **instances de `Usage` comprises**.
   */
  | { type: "usage"; kind: "context"; used: number }
  | {
      type: "usage"
      kind: "turn"
      input?: number
      output?: number
      total?: number
      /** Tokens de raisonnement (`thoughtTokens` côté ACP). */
      reasoning?: number
      cacheRead?: number
      cacheWrite?: number
    }
  /**
   * Décision de permission prise pendant le tour.
   *
   * ⚠️ Sans cet événement la politique est **invisible** dans le flux : ni P2
   * ni P4 ne peuvent afficher « l'agent voulait écrire, on a refusé », alors
   * que c'est précisément ce que l'utilisateur doit voir en mode cerveau brut
   * (§7.4). `selectedOptionId` est absent quand le tour a été annulé.
   */
  | {
      type: "permission"
      request: PermissionRequest
      decision: PermissionDecision
      selectedOptionId?: string
    }
  /**
   * Fin de tour. Toujours le dernier événement d'un `prompt()`.
   *
   * ⚠️ Émis **aussi** après un `error` : un flux qui se termine sans `done`
   * fait échouer la chaîne `@opencode/ai` avec « The provider response ended
   * unexpectedly. », indiscernable d'une troncature (§4.0).
   */
  | { type: "done"; stopReason: AcpStopReason }
  /** Erreur récupérée pendant le tour ; le flux se termine juste après. */
  | { type: "error"; message: string }

/** Une entrée du plan d'exécution de l'agent. */
export interface PlanEntry {
  content: string
  priority: "high" | "medium" | "low"
  status: "pending" | "in_progress" | "completed"
}

// ─────────────────────────────────────────────────────────────────────────────
// Requête normalisée — indépendante d'OpenCode comme de l'API OpenAI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un message du transcript, rendu sous une forme agnostique.
 *
 * ⚠️ La variante `tool` porte un **`id` explicite** alors qu'ACP n'en
 * transporte aucun. Raison : cet id est **synthétisé par l'émetteur** (au tour
 * N, quand on émet le `tool-call`) et **renvoyé fidèlement** par le
 * consommateur au tour N+1 — OpenCode via `toolCallId`, l'API OpenAI via
 * `tool_call_id`. Le round-trip est donc stable dans les deux cas, sans table de
 * correspondance à maintenir.
 *
 * L'alternative — laisser l'id de côté et le reconstruire au rendu — rendait
 * deux appels du même outil dans la même conversation **indiscernables**, alors
 * que le §4 exige d'émettre `tool-result{ id, name, result }` : sans id stable,
 * le réducteur ne sait pas quel résultat refermer.
 *
 * **Contrainte pour les adaptateurs** : propager cet `id` **verbatim**, et
 * garantir son **unicité par requête** — deux `tool-call` d'un même tour ne
 * doivent jamais porter le même id.
 */
export type NormalizedMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool"; id: string; name: string; output: string }

/** Un outil exposé à l'agent, avec son vrai nom et son vrai schéma JSON. */
export interface NormalizedTool {
  name: string
  description: string
  schema: unknown
}

/**
 * La requête telle que la comprend le cœur, quel que soit l'appelant.
 * L'adaptateur OpenCode convertit `LLMRequest` → ici ; l'adaptateur HTTP
 * convertit le corps OpenAI → ici. La logique métier n'existe qu'une fois.
 */
export interface NormalizedRequest {
  /** Instructions système, déjà résolues (AGENTS.md, skills, contrat de sortie). */
  system: readonly string[]
  /** Catalogue d'outils à proposer à l'agent — cœur du mécanisme §7.3. */
  tools: readonly NormalizedTool[]
  /** Transcript complet, résultats d'outils inclus. */
  messages: readonly NormalizedMessage[]
  maxOutputTokens?: number
  /** Niveau d'effort demandé (`thought_level` côté ACP). */
  thinkingLevel?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventaire — §5
// ─────────────────────────────────────────────────────────────────────────────

/** Un modèle sélectionnable côté agent. */
export interface AcpModel {
  /** Identifiant brut renvoyé par l'agent (celui qu'on renvoie à `set_config_option`). */
  id: string
  /** Libellé lisible. */
  name: string
  description?: string
}

/** Un mode d'opération de l'agent (`#agent`, `#plan`…). */
export interface AcpMode {
  /** Identifiant raccourci, pratique pour l'affichage (`#agent`). */
  id: string
  /** Identifiant complet renvoyé par l'agent (souvent une URL). */
  rawId: string
  name: string
  description?: string
}

/**
 * Une option de configuration de session, normalisée.
 * `type` est conservé parce que `session/set_config_option` exige un payload
 * différent pour un booléen (`{ type: "boolean", value: bool }`) et un selecteur.
 */
export interface AcpOption {
  id: string
  name: string
  /** Catégorie sémantique ACP : `model`, `thought_level`, `mode`, `permissions`… */
  category: string
  type: "select" | "boolean"
  /** Valeur courante, toujours rendue sous forme de chaîne. */
  currentValue: string
  /** Valeurs acceptées, dans l'ordre d'affichage côté agent. */
  values: readonly string[]
  description?: string
}

/** L'inventaire complet déduit des `configOptions` d'une session. */
export interface Inventory {
  /** Catégorie `model` → un modèle OpenCode par valeur (§5). */
  models: readonly AcpModel[]
  /** Catégorie `thought_level` → variants du modèle. */
  thoughtLevels: readonly string[]
  /** Catégorie `mode` → agents OpenCode (§5). */
  modes: readonly AcpMode[]
  /** Catégorie `permissions` → épinglée à `off` en mode « cerveau brut » (§7.4). */
  permissions?: AcpOption
  /** Toutes les options, brutes mais normalisées, pour l'inspection. */
  options: readonly AcpOption[]
  currentModel?: string
  currentThoughtLevel?: string
  currentMode?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Permissions — §7.4 / §9
// ─────────────────────────────────────────────────────────────────────────────

/** Un choix proposé par l'agent lors d'une `session/request_permission`. */
export interface PermissionOption {
  id: string
  name: string
  /** `allow_once`, `allow_always`, `reject_once`, `reject_always`. */
  kind: string
}

/** Ce que l'agent veut faire, résumé. */
export interface PermissionRequest {
  sessionId: string
  toolCallId: string
  title: string
  kind: string
  options: readonly PermissionOption[]
}

/** La décision rendue à l'agent. */
export type PermissionDecision =
  /** Choisir une option proposée (par défaut la première compatible). */
  | { action: "select"; optionId: string }
  /** Refuser ; l'agent reçoit l'option `reject_*` correspondante. */
  | { action: "reject"; optionId?: string }
  /** Annulation du tour côté agent (`outcome: "cancelled"`). */
  | { action: "cancel" }

/**
 * Fonction de décision pour `session/request_permission`.
 *
 * Le package provider n'a pas accès aux permissions d'OpenCode (`Settings` est
 * du JSON plat, cf. §3.2) : c'est donc une fonction, alimentée par la config du
 * provider. **Défaut : refuser** — mode « cerveau brut » (§7.4).
 */
export type AcpPermissionPolicy = (
  request: PermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>

/** Politique par défaut : on refuse systématiquement tout ce que l'agent propose. */
export const denyAllPermissions: AcpPermissionPolicy = (request) => {
  const option = request.options.find((o) => o.kind.startsWith("reject_"))
  return option ? { action: "select", optionId: option.id } : { action: "cancel" }
}

/** Politique « outils natifs autorisés » : on accepte la première option `allow_*`. */
export const allowAllPermissions: AcpPermissionPolicy = (request) => {
  const option = request.options.find((o) => o.kind.startsWith("allow_"))
  return option ? { action: "select", optionId: option.id } : { action: "cancel" }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent & session
// ─────────────────────────────────────────────────────────────────────────────

/** Identité de l'agent, telle que rapportée par `initialize`. */
export interface AcpAgentInfo {
  name: string
  version: string
}

/** Un agent ACP opérationnel, avec son process vivant. */
export interface AcpAgent {
  readonly info: AcpAgentInfo
  /** Version de protocole négociée lors d'`initialize`. */
  readonly protocolVersion: number
  /** Inventaire complet (modèles, efforts, modes, permissions). */
  inventory(): Promise<Inventory>
  /** Raccourci : uniquement les modèles de la catégorie `model`. */
  models(): Promise<readonly AcpModel[]>
  /** Ouvre une session ACP neuve. */
  open(options?: { cwd?: string; signal?: AbortSignal }): Promise<AcpSession>
  /** Ferme la connexion puis tue le sous-processus. */
  close(): Promise<void>
}

/** Une session ACP ouverte, prête à recevoir des tours de prompt. */
export interface AcpSession {
  readonly sessionId: string
  /** Inventaire tel que renvoyé par `session/new` (et rafraîchi par les updates). */
  inventory(): Inventory
  /** Raccourci : change la valeur courante de l'option de catégorie `model`. */
  setModel(modelId: string): Promise<void>
  /** Change une option quelconque (`reasoning_effort`, `allow_all`…). */
  setOption(configId: string, value: string): Promise<void>
  /**
   * Le point que les trois adaptateurs ont en commun.
   *
   * ⚠️ `signal` est **facultatif et piégeux** : ne pas le fournir ne doit pas
   * être plus dangereux que de le fournir. L'implémentation annule donc le
   * tour automatiquement quand le consommateur abandonne l'itération
   * (`break`, `return`, `throw`) — avec ou sans signal.
   */
  prompt(
    request: NormalizedRequest,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<AcpEvent>
  /** Libère le routage des updates et, si possible, ferme la session côté agent. */
  close(): Promise<void>
}
