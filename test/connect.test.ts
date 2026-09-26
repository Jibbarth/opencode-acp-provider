import { describe, expect, test } from "bun:test"

import {
  CONNECT_FORM_FIELDS,
  agentsFingerprint,
  connectAgentToRawAgent,
  diffAgents,
  mergeAgents,
  parseConnectCredential,
  splitCommand,
} from "../src/core/connect.js"
import { parsePluginConfig } from "../src/core/publish.js"
import type { RawAgent } from "../src/core/publish.js"

const named = (id: string): RawAgent => ({
  id,
  providerSlug: id,
  command: id,
  args: [],
  cwd: undefined,
  env: undefined,
  allowedTools: undefined,
  session: undefined,
  limits: undefined,
})

/** The same agent, running another command. */
const running = (id: string, command: string, ...args: readonly string[]): RawAgent => ({
  ...named(id),
  command,
  args,
})

const credential = (configuration: unknown) => ({
  type: "key",
  key: "opaque",
  configuration,
})

describe("/connect: the form answers", () => {
  test("a name and a command become an agent, name becoming the provider slug", () => {
    const agent = connectAgentToRawAgent(parseConnectCredential(credential({ name: "copilot", command: "copilot --acp" }))!)
    expect(agent).toEqual({
      id: "copilot",
      providerSlug: "copilot",
      command: "copilot",
      args: ["--acp"],
      cwd: undefined,
      env: undefined,
      allowedTools: undefined,
      session: undefined,
      limits: undefined,
    })
  })

  test("the answers are in `configuration`, never in the opaque key", () => {
    // A `key` method with a form: `key` is not what the user typed, so reading
    // it would give a credential that looks valid and starts nothing.
    expect(parseConnectCredential(credential({ name: "copilot", command: "copilot --acp" }))).toEqual({
      name: "copilot",
      command: "copilot --acp",
    })
  })

  test("anything that is not a filled key credential is refused rather than half-built", () => {
    const refused = [
      undefined,
      null,
      "copilot --acp",
      { type: "oauth", methodID: "x" },
      { type: "key", key: "opaque" },
      credential({}),
      credential({ name: "copilot" }),
      credential({ command: "copilot --acp" }),
      credential({ name: "  ", command: "copilot --acp" }),
      credential({ name: 1, command: 2 }),
      credential({ name: ["copilot"], command: "copilot --acp" }),
    ]
    for (const value of refused) expect({ value, parsed: parseConnectCredential(value) }).toEqual({
      value,
      parsed: undefined,
    })
  })

  test("a command with no executable word is refused", () => {
    expect(parseConnectCredential(credential({ name: "copilot", command: "   " }))).toBeUndefined()
  })

  test("a quoted argument stays one word, quotes and all", () => {
    expect(splitCommand('npx --yes "my agent" --acp')).toEqual(["npx", "--yes", "my agent", "--acp"])
  })
})

describe("/connect and the config file", () => {
  test("`/connect` comes first, and one id yields one provider", () => {
    const merged = mergeAgents([named("copilot")], [named("copilot"), named("codex")])
    expect(merged.map((agent) => agent.id)).toEqual(["copilot", "codex"])
  })

  test("a merged list is a configuration the publisher accepts", () => {
    const merged = mergeAgents([named("copilot")], [named("codex")])
    const parsed = parsePluginConfig({ agents: merged })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.agents.map((agent) => agent.providerSlug)).toEqual(["copilot", "codex"])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The form, and the answers it is meant to produce
// ─────────────────────────────────────────────────────────────────────────────

describe("the /connect form", () => {
  test("it asks for exactly the answers the parser reads", () => {
    // The form is the only place the user learns what a connection carries, and
    // the parser is the only place those answers are read. A field nothing reads
    // is a question the user answers for nothing; an answer no field asks for is
    // one the user cannot give.
    const keys = CONNECT_FORM_FIELDS.map((field) => field.key)
    expect(keys).toEqual(["name", "command"])
    const answers = { name: "copilot", command: "copilot --acp" }
    expect(parseConnectCredential(credential(answers))).toEqual({ name: "copilot", command: "copilot --acp" })
    for (const key of keys) {
      const partial: Record<string, string> = { ...answers }
      delete partial[key]
      expect({ key, parsed: parseConnectCredential(credential(partial)) }).toEqual({ key, parsed: undefined })
    }
  })

  test("what it submits is a command line the rest of the plugin can run", () => {
    // What the form produces must survive the whole chain: a credential, an
    // agent, then the command and arguments a discovery will spawn.
    const answers = { name: "copilot", command: 'npx --yes "my agent" --acp' }
    const agent = connectAgentToRawAgent(parseConnectCredential(credential(answers))!)
    expect(agent.command).toBe("npx")
    expect(agent.args).toEqual(["--yes", "my agent", "--acp"])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Resynchronisation: what a tick decides, and what it leaves alone
// ─────────────────────────────────────────────────────────────────────────────

describe("a poll of /connect", () => {
  test("a list that did not move leaves nothing to do", () => {
    const list = [named("copilot"), named("codex")]
    // Reordering is not a change: it must not tear down and rebuild every agent
    // process, for a diff that moved two lines.
    expect(agentsFingerprint(list)).toBe(agentsFingerprint([...list].reverse()))
    expect(diffAgents(list, [...list].reverse())).toEqual({ added: [], removed: [] })
  })

  test("a command that changed is a removal and an addition, never nothing", () => {
    // The trap this closes: the id is the same, so a diff on ids would find no
    // change and the agent would go on serving the command the user replaced.
    const before = [named("copilot")]
    const after = [running("copilot", "npx", "--yes", "my agent", "--acp")]
    expect(agentsFingerprint(after)).not.toBe(agentsFingerprint(before))
    const { added, removed } = diffAgents(before, after)
    expect(added.map((agent) => agent.command)).toEqual(["npx"])
    expect(removed.map((agent) => agent.command)).toEqual(["copilot"])
  })

  test("what the connection declares is what appears, and what disappears goes", () => {
    // The whole resynchronisation, as data: a tick reads the connection, and the
    // two halves of the diff are what it must do to the catalogue.
    const configured = [named("codex")]
    const connected = (connection: { name: string; command: string } | undefined): readonly RawAgent[] =>
      connection === undefined ? [] : [connectAgentToRawAgent(parseConnectCredential(credential(connection))!)]

    const first = mergeAgents(connected({ name: "copilot", command: "copilot --acp" }), configured)
    expect(first.map((agent) => agent.id)).toEqual(["copilot", "codex"])

    // The user edits the connection: `copilot` goes, and the connection now names
    // `codex` - which the config file also declared, and which therefore runs
    // another command, and is in both halves of the diff.
    const second = mergeAgents(connected({ name: "codex", command: "opencode acp" }), configured)
    const { added, removed } = diffAgents(first, second)
    expect(removed.map((agent) => agent.id)).toEqual(["copilot", "codex"])
    expect(added.map((agent) => agent.command)).toEqual(["opencode"])
    // And the wanted list holds the connection's `codex` only: one id, one
    // provider, the one the user last touched.
    expect(second.map((agent) => agent.command)).toEqual(["opencode"])
  })

  test("a connection the plugin cannot read is no agent at all", () => {
    // A half-filled form, or a credential of another type: the wanted list is
    // then the configured one, unchanged, and a tick has nothing to do.
    const configured = [named("codex")]
    const wanted = (value: unknown): readonly RawAgent[] => {
      const answers = parseConnectCredential(value)
      return mergeAgents(answers === undefined ? [] : [connectAgentToRawAgent(answers)], configured)
    }
    expect(wanted(undefined).map((agent) => agent.id)).toEqual(["codex"])
    expect(wanted({ type: "oauth", methodID: "x" }).map((agent) => agent.id)).toEqual(["codex"])
    expect(agentsFingerprint(wanted({ type: "key", key: "opaque" }))).toBe(agentsFingerprint(wanted(undefined)))
  })
})
