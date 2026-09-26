import type { RawAgent } from "./publish.js"

export const CONNECT_INTEGRATION_ID = "acp"

export const CONNECT_INTEGRATION_NAME = "ACP"
export const CONNECT_METHOD_LABEL = "Add an ACP server"

/** Splits a command line, keeping a quoted argument as one word. */
export const splitCommand = (line: string): string[] =>
  (line.match(/"[^"]*"|\S+/g) ?? []).map((word) =>
    word.startsWith('"') ? word.slice(1, -1) : word,
  )

/**
 * What `/connect` submits: a name, so that the provider reads as `acp-<name>`
 * rather than a bare `acp`, and the command that starts the agent in ACP mode.
 */
export interface ConnectAgent {
  readonly name: string
  readonly command: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Reads the two form answers out of a `/connect` credential.
 *
 * A `key` method carrying a `form` stores the answers in `configuration`, the
 * `key` itself being opaque, so the answers are the only thing worth reading.
 * Anything else - an OAuth credential, an env-backed one, a form left half
 * filled - yields `undefined` rather than a half-built agent.
 */
export const parseConnectCredential = (value: unknown): ConnectAgent | undefined => {
  if (!isRecord(value) || value["type"] !== "key") return undefined
  const configuration = value["configuration"]
  if (!isRecord(configuration)) return undefined

  const name = configuration["name"]
  const command = configuration["command"]
  if (typeof name !== "string" || typeof command !== "string") return undefined
  if (name.trim() === "" || splitCommand(command).length === 0) return undefined

  return { name: name.trim(), command }
}

/**
 * The `/connect` form: a name and a command, nothing else.
 *
 * Note: untyped on purpose. `Form.Fields` lives in `@opencode/schema`, which
 * `core/` may not import, so the shape is checked where the form is handed to
 * the host - in the adapter - which is the only place that can know it.
 */
export const CONNECT_FORM_FIELDS = [
  {
    type: "string",
    key: "name",
    title: "Name",
    description: "The provider will be acp-<name>.",
    placeholder: "copilot",
    required: true,
  },
  {
    type: "string",
    key: "command",
    title: "Command",
    description: "The command that starts the agent in ACP mode.",
    placeholder: "copilot --acp",
    required: true,
  },
]

/** Turns one `/connect` answer into the agent the rest of the code speaks of. */
export const connectAgentToRawAgent = (agent: ConnectAgent): RawAgent => {
  const words = splitCommand(agent.command)
  const [executable = "", ...args] = words
  return {
    id: agent.name,
    providerSlug: agent.name,
    command: executable,
    args,
    cwd: undefined,
    env: undefined,
    allowedTools: undefined,
    session: undefined,
    limits: undefined,
  }
}

/**
 * Merges both sources of agents, `/connect` first so that a name declared in the
 * UI is the one the user last touched. Ids collide often - `copilot` in the
 * config file and `copilot` in `/connect` is the same agent - and keeping both
 * would register two providers for one command.
 */
export const mergeAgents = (
  fromConnect: readonly RawAgent[],
  fromConfig: readonly RawAgent[],
): RawAgent[] => {
  const merged = [...fromConnect]
  const taken = new Set(fromConnect.map((agent) => agent.id))
  for (const agent of fromConfig) {
    if (taken.has(agent.id)) continue
    taken.add(agent.id)
    merged.push(agent)
  }
  return merged
}

/**
 * What one agent **is**, as one comparable string: its label, the provider id
 * it asks for, and the command line it will run.
 *
 * Note: `id` alone is not an identity. The same name with another command is
 * another agent - the previous process would be serving a command the user has
 * just replaced.
 */
const agentKey = (agent: RawAgent): string =>
  [agent.id, agent.providerSlug, agent.command, ...(agent.args ?? [])].join("\u0000")

/**
 * What the catalogue depends on, as one comparable string.
 *
 * Note: the list is **sorted**, so reordering the configuration is not a change.
 * Otherwise every edit of `opencode.json` would tear down and rebuild every
 * agent process - a minute of rediscovery, for a diff that moved two lines.
 */
export const agentsFingerprint = (agents: readonly RawAgent[]): string =>
  agents.map(agentKey).sort().join("\u0001")

/** What a resynchronisation has to do to reach one list from another. */
export interface AgentDiff {
  /** In the target list, and not in the current one. */
  readonly added: readonly RawAgent[]
  /** In the current list, and not in the target one. */
  readonly removed: readonly RawAgent[]
}

/**
 * The difference between two agent lists, by what each agent **is** and not by
 * id alone.
 *
 * Note: an agent whose command changed is in **both** halves. Calling it
 * unchanged would leave the previous process serving the previous command until
 * the next restart, under the name the user has just edited.
 *
 * Note: no `replaced` half. The two providers would be the same id, and
 * `editor.add` replaces silently - the honest sequence is to tear the old one
 * down first, then build the new one under the freed id.
 */
export const diffAgents = (from: readonly RawAgent[], to: readonly RawAgent[]): AgentDiff => {
  const wanted = new Set(to.map(agentKey))
  return {
    added: to.filter((agent) => !from.some((known) => agentKey(known) === agentKey(agent))),
    removed: from.filter((agent) => !wanted.has(agentKey(agent))),
  }
}
