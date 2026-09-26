/**
 * Provider settings.
 *
 * Note: this data is **flat and serialisable**. OpenCode reads it in
 * `providers.<id>.settings` (or `models.<id>.settings`) and hands it as-is to
 * `model(modelID, settings)`. No **callback** is therefore possible here - which
 * is why the permission policy is a *value* (`allowedTools`) rather than a
 * function.
 *
 * Validation is kept apart from use: `parseSettings` is a **pure** function (no
 * process, no effect), testable on its own, returning either the normalised
 * settings or an error message in French. `src/index.ts` decides what to do with
 * it: a `ProviderConfigurationError`, which is exactly `@opencode/ai`'s contract
 * for a configuration error occurring **before** any request.
 */

import { PROVIDER_ID } from "./core/publish.js"

/** Redirection of the ACP agent's stderr. */
export type StderrMode = "inherit" | "ignore" | "pipe"

/** ACP session strategy per request. */
export type SessionMode = "reuse" | "fresh"

/**
 * Validated, normalised settings.
 *
 * Note: this is a type alias and **not** an interface. A type alias over an
 * object literal gets an implicit *index signature*, which makes it assignable
 * to `ProviderPackage.Settings` (`Readonly<Record<string, unknown>>`). An
 * interface would not, and the contract would then be unverifiable, and
 * therefore unmet.
 *
 * Note: `undefined` fields are **kept** rather than replaced by a default. Only
 * the process identity key (see `agentKey`) and the permission policy need a
 * default, and both are computed at the point of use. Duplicating the defaults
 * here would let them drift apart.
 */
export type AcpProviderSettings = Readonly<{
  /**
   * The id of the provider this model belongs to, e.g. `"acp-copilot"`.
   *
   * Note: published by the plugin, never typed by the user. It exists because
   * `model(modelID, settings)` is the **only** thing OpenCode calls on a
   * provider package: without a key carrying the provider's identity, every ACP
   * route would declare the same one and two agents would be indistinguishable
   * in `/model`. It is part of `agentKey` for the same reason it exists: two
   * providers must not share an agent process, hence its sessions.
   *
   * Absent: the default {@link PROVIDER_ID}.
   */
  provider: string | undefined
  /** The command to launch, e.g. `"copilot"` or `"npx"`. */
  command: string
  /** Command arguments, e.g. `["--acp"]`. */
  args: readonly string[] | undefined
  /**
   * The agent's working directory.
   *
   * Note: this is the **only** way to know one. `LLMRequest` carries neither
   * `sessionID` nor `cwd`, and the provider registry is global whereas
   * OpenCode's directory is per project.
   */
  cwd: string | undefined
  /** Environment variables **added** to those of the OpenCode server. */
  env: Readonly<Record<string, string>> | undefined
  /** What to do with the agent's stderr (default `"pipe"`, see `parseSettings`). */
  stderr: StderrMode | undefined
  /**
   * `"fresh"` (the default) opens one ACP session per request and sends the
   * whole history; `"reuse"` keeps one session per conversation and sends only
   * the delta, a heuristic that can be wrong and is therefore verified message
   * by message before being trusted (see `core/session-key.ts`).
   */
  session: SessionMode | undefined
  /**
   * Text added **after** OpenCode's system prompt (AGENTS.md, skills...).
   *
   * The JSON output contract is rendered here, and it must come **after** the
   * system prompt so the agent cannot treat it as mere context to rephrase.
   */
  systemSuffix: string | undefined
  /**
   * The agent's **native** tools it is allowed to use.
   *
   * - absent or `[]`: everything the agent asks for is refused, so it can do
   *   nothing destructive;
   * - `["*"]`: everything the agent proposes is accepted;
   * - otherwise: a whitelist of tool names, which currently **degrades to
   *   "refuse everything"** - an ACP permission request does not always carry the
   *   tool name, so a whitelist cannot be honoured (see `policyOf` in
   *   `adapters/opencode-transport.ts`).
   */
  allowedTools: readonly string[] | undefined
  /**
   * The requested effort level - the value of a `Model.Info` variant.
   *
   * Note: it does **not** come from the user typing, but from a variant published
   * by the plugin: `{ settings: { effort: "high" } }`, merged by OpenCode into the
   * provider settings. The adapter turns it into
   * `set_config_option("reasoning_effort", ...)` **before** the prompt, and
   * **after** the model: the agent changes the list of levels it accepts when the
   * model changes (`none` does not exist for `claude-sonnet-5` on
   * `copilot --acp`).
   *
   * Absent: no `set_config_option` is sent, and the agent applies the value it
   * announces itself in `session/new`.
   */
  effort: string | undefined
}>

/**
 * The settings **as OpenCode hands them over**: raw, unvalidated JSON.
 *
 * Note: everything is optional, `command` included. `parseSettings` decides
 * whether that is acceptable, and its error message is the only possible guide
 * for the user. Typing the input with `command: string` would be a lie that
 * moves the error from validation to a `TypeError` further upstream.
 */
export type RawProviderSettings = Partial<AcpProviderSettings> & Readonly<Record<string, unknown>>

/** Result of `parseSettings`: never an exception, always a diagnostic. */
export type SettingsResult =
  | { readonly ok: true; readonly value: AcpProviderSettings }
  | { readonly ok: false; readonly message: string }

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

/** Uniform error message, carrying the path of the offending field. */
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
  // **Copy** rather than returning the received array: `Array.isArray` proves
  // nothing about its element type, and a copy built here is necessarily a
  // `string[]`, with no need to lie about the typing.
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
  // The value is looked up in the list rather than admitted as-is: the list is
  // authoritative, so the type is correct by construction.
  const found = allowed.find((value) => value === raw)
  if (found === undefined) {
    return invalid(key, `doit valoir ${allowed.map((v) => `"${v}"`).join(", ")}`)
  }
  return { ok: true, value: found }
}

/**
 * Validates a provider's raw settings.
 *
 * Note: **unknown keys are ignored**, not rejected. `ProviderPackage.Settings`
 * already reserves `baseURL`/`headers`/`body` for other uses, and OpenCode may
 * add its own; bringing the whole provider down because an extra key is lying
 * around is a far worse failure mode than an ignored key. A known field with a
 * **wrong type**, on the other hand, is an explicit error: it is almost always a
 * typo (`"argz"`, `"cwd": 12`) that is better reported than hidden.
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

  const provider = optionalString(input, "provider")
  if (!provider.ok) return provider
  if (provider.value !== undefined && provider.value.trim() === "") {
    return invalid("provider", "ne peut pas être une chaîne vide — omets le champ pour le provider par défaut")
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
      provider: provider.value,
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
 * Identity of the agent **process**, for `opencode-transport`'s module cache.
 *
 * Note: the key holds more than `command`/`args`/`cwd`/`env`. `stderr` and
 * `allowedTools` change the **behaviour of the ACP client** (log redirection,
 * permission policy registered in the `session/request_permission` handler).
 * Leaving them out would share one agent between two differently configured
 * providers, and the second would inherit the first's policy - which, in the
 * default deny-all mode, means **allowing writes the user forbade**.
 *
 * Conversely `session` and `systemSuffix` are not in it: they do not touch the
 * process, only the request (`AcpPrepared`). Neither is `effort`, for the same
 * reason: it is a variant value applied by `set_config_option` on the turn's
 * session, not a property of the agent.
 *
 * Note: the provider id **is** in it, and that is the point of one provider per
 * agent. Two providers configured with the same command would otherwise share
 * one process - hence one authentication session, one set of credentials, and
 * one pool of ACP sessions: the second provider's first turn could be handed a
 * session the first one had filled, and the second would inherit whatever
 * authentication state the first had reached. Separate providers are exactly
 * what makes that impossible, and the cost is one extra process per agent.
 */
export const agentKey = (settings: AcpProviderSettings): string =>
  JSON.stringify([
    settings.provider ?? PROVIDER_ID,
    settings.command,
    settings.args ?? [],
    settings.cwd ?? null,
    settings.env ?? null,
    settings.stderr ?? null,
    settings.allowedTools ?? null,
  ])

/** `true` if the tool whitelist means "everything is allowed". */
export const allowsEveryTool = (settings: AcpProviderSettings): boolean =>
  settings.allowedTools?.includes("*") === true

/** A readable agent label, present in **every** error message. */
export const agentLabel = (settings: AcpProviderSettings): string =>
  [settings.command, ...(settings.args ?? [])].join(" ").trim()
