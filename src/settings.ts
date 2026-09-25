/**
 * Settings du provider — PLAN.md §3.2.
 *
 * ⚠️ Ces données sont **plates et sérialisables** : OpenCode les lit dans
 * `providers.<id>.settings` (ou `models.<id>.settings`) et les passe telles
 * quelles à `model(modelID, settings)`. Il n'y a donc **aucun callback**
 * possible ici — c'est la contrainte qui a écarté l'hôte d'`effect` comme
 * source de configuration (§3.2), et la raison pour laquelle la politique de
 * permissions est une *valeur* (`allowedTools`) et non une fonction.
 *
 * La validation est séparée de l'utilisation : `parseSettings` est une fonction
 * **pure** (aucun process, aucun effet), testable seule, qui renvoie soit les
 * settings normalisées, soit un message d'erreur en français. C'est
 * `src/index.ts` qui décide du sort : un `ProviderConfigurationError`, ce qui est
 * exactement le contrat d'`@opencode/ai` pour une erreur de configuration
 * survenue **avant** toute requête.
 */

/** Redirection du stderr de l'agent ACP. */
export type StderrMode = "inherit" | "ignore" | "pipe"

/** Stratégie de session ACP par requête (PLAN.md §10). */
export type SessionMode = "reuse" | "fresh"

/**
 * Settings validées et normalisées.
 *
 * ⚠️ C'est un alias de type et **pas** une interface : un alias de type sur un
 * littéral objet reçoit un *index signature* implicite, ce qui le rend
 * assignable à `ProviderPackage.Settings` (`Readonly<Record<string, unknown>>`).
 * Une interface n'en aurait pas, et le contrat du §3.1 ne serait pas
 * vérifiable — donc pas respecté.
 *
 * ⚠️ Les champs `undefined` sont **conservés** plutôt que remplacés par une
 * valeur par défaut : seule la clé d'identité du process (§ `agentKey`) et la
 * politique de permissions ont besoin d'un défaut, et les deux sont calculés au
 * point d'usage. Dupliquer les défauts ici les ferait diverger.
 */
export type AcpProviderSettings = Readonly<{
  /** La commande à lancer, p. ex. `"copilot"` ou `"npx"`. */
  command: string
  /** Arguments de la commande, p. ex. `["--acp"]`. */
  args: readonly string[] | undefined
  /**
   * Répertoire de travail de l'agent.
   *
   * ⚠️ C'est le **seul** moyen d'en savoir un (§9bis) : `LLMRequest` ne porte
   * ni `sessionID` ni `cwd`, et le registre de providers est global alors que le
   * répertoire d'OpenCode est par projet.
   */
  cwd: string | undefined
  /** Variables d'environnement **ajoutées** à celles du serveur OpenCode. */
  env: Readonly<Record<string, string>> | undefined
  /** Que faire du stderr de l'agent (défaut : `"pipe"`, voir `parseSettings`). */
  stderr: StderrMode | undefined
  /**
   * `session: "fresh"` (défaut) ouvre une session ACP par requête et renvoie
   * l'historique complet ; `"reuse"` est une heuristique de cache par préfixe de
   * conversation, décrite au §10 mais **non implémentée** en P1.
   */
  session: SessionMode | undefined
  /**
   * Texte ajouté **après** le système d'OpenCode (AGENTS.md, skills…).
   *
   * C'est ici que viendra le contrat de sortie JSON du mécanisme §7.3 en P2b :
   * il doit être **après** le système, pour que l'agent ne puisse pas le traiter
   * comme un simple contexte à reformuler.
   */
  systemSuffix: string | undefined
  /**
   * Outils **natifs** de l'agent ACP qu'on l'autorise à utiliser.
   *
   * - absent ou `[]` : mode « cerveau brut » — on refuse aussi les permissions
   *   demandées, l'agent ne peut donc rien faire de destructif (§7.4) ;
   * - `["*"]` : on accepte tout ce que l'agent propose ;
   * - sinon : liste blanche de noms d'outils, **non applicable en P1** — la
   *   demande de permission ACP ne porte pas toujours le nom de l'outil, donc une
   *   liste blanche dégrade en « tout refuser » (voir `policyOf` dans
   *   `adapters/opencode-transport.ts`).
   */
  allowedTools: readonly string[] | undefined
  /**
   * Niveau d'effort demandé — la valeur d'un `variant` de `Model.Info` (§5.2).
   *
   * ⚠️ Elle ne vient **pas** de l'utilisateur au clavier mais d'un `variant`
   * publié par le plugin : `{ settings: { effort: "high" } }`, fusionné par
   * OpenCode dans les settings du provider. L'adaptateur la traduit en
   * `set_config_option("reasoning_effort", …)` **avant** le prompt, et **après**
   * le modèle : l'agent change la liste des niveaux qu'il accepte en changeant
   * de modèle (`none` n'existe pas pour `claude-sonnet-5` sur `copilot --acp`).
   *
   * Absent : aucun `set_config_option` n'est envoyé, et l'agent applique la
   * valeur qu'il annonce lui-même dans `session/new`.
   */
  effort: string | undefined
}>

/**
 * Les settings **tels qu'OpenCode les livre** : JSON brut, non validé.
 *
 * ⚠️ Tout est facultatif, y compris `command` : c'est `parseSettings` qui décide
 * si c'est acceptable, et son message d'erreur est le seul guide possible pour
 * l'utilisateur. Typer l'entrée avec `command: string` serait un mensonge qui
 * déplacerait l'erreur de la validation vers un `TypeError` en amont.
 */
export type RawProviderSettings = Partial<AcpProviderSettings> & Readonly<Record<string, unknown>>

/** Résultat de `parseSettings` : jamais une exception, toujours un diagnostic. */
export type SettingsResult =
  | { readonly ok: true; readonly value: AcpProviderSettings }
  | { readonly ok: false; readonly message: string }

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

/** Message d'erreur homogène, avec le chemin du champ fautif. */
const invalid = (path: string, expected: string): { readonly ok: false; readonly message: string } => ({
  ok: false,
  message: `settings.${path} ${expected}`,
})

const optionalString = (
  input: Record<string, unknown>,
  key: string,
): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly message: string } => {
  const raw = input[key]
  if (raw === undefined) return { ok: true, value: undefined }
  if (typeof raw !== "string") return invalid(key, "doit être une chaîne")
  return { ok: true, value: raw }
}

const optionalStringArray = (
  input: Record<string, unknown>,
  key: string,
): { readonly ok: true; readonly value: readonly string[] | undefined } | { readonly ok: false; readonly message: string } => {
  const raw = input[key]
  if (raw === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(raw)) return invalid(key, "doit être un tableau de chaînes")
  // On **recopie** plutôt que de rendre le tableau reçu : `Array.isArray` ne
  // prouve rien sur le type de ses éléments, et une copie construite ici est
  // nécessairement un `string[]` — sans avoir à mentir sur le typage.
  const values: string[] = []
  for (const item of raw) {
    if (typeof item !== "string") return invalid(key, "doit être un tableau de chaînes")
    values.push(item)
  }
  return { ok: true, value: values }
}

const optionalStringRecord = (
  input: Record<string, unknown>,
  key: string,
): { readonly ok: true; readonly value: Record<string, string> | undefined } | { readonly ok: false; readonly message: string } => {
  const raw = input[key]
  if (raw === undefined) return { ok: true, value: undefined }
  if (!isRecord(raw)) return invalid(key, "doit être un objet de chaînes")
  const entries: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string") return invalid(`${key}.${name}`, "doit être une chaîne")
    entries[name] = value
  }
  return { ok: true, value: entries }
}

const optionalEnum = <T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): { readonly ok: true; readonly value: T | undefined } | { readonly ok: false; readonly message: string } => {
  const raw = input[key]
  if (raw === undefined) return { ok: true, value: undefined }
  if (typeof raw !== "string") return invalid(key, `doit valoir ${allowed.map((v) => `"${v}"`).join(", ")}`)
  // On relit la valeur dans la liste plutôt que de l'admettre telle quelle :
  // c'est la liste qui fait autorité, donc le type est correct par construction.
  const found = allowed.find((value) => value === raw)
  if (found === undefined) {
    return invalid(key, `doit valoir ${allowed.map((v) => `"${v}"`).join(", ")}`)
  }
  return { ok: true, value: found }
}

/**
 * Valide les settings brutes d'un provider.
 *
 * ⚠️ Les clés **inconnues sont ignorées**, pas rejetées. `ProviderPackage.Settings`
 * réserve déjà `baseURL`/`headers`/`body` à d'autres usages, et OpenCode peut
 * ajouter les siennes ; faire tomber le provider entier parce qu'une clé
 * supplémentaire traîne serait un mode de panne bien pire qu'une clé ignorée.
 * En revanche un champ connu **mal typé** est une erreur explicite : c'est
 * presque toujours une faute de frappe (`"argz"`, `"cwd": 12`) qu'il vaut mieux
 * dire que masquer.
 */
export const parseSettings = (input: unknown): SettingsResult => {
  if (!isRecord(input)) {
    return {
      ok: false,
      message:
        "settings doit être un objet JSON, par exemple { \"command\": \"copilot\", \"args\": [\"--acp\"] }",
    }
  }

  const command = optionalString(input, "command")
  if (!command.ok) return command
  if (command.value === undefined || command.value.trim() === "") {
    return invalid("command", 'est obligatoire et ne peut pas être vide (ex. "copilot")')
  }

  const args = optionalStringArray(input, "args")
  if (!args.ok) return args
  const cwd = optionalString(input, "cwd")
  if (!cwd.ok) return cwd
  if (cwd.value !== undefined && cwd.value.trim() === "") {
    return invalid("cwd", "ne peut pas être une chaîne vide — omets le champ pour ne pas fixer de répertoire")
  }
  const env = optionalStringRecord(input, "env")
  if (!env.ok) return env
  const stderr = optionalEnum(input, "stderr", ["inherit", "ignore", "pipe"] as const)
  if (!stderr.ok) return stderr
  const session = optionalEnum(input, "session", ["reuse", "fresh"] as const)
  if (!session.ok) return session
  const systemSuffix = optionalString(input, "systemSuffix")
  if (!systemSuffix.ok) return systemSuffix
  const allowedTools = optionalStringArray(input, "allowedTools")
  if (!allowedTools.ok) return allowedTools
  const effort = optionalString(input, "effort")
  if (!effort.ok) return effort
  if (effort.value !== undefined && effort.value.trim() === "") {
    return invalid("effort", "ne peut pas être une chaîne vide — omets le champ pour ne pas forcer de niveau")
  }

  return {
    ok: true,
    value: {
      command: command.value,
      args: args.value,
      cwd: cwd.value,
      env: env.value,
      stderr: stderr.value,
      session: session.value,
      systemSuffix: systemSuffix.value,
      allowedTools: allowedTools.value,
      effort: effort.value,
    },
  }
}

/**
 * Identité du **process** agent, pour le cache module de `opencode-transport`.
 *
 * ⚠️ La clé ne contient pas que `command`/`args`/`cwd`/`env` : `stderr` et
 * `allowedTools` changeient le **comportement du client ACP** (redirection des
 * logs, politique de permissions enregistrée dans le handler
 * `session/request_permission`). Les omettre partagerait un agent entre deux
 * providers configurés différemment — et le second hériterait de la politique du
 * premier, ce qui en mode « cerveau brut » (§7.4) reviendrait à **autoriser des
 * écritures que l'utilisateur a interdites**.
 *
 * À l'inverse `session` et `systemSuffix` n'y sont pas : ils ne touchent pas le
 * process, seulement la requête (`AcpPrepared`). `effort` non plus, pour la même
 * raison : c'est une valeur de `variant` appliquée par `set_config_option` sur la
 * session du tour, pas une propriété de l'agent.
 */
export const agentKey = (settings: AcpProviderSettings): string =>
  JSON.stringify([
    settings.command,
    settings.args ?? [],
    settings.cwd ?? null,
    settings.env ?? null,
    settings.stderr ?? null,
    settings.allowedTools ?? null,
  ])

/** `true` si la liste blanche d'outils vaut « tout est permis ». */
export const allowsEveryTool = (settings: AcpProviderSettings): boolean =>
  settings.allowedTools?.includes("*") === true

/** Étiquette lisible d'un agent, présente dans **tous** les messages d'erreur. */
export const agentLabel = (settings: AcpProviderSettings): string =>
  [settings.command, ...(settings.args ?? [])].join(" ").trim()
