/**
 * End-to-end tests of the ACP layer.
 *
 * `test/fake-acp.ts` is launched as a **real subprocess**: it is the only way to
 * validate the whole chain (spawn -> ndJsonStream -> initialize -> session/new
 * -> session/prompt -> translation into `AcpEvent`) exactly as the plugin will
 * against `copilot --acp`.
 *
 * The fake is configurable through environment variables (see the header of
 * `fake-acp.ts`): every case that is hard to reach with a "polite" agent -
 * `tool_call`, `stopReason != end_turn`, a `boolean` option, a policy fallback,
 * cancellation, noisy stdout, a dead agent - becomes an env var.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { createAcpAgent, AcpAgentError } from "../src/acp/agent.js"
import { parseInventory, shortenModeId } from "../src/core/models.js"
import { parseAgentOutput } from "../src/core/parse.js"
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
/** A command that does not exist, to exercise the spawn failure path. */
const MISSING = "opencode-acp-commande-inexistante-42"

let agent: AcpAgent

/** A minimal request: a single user message. */
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

/** Launches the fake agent with a superset of environment variables. */
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
 * Launches a fake agent whose pid is written to `pidFile`: the test can then
 * check that *that* process is dead, without counting `ps` output and without
 * risking that an orphan disappears during the waiting window.
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

/**
 * Launches the fake agent with `FAKE_ARGV_FILE`, and returns the arguments
 * `createAcpAgent` spawned it with.
 *
 * Note: the spawn arguments are the only part of the contract **not**
 * observable through the ACP protocol — the policy, the capabilities and the
 * prompt all travel on the wire, the command line does not. The fake records
 * its own argv (see `fake-acp.ts`), and the `[bun, script]` prefix that
 * `bun run` leaves in `process.argv` is sliced off: what remains is exactly
 * what `createAcpAgent` appended to `options.args`.
 */
const spawnFakeArgv = async (
  availableTools?: readonly string[],
): Promise<readonly string[]> => {
  const dir = await mkdtemp(join(tmpdir(), "acp-argv-"))
  pidFiles.push(dir)
  const argvFile = join(dir, "argv.json")
  const local = await createAcpAgent({
    command: process.execPath,
    args: ["run", FAKE],
    stderr: "ignore",
    ...(availableTools === undefined ? {} : { availableTools }),
    env: { FAKE_ARGV_FILE: argvFile },
  })
  try {
    const raw = await readFile(argvFile, "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error(`argv record is not an array: ${raw}`)
    const argv: string[] = []
    for (const item of parsed) {
      if (typeof item !== "string") throw new Error(`argv record holds a non-string: ${raw}`)
      argv.push(item)
    }
    return argv.slice(2)
  } finally {
    await local.close()
  }
}

/** A disposable temporary directory, for pid files. */
const pidFiles: string[] = []
const tmpPidFile = async (label: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `acp-pid-${label}-`))
  pidFiles.push(dir)
  return join(dir, "pid")
}

afterAll(async () => {
  await Promise.all(pidFiles.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Waits for the pid to appear in the file (the agent is starting). */
const readPid = async (pidFile: string, timeoutMs = 5_000): Promise<number> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const raw = await readFile(pidFile, "utf8").catch(() => "")
    const pid = Number(raw.trim())
    if (Number.isInteger(pid) && pid > 0) return pid
    if (Date.now() >= deadline) throw new Error(`the fake agent never wrote ${pidFile}`)
    await Bun.sleep(20)
  }
}

/** `true` as long as the process exists (signal 0 = "are you alive?"). */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits for the process to disappear, or for the delay. */
const waitForDeath = async (pid: number, timeoutMs = 3_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(25)
  return !isAlive(pid)
}

/**
 * Number of live `fake-acp` processes, as the system sees them. It is the only
 * global observation possible: an orphan adopted by init shows up in no
 * `close()` of the code that spawned it.
 */
const countFakeProcesses = (): number => {
  const ps = Bun.spawnSync(["ps", "-eo", "args="])
  if (!ps.success) return -1
  return ps.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes("fake-acp.ts")).length
}

/** Waits for the process count to drop back (or for the delay to elapse). */
const waitForFakeCount = async (target: number, timeoutMs = 5_000): Promise<number> => {
  const deadline = Date.now() + timeoutMs
  let current = countFakeProcesses()
  while (current > target && Date.now() < deadline) {
    await Bun.sleep(50)
    current = countFakeProcesses()
  }
  return current
}

/** Captures a promise's rejection, keeping the `Error` type. */
const captureError = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof Error)) {
    throw new Error(`a rejection was expected, received: ${String(error)}`)
  }
  return error
}

/** Same for `AcpAgentError`, whose `subject` field we want typed. */
const captureAgentError = async (promise: Promise<unknown>): Promise<AcpAgentError> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof AcpAgentError)) {
    throw new Error(`an AcpAgentError was expected, received: ${String(error)}`)
  }
  return error
}

/** The `type` values of a JSONL stream, without a cast. */
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

/** The `text`s of a stream, joined - **raw**, output contract included. */
const rawTextOf = (events: readonly AcpEvent[]): string =>
  events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("")

/**
 * The **visible** text of a stream.
 *
 * Note: an `AcpEvent` of type `text` carries the output contract object written
 * by `core/prompt.ts` (`{"type":"text","text":"..."}`), not the answer: decoding
 * is done by the adapter (`adapters/opencode-protocol.ts`), not by the ACP layer.
 * It is redone here with the **real** `parseAgentOutput`, so that these tests
 * cover exactly what the user will see.
 */
const textOf = (events: readonly AcpEvent[]): string => {
  const parsed = parseAgentOutput(rawTextOf(events), [])
  if (!parsed.ok) throw new Error(parsed.error.message)
  if (parsed.output.type !== "text") throw new Error("a tool request has no visible text")
  return parsed.output.text
}

beforeAll(async () => {
  agent = await spawnFake()
})

afterAll(async () => {
  await agent?.close()
})

// ─────────────────────────────────────────────────────────────────────────────

describe("lifecycle", () => {
  test("initialize returns the identity and the protocol version", () => {
    expect(agent.info).toEqual({ name: "fake-acp", version: "0.1.0" })
    expect(agent.protocolVersion).toBe(1)
  })

  test("close() is idempotent", async () => {
    const other = await spawnFake()
    await other.close()
    await other.close()
  })
})

describe("session closing", () => {
  test("closing the session, then the agent, is a no-op", async () => {
    const local = await spawnFake()
    try {
      const session = await local.open()
      // The nominal turn works...
      expect(textOf(await collect(session.prompt(request("PING"))))).toBe("PONG")

      await session.close()
      // ...and `close()` is idempotent on the session side too.
      await session.close()

      // `dispose()` cut the update routing: no method talks to the agent any
      // more, and no promise is left dangling.
      expect(() => session.prompt(request("PING"))).toThrow(/session closed/)
      await expect(session.setOption("model", "auto")).rejects.toThrow(/session closed/)
      await expect(session.setModel("auto")).rejects.toThrow(/session closed/)

      // The shared connection, on the other hand, is intact: a fresh session
      // works.
      const other = await local.open()
      await other.close()
    } finally {
      await local.close()
    }
  })
})

describe("inventory (configOptions)", () => {
  test("models() returns the three models of the `model` category", async () => {
    const models = await agent.models()
    expect(models.map((m) => m.id)).toEqual(["auto", "gpt-5.6-terra", "claude-sonnet-5"])
    // The readable label accompanies the id, and the description when the agent
    // provides one.
    expect(models[0]).toEqual({ id: "auto", name: "Auto", description: "Lets the agent choose" })
    expect(models[1]?.name).toBe("GPT-5.6 Terra")
    expect(models[2]?.name).toBe("Claude Sonnet 5")
  })

  test("the full inventory is parsed correctly", async () => {
    const session = await agent.open()
    try {
      const inventory = session.inventory()

      expect(inventory.currentModel).toBe("gpt-5.6-terra")
      expect(inventory.thoughtLevels).toEqual(["none", "medium", "high"])
      expect(inventory.currentThoughtLevel).toBe("medium")

      // The modes arrive as URLs: they are shortened.
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

      // The `permissions` category is properly isolated from `mode` and `model`.
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

  test("setModel updates the session inventory", async () => {
    const session = await agent.open()
    try {
      await session.setModel("claude-sonnet-5")
      expect(session.inventory().currentModel).toBe("claude-sonnet-5")
      // The change must not spill over to the other options.
      expect(session.inventory().currentThoughtLevel).toBe("medium")
    } finally {
      await session.close()
    }
  })

  test("setOption refuses an unknown value", async () => {
    const session = await agent.open()
    try {
      await expect(session.setOption("pas-une-option", "x")).rejects.toThrow(
        /unknown config option/,
      )
    } finally {
      await session.close()
    }
  })

  test("a `boolean` option round-trips with a typed payload", async () => {
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

        // `session/set_config_option` requires `{ type: "boolean", value: bool }`.
        // The fake only tests `params.value === true`: had we sent the string
        // `"true"`, the value read back would have stayed `false`.
        await session.setOption("telemetry", "true")
        expect(session.inventory().options.find((o) => o.id === "telemetry")?.currentValue).toBe("true")

        // And going back to `false` works through the same path.
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

describe("prompt -> AcpEvent", () => {
  test('a "PING" prompt produces contract-conforming text, then usage and done', async () => {
    const session = await agent.open()
    try {
      const events = await collect(session.prompt(request("PING")))

      // The end-of-turn `usage` is the discriminated `turn` variant: it carries
      // the counters **and** the cache tiers, all present in ACP's `Usage`.
      expect(events).toEqual([
        // Note: a **single** `text`. The fake obeys the output contract, so it no
        // longer splits "PONG" into pieces - it is the adapter that decides, at
        // the `done`, whether it is text or a tool call.
        { type: "text", text: '{"type":"text","text":"PONG"}' },
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

  test("an ACP plan becomes a single `plan` event", async () => {
    const session = await agent.open()
    try {
      const events = await collect(session.prompt(request("PLAN")))
      const plans = events.filter((e) => e.type === "plan")
      expect(plans).toHaveLength(1)
      expect(plans[0]).toEqual({
        type: "plan",
        entries: [
          { content: "Analyser", priority: "high", status: "completed" },
          { content: "Implement", priority: "medium", status: "in_progress" },
        ],
      })
      expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
    } finally {
      await session.close()
    }
  })

  test("the requested text reaches the agent, prefixed with its role", async () => {
    const session = await agent.open()
    try {
      const events = await collect(session.prompt(request("hello world")))
      // Note: the role prefix is not cosmetic. ACP has no "system" field, the
      // transcript is rendered flat, and the agent must be able to tell an
      // instruction from its own earlier output.
      const answered = textOf(events)
      expect(answered.startsWith("ACK: ")).toBe(true)
      expect(answered).toContain("User : hello world")
    } finally {
      await session.close()
    }
  })

  test("two results of the same tool reach the agent unmerged", async () => {
    // End to end: the fake does `ACK: <whole prompt>`, so what the agent really
    // receives is checked - both results, in order, with the tool name. That is
    // the `id` round-trip with no lookup table on the adapter side.
    const session = await agent.open()
    try {
      const transcript: NormalizedRequest = {
        system: [],
        tools: [],
        messages: [
          { role: "user", text: "re-read" },
          { role: "tool", id: "call-a", name: "read_file", output: "content A" },
          { role: "tool", id: "call-b", name: "read_file", output: "content B" },
        ],
      }
      const events = await collect(session.prompt(transcript))
      const echoed = textOf(events)
      expect(echoed).toContain("User : re-read")
      expect(echoed).toContain("Tool read_file : content A")
      expect(echoed).toContain("Tool read_file : content B")
      expect(echoed.indexOf("content A")).toBeLessThan(echoed.indexOf("content B"))
    } finally {
      await session.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `usage`: two distinct variants, never one with empty fields.
// ─────────────────────────────────────────────────────────────────────────────

describe("usage", () => {
  test("context usage and turn usage are not confused", async () => {
    const local = await spawnFake({ FAKE_EMIT_USAGE_UPDATE: "1" })
    try {
      const session = await local.open()
      try {
        const events = await collect(session.prompt(request("PING")))
        const usages = events.flatMap((e) => (e.type === "usage" ? [e] : []))

        // Note: `{ input?, output?, context? }` made `{}` legitimate and left the
        // reducer guessing - the same trap, transposed to `AcpEvent`.
        expect(usages).toHaveLength(2)

        // 1. The mid-turn notification: **context window**, not cost.
        expect(usages[0]).toEqual({ type: "usage", kind: "context", used: 12_345 })

        // 2. The final `PromptResponse`: the turn's cost.
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

        // Neither is assimilable to the other: that is the whole point.
        expect(usages.every((u) => u.kind === "context" || u.kind === "turn")).toBe(true)
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })

  test("an agent reporting no usage emits no such event", async () => {
    // The fake always emits one, so what is checked is only that a stream
    // without `usage_update` produces **only** the turn variant, never both.
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
// `tool_call` / `tool_call_update`: the heart of the mapping, untested before.
// ─────────────────────────────────────────────────────────────────────────────

describe("tool_call", () => {
  test("a tool_call and its updates become `tool` AcpEvents", async () => {
    const toolAgent = await spawnFake({ FAKE_EMIT_TOOL_CALL: "1" })
    try {
      const session = await toolAgent.open()
      try {
        const events = await collect(session.prompt(request("TOOL")))
        const tools = events.filter((e) => e.type === "tool")

        // Three events: the opening, then the two updates.
        expect(tools).toHaveLength(3)

        // 1. Opening: `pending`, with the call's raw input.
        expect(tools[0]).toEqual({
          type: "tool",
          id: "call-tool-1",
          name: "read_file",
          title: "Lire README.md",
          kind: "read",
          status: "pending",
          input: { path: "README.md" },
        })

        // 2. Partial update: neither `name` nor `rawOutput` => status only. No
        //    default value is fabricated, which would suggest a real `output` or
        //    a real `input`.
        expect(tools[1]).toEqual({
          type: "tool",
          id: "call-tool-1",
          name: "",
          title: "call-tool-1",
          kind: "other",
          status: "in_progress",
          input: undefined,
        })

        // 3. Final update: `completed` status + `rawOutput` relayed as-is.
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

        // The sequence does keep its order, then the turn closes normally.
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
// `stopReason`: only `end_turn` was covered.
// ─────────────────────────────────────────────────────────────────────────────

describe("stopReason", () => {
  for (const reason of ["max_tokens", "refusal", "cancelled"] as const) {
    test(`a stopReason "${reason}" is relayed into the AcpEvent done`, async () => {
      const local = await spawnFake({ FAKE_STOP_REASON: reason })
      try {
        const session = await local.open()
        try {
          const events = await collect(session.prompt(request("PING")))
          expect(events.at(-1)).toEqual({ type: "done", stopReason: reason })
          // The text and the usage always precede the `done`.
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
// Cancellation - the "Esc interrupts cleanly" condition.
// ─────────────────────────────────────────────────────────────────────────────

describe("cancellation", () => {
  test("an AbortSignal triggers session/cancel and yields done: cancelled", async () => {
    // The agent takes 800 ms to answer: the cancellation happens well before.
    const local = await spawnFake({ FAKE_SLOW_MS: "800" })
    try {
      const session = await local.open()
      try {
        const controller = new AbortController()
        const started = Date.now()
        const events: AcpEvent[] = []
        for await (const event of session.prompt(request("TICK"), { signal: controller.signal })) {
          events.push(event)
          // Note: `thought`, then `text`: reasoning is what streams live, the
          // answer text only arrives at the `done`.
          if (event.type === "thought" && event.text === "TICK") controller.abort()
        }
        expect(events[0]).toEqual({ type: "thought", text: "TICK" })
        expect(events.at(-1)).toEqual({ type: "done", stopReason: "cancelled" })
        // The cancellation did short-circuit the 800 ms latency: without it the
        // turn would have gone all the way to "TOK" and then `end_turn`.
        expect(Date.now() - started).toBeLessThan(800)
        expect(rawTextOf(events)).not.toContain("TOK")
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })

  test("a consumer abandonment WITHOUT a signal returns immediately", async () => {
    // Regression of the 80 s hang: the `finally` waited for the complete
    // `session/prompt`. A `break` without an `AbortSignal` therefore made the
    // next tick wait for the whole turn.
    const local = await spawnFake({ FAKE_SLOW_MS: "1500" })
    try {
      const session = await local.open()
      try {
        let abandonedAt = 0
        for await (const event of session.prompt(request("TICK"))) {
          expect(event).toEqual({ type: "thought", text: "TICK" })
          abandonedAt = Date.now()
          break
        }
        // `for await` waits for the generator's `return()`: that is the time
        // which measured 80 101 ms before the fix.
        expect(abandonedAt).toBeGreaterThan(0)
        expect(Date.now() - abandonedAt).toBeLessThan(300)
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })

  test("the nominal path always drains the stream to done", async () => {
    const local = await spawnFake({ FAKE_SLOW_MS: "50" })
    try {
      const session = await local.open()
      try {
        // Without an abandonment, the automatic cancellation must never fire.
        const events = await collect(session.prompt(request("TICK")))
        expect(textOf(events)).toBe("TOK")
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
// Permissions
// ─────────────────────────────────────────────────────────────────────────────

describe("permissions", () => {
  test("the default policy refuses", async () => {
    const session = await agent.open()
    try {
      const events = await collect(session.prompt(request("NEED_PERMISSION")))
      expect(textOf(events)).toBe("DENIED")
    } finally {
      await session.close()
    }
  })

  test('an "allow" policy does get the allow_once option', async () => {
    const permissive = await spawnFake({}, allowAllPermissions)
    try {
      const session = await permissive.open()
      try {
        const events = await collect(session.prompt(request("NEED_PERMISSION")))
        expect(textOf(events)).toBe("ALLOWED")
      } finally {
        await session.close()
      }
    } finally {
      await permissive.close()
    }
  })

  test("the decision is visible in the AcpEvent stream", async () => {
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
      expect(decision.request.title).toBe("Write to config.json")
      expect(decision.request.options.map((o) => o.id)).toEqual(["allow-once", "reject-once"])
      expect(decision.decision).toEqual({ action: "select", optionId: "reject-once" })
      expect(decision.selectedOptionId).toBe("reject-once")
    } finally {
      await session.close()
    }
  })

  test("the agent offering only allow_* options cancels the turn", async () => {
    // `toPermissionResponse`'s fallback: a "reject" policy without an explicit
    // `optionId` looks for a `reject_*` option; there is none, so it
    // **cancels** rather than grants.
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

  test("the agent offering only reject_* options gets the refusal through", async () => {
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

  test("the agent offering no option at all is cancelled by the policy", async () => {
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
// Errors: typed, naming, and always followed by a `done`.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Surface reduction at spawn: the sibling layer of the permission policy, not
// its replacement. The policy only binds an agent that asks; this one reduces
// what it can even propose.
// ─────────────────────────────────────────────────────────────────────────────

describe("surface reduction at spawn", () => {
  test("an agent that does not accept the flag is spawned without it", async () => {
    // The default is **off**: no opt-in, no flag. An unknown argument would
    // kill the spawn — a worse failure than no restriction.
    expect(await spawnFakeArgv()).toEqual([])
  })

  test("deny-all reduces the surface to nothing at spawn", async () => {
    expect(await spawnFakeArgv([])).toEqual(["--available-tools", ""])
  })

  test("allow-all leaves the surface alone at spawn", async () => {
    expect(await spawnFakeArgv(["*"])).toEqual([])
  })

  test("an explicit list restricts the surface at spawn", async () => {
    expect(await spawnFakeArgv(["read_file", "write_file"])).toEqual([
      "--available-tools",
      "read_file,write_file",
    ])
  })
})

describe("declared capabilities", () => {
  test("initialize announces no lying fs capability", async () => {
    // In the default deny-all mode we can neither read nor write on disk.
    // Declaring `readTextFile/writeTextFile: true` while the handlers returned
    // `""` and a no-op was a **false** capability: the agent believed it could
    // get files and only got nothing.
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
        throw new Error(`clientCapabilities without "fs": ${raw}`)
      }
      // The SDK adds its own defaults (`terminal`, `auth`): only what concerns
      // us is judged, that is, the promise made about the disk.
      expect(declared.fs).toEqual({ readTextFile: false, writeTextFile: false })
    } finally {
      await local.close()
    }
  })
})

describe("errors", () => {
  test("a non-existent command produces an AcpAgentError naming it", async () => {
    const error = await captureError(
      createAcpAgent({ command: MISSING, stderr: "ignore" }),
    )
    if (!(error instanceof AcpAgentError)) {
      throw new Error(`expected an AcpAgentError, received ${error.name}: ${error.message}`)
    }
    expect(error.name).toBe("AcpAgentError")
    // The message must be *useful*: the command's name AND the real cause,
    // whether the runtime words it "ENOENT" (Node) or "Executable not found in
    // $PATH" (Bun). Before, we got "ACP connection closed" and no command name
    // appeared anywhere.
    expect(error.message).toContain(MISSING)
    expect(error.message).toMatch(/cannot start the agent/i)
    expect(error.message).toMatch(/ENOENT|not found/i)
    // The field is called `subject` and not `command`: depending on the origin it
    // holds the command **or** a `sessionId`, and `log(e.command)` printed a
    // UUID believing it was a command line.
    expect(error.subject).toBe(MISSING)
  })

  test("an agent dying before initialize reports its exit code", async () => {
    const error = await captureError(spawnFake({ FAKE_EXIT_AT_INIT: "1" }))
    expect(error.name).toBe("AcpAgentError")
    // Neither "ACP connection closed" nor a made-up command name.
    expect(error.message).toContain("fake-acp.ts")
    expect(error.message).toMatch(/code=3/)
  })

  test("a timed-out initialize names the command and kills the agent", async () => {
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
    expect(error.message).toMatch(/initialize timed out/)
  })

  test("noise on stdout does not prevent speaking ACP", async () => {
    // The NDJSON line SDK ignores what is not JSON: the chatty agent stays
    // usable. What matters here is that no error is triggered and the stream
    // stays complete.
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

  test("acp-run refuses an unknown `--model` with a dedicated exit code", async () => {
    // "Unknown model" is the most likely diagnostic when facing an exotic agent.
    // Without the `try/catch`, it surfaced as an unhandled rejection with an SDK
    // stack, and without the list of accepted values.
    const proc = Bun.spawn(
      [process.execPath, "run", CLI, "--command", process.execPath, "--arg", "run",
       "--arg", FAKE, "--model", "not-a-model", "--list-models"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FAKE_REJECT_UNKNOWN_MODEL: "1" },
      },
    )
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(code).toBe(4)
    expect(stderr).toContain("option refused by the agent")
    expect(stderr).toContain("Invalid model")
    expect(stderr).toContain("known models")
    // No `invalid model` must leak as an unhandled rejection.
    expect(stderr).not.toContain("promise rejection")
  })

  test("acp-run accepts a known `--model` and updates the inventory", async () => {
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

  test("`stderr: \"pipe\"` feeds `onStderr` without writing to our stderr", async () => {
    // The default is now `"pipe"`: a host does not want the agent's logs landing
    // in its journal. Only the CLI, whose terminal *is* the user, asks for
    // `inherit`.
    const chunks: string[] = []
    const local = await createAcpAgent({
      command: process.execPath,
      args: ["run", FAKE],
      stderr: "pipe",
      onStderr: (chunk) => chunks.push(chunk),
      env: { FAKE_NOISY_STDOUT: "1" },
    })
    try {
      // A full round trip guarantees the startup chunk was delivered.
      const session = await local.open()
      expect(textOf(await collect(session.prompt(request("PING"))))).toBe("PONG")
      await session.close()
      expect(chunks.join("")).toContain("fake-acp: startup warning")
    } finally {
      await local.close()
    }
  })

  test("the agent's stderr is relayed into the error message", async () => {
    // The stderr queue was dead code (the CLI never exposes `stderr: "pipe"`).
    // It is now always fed, whatever the mode - it is the only information that
    // explains the agent's death.
    const error = await captureError(
      spawnFake({ FAKE_NOISY_STDOUT: "1", FAKE_EXIT_AT_INIT: "1" }),
    )
    expect(error.name).toBe("AcpAgentError")
    expect(error.message).toContain("fake-acp.ts")
    expect(error.message).toContain("fake-acp: startup warning")
  })

  test("an agent dying mid-turn emits error THEN done", async () => {
    const local = await spawnFake({ FAKE_DIE_ON_PROMPT: "1" })
    try {
      const session = await local.open()
      const events = await collect(session.prompt(request("DIE")))
      // Without a final `done`, `@opencode/ai` rejects with "The provider
      // response ended unexpectedly.", indistinguishable from a truncation.
      expect(events.at(-1)).toEqual({ type: "done", stopReason: "cancelled" })
      expect(events.some((e) => e.type === "error")).toBe(true)
    } finally {
      await local.close()
    }
  })

  test("acp-run exits non-zero when the stream contains an error", async () => {
    const proc = Bun.spawn(
      [process.execPath, "run", CLI, "--command", process.execPath, "--arg", "run",
       "--arg", FAKE, "--prompt", "DIE"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, FAKE_DIE_ON_PROMPT: "1" } },
    )
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    expect(code).not.toBe(0)
    // The stream stays usable: `done` is indeed present despite the error.
    const types = eventTypes(stdout)
    expect(types).toContain("error")
    expect(types).toContain("done")
  })

  test("acp-run exits non-zero on a non-existent command", async () => {
    const proc = Bun.spawn(
      [process.execPath, "run", CLI, "--command", MISSING, "--list-models"],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(code).not.toBe(0)
    // The message names the command: that is the whole value of the typed error.
    expect(stderr).toContain(MISSING)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Process leak: the blocker #1.
// ─────────────────────────────────────────────────────────────────────────────

describe("process lifecycle", () => {
  test("close() kills the subprocess", async () => {
    const pidFile = await tmpPidFile("close")
    const local = await spawnTrackedFake({}, pidFile)
    const pid = await readPid(pidFile)
    expect(isAlive(pid)).toBe(true)

    await local.close()
    expect(await waitForDeath(pid)).toBe(true)
  })

  test("a timed-out initialize leaves no orphan", async () => {
    // Note: this is the path that leaked before the fix. `createAcpAgent`
    // threw before returning the object, so nobody carried the `child.kill()`,
    // and the process was adopted by init. An agent timing out on every launch
    // means one accumulated process per request.
    const pidFile = await tmpPidFile("timeout")
    const pidPromise = readPid(pidFile)
    await spawnTrackedFake({ FAKE_SLOW_INIT_MS: "30000" }, pidFile, {
      initializeTimeoutMs: 300,
    }).catch(() => undefined)

    const pid = await pidPromise
    expect(isAlive(pid)).toBe(false)
  })

  test("an agent dead before initialize leaves no orphan", async () => {
    const pidFile = await tmpPidFile("exit-init")
    const pidPromise = readPid(pidFile)
    await spawnTrackedFake({ FAKE_EXIT_AT_INIT: "1" }, pidFile).catch(() => undefined)

    expect(await waitForDeath(await pidPromise)).toBe(true)
  })

  test("a non-existent command leaves no orphan", async () => {
    const before = countFakeProcesses()
    await createAcpAgent({ command: MISSING, stderr: "ignore" }).catch(() => undefined)
    // Nothing to kill (`spawn` never produced a pid): what is checked is only
    // that no `fake-acp` process appeared.
    expect(countFakeProcesses()).toBe(before)
  })

  test("no child survives close() nor an initialisation failure", async () => {
    const baseline = countFakeProcesses()
    expect(baseline).toBeGreaterThan(0)

    // 1. Nominal path.
    const healthy = await spawnFake()
    await healthy.close()

    // 2. Impossible spawn.
    await createAcpAgent({ command: MISSING, stderr: "ignore" }).catch(() => undefined)

    // 3. Agent dead before `initialize`.
    await spawnFake({ FAKE_EXIT_AT_INIT: "1" }).catch(() => undefined)

    // 4. Agent making the `initialize` timeout expire.
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
// One turn at a time: a session invariant the callers rely on.
// ─────────────────────────────────────────────────────────────────────────────

describe("turn concurrency", () => {
  test("a second concurrent turn is refused", async () => {
    // Without this guard the `session/update`s of both turns would be
    // indistinguishable, and above all the second `permissionSinks.set` would
    // **overwrite** the first one's - whose permissions would become invisible
    // while the first turn's `finally` deleted them. A mute refusal is the worst
    // possible failure in the default deny-all mode.
    const local = await spawnFake({ FAKE_SLOW_MS: "800" })
    try {
      const session = await local.open()
      // The first event is consumed: that is what arms the invariant.
      const first = session.prompt(request("TICK"))[Symbol.asyncIterator]()
      expect(await first.next()).toEqual({ value: { type: "thought", text: "TICK" }, done: false })

      const error = await captureAgentError(collect(session.prompt(request("PING"))))
      expect(error.name).toBe("AcpAgentError")
      expect(error.message).toMatch(/turn is already running/)
      // The error names the session, not a "command".
      expect(error.subject).toBe(session.sessionId)

      // The refusal does **not** disarm the first turn's flag: it only stopped it
      // from being stolen. It is left to finish to check that it reaches its
      // end. `TICK` was already consumed: only the end of the turn is left.
      const rest: AcpEvent[] = []
      for await (const event of { [Symbol.asyncIterator]: () => first }) rest.push(event)
      expect(textOf(rest)).toBe("TOK")
      expect(rest.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
    } finally {
      await local.close()
    }
  })

  test("the invariant is per session, and disarms after the turn", async () => {
    const local = await spawnFake({ FAKE_SLOW_MS: "800" })
    try {
      const blocked = await local.open()
      const first = blocked.prompt(request("TICK"))[Symbol.asyncIterator]()
      await first.next()

      // A fresh session works: the invariant is local, not global.
      const other = await local.open()
      expect(textOf(await collect(other.prompt(request("PING"))))).toBe("PONG")

      // And the agent stays usable on `blocked` once its turn is over.
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
// Absent `configOptions`: a third-party agent is not obliged to send them.
// ─────────────────────────────────────────────────────────────────────────────

describe("malformed configOptions", () => {
  test("a `session/new` without configOptions gives an empty inventory, not a TypeError", async () => {
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
        // And above all: the following callers throw a **real** application
        // error, not a `TypeError` on `undefined`.
        await expect(session.setOption("model", "auto")).rejects.toThrow(
          /unknown config option/,
        )
        await expect(session.setModel("auto")).rejects.toThrow(/available options/)
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })

  test("a `set_config_option` response without configOptions keeps the current state", async () => {
    // `?? []` would have emptied the inventory: the next `parseInventory` would
    // then render an empty inventory, and `setModel` would stop working.
    const local = await spawnFake({ FAKE_SET_OMITS_CONFIG_OPTIONS: "1" })
    try {
      const session = await local.open()
      try {
        expect(session.inventory().currentModel).toBe("gpt-5.6-terra")

        await session.setModel("claude-sonnet-5")
        expect(session.inventory().options).toHaveLength(4)
        expect(session.inventory().currentModel).toBe("gpt-5.6-terra")

        // The option is still addressable: nothing was lost.
        await expect(session.setModel("auto")).resolves.toBeUndefined()
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })

  test("`setModel` without a `model` category option lists the existing configIds", async () => {
    const local = await spawnFake({ FAKE_NO_CONFIG_OPTIONS: "1" })
    try {
      const session = await local.open()
      try {
        const error = await captureError(session.setModel("auto"))
        // "no option of category model" without the available ids does not tell
        // the user what to try instead.
        expect(error.message).toContain("available options")
      } finally {
        await session.close()
      }
    } finally {
      await local.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `parseInventory` is pure: it is tested without a process, on raw captures.
// ─────────────────────────────────────────────────────────────────────────────

describe("parseInventory (pure)", () => {
  test("tolerates an empty, null or noisy entry", () => {
    expect(parseInventory([])).toEqual({ models: [], thoughtLevels: [], modes: [], options: [] })
    expect(parseInventory([null, 42, "nope", {}])).toEqual({
      models: [],
      thoughtLevels: [],
      modes: [],
      options: [],
    })
  })

  test("falls back to the id when the category is absent", () => {
    const inventory = parseInventory([
      { id: "reasoning_effort", name: "Effort", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
    ])
    expect(inventory.thoughtLevels).toEqual(["high"])
    expect(inventory.currentThoughtLevel).toBe("high")
  })

  test("the id fallback also knows `effort`, the id `opencode acp` uses", () => {
    // Measured on `opencode acp`: `category: thought_level` with `id: effort`.
    // The entry is therefore **not** what makes that agent work - it sends its
    // category. It covers the agent that would send only the id, and dropping it
    // would cost the effort levels silently: no variant published, and the
    // requested effort ignored without a word.
    const inventory = parseInventory([
      { id: "effort", name: "Effort", type: "select", currentValue: "xhigh", options: [{ value: "xhigh", name: "xhigh" }] },
    ])
    expect(inventory.thoughtLevels).toEqual(["xhigh"])
    expect(inventory.options[0]?.id).toBe("effort")
  })

  test("a category name is never used as an id to resolve", () => {
    // The table that resolves an id into a category is also what makes
    // `applyOption` send that id, so an entry equal to a category would put a
    // category on the wire - and every measured agent refuses one. The option
    // survives, uncategorised, which is the honest outcome: we do not know what
    // it means, and we must not guess a value the agent would reject.
    for (const id of ["thought_level", "permissions", "model_config"]) {
      const inventory = parseInventory([
        { id, name: id, type: "select", currentValue: "a", options: [{ value: "a", name: "a" }] },
      ])
      expect(inventory.options).toHaveLength(1)
      expect(inventory.options[0]?.category).toBe("")
      expect(inventory.thoughtLevels).toEqual([])
      expect(inventory.models).toEqual([])
      expect(inventory.permissions).toBeUndefined()
    }
  })

  test("`model` and `mode` stay resolvable: they are the real ids both agents send", () => {
    // The coincidence is measured, not assumed - `copilot` and `opencode acp`
    // both name these options `model` and `mode`, and both accept them. This
    // is the one case where an id equals its category, and it is why the
    // exclusion above stops at the categories nobody uses as ids.
    const inventory = parseInventory([
      { id: "model", type: "select", currentValue: "m", options: [{ value: "m", name: "m" }] },
      { id: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "build" }] },
    ])
    expect(inventory.options.map((o) => o.category)).toEqual(["model", "mode"])
    expect(inventory.models.map((m) => m.id)).toEqual(["m"])
    expect(inventory.modes.map((m) => m.id)).toEqual(["build"])
  })

  test("an id absent from the fallback table is kept, but matches no category", () => {
    // Reported rather than dropped: the option is real, we simply do not know
    // what it means. Guessing a category would publish variants the agent never
    // offered.
    const inventory = parseInventory([
      { id: "sunny", name: "Sunny", type: "select", currentValue: "yes", options: [{ value: "yes", name: "Yes" }] },
    ])
    expect(inventory.options).toHaveLength(1)
    expect(inventory.options[0]?.category).toBe("")
    expect(inventory.thoughtLevels).toEqual([])
  })

  test("an option id is never the category it stands for", () => {
    // The invariant behind `applyOption`: the wire wants the agent's `id`, and
    // no agent accepts its own category (`Unknown config option
    // 'thought_level'` on copilot, `unknown config option` on opencode).
    const inventory = parseInventory([
      { id: "reasoning_effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
      { id: "effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
    ])
    const ids = inventory.options.map((o) => o.id)
    expect(ids).toEqual(["reasoning_effort", "effort"])
    expect(ids).not.toContain("thought_level")
  })

  test("expands a `boolean` option into textual values", () => {
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

  test("flattens grouped `select`s", () => {
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

  test("shortenModeId: fragment, else last segment, else raw", () => {
    expect(shortenModeId("https://example.com/a/b#plan")).toBe("plan")
    expect(shortenModeId("https://example.com/a/b")).toBe("b")
    expect(shortenModeId("mode")).toBe("mode")
    expect(shortenModeId("")).toBe("")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `renderRequest`: pure, and living in `core/prompt.ts` - hence without the SDK.
// It is tested directly, with no process.
// ─────────────────────────────────────────────────────────────────────────────

describe("renderRequest (pure)", () => {
  test("every message is prefixed with its role", () => {
    const messages: readonly NormalizedMessage[] = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
      { role: "tool", id: "call-1", name: "read_file", output: "# README" },
    ]
    // The full rendering (role + system + catalogue + transcript + output
    // contract) is checked line by line in `test/parse.test.ts`. Only the
    // **transcript** is checked here, which is this file's share.
    const rendered = renderRequest({ system: ["SYSTEM"], tools: [], messages })
    expect(rendered).toContain(
      "User : hello\n\nAssistant : hi\n\nTool read_file : # README",
    )
  })

  test("two results of the same tool are not merged", () => {
    // That is the whole point of `NormalizedMessage`'s explicit `id`: two calls
    // to the same tool in the same conversation must stay **distinct**. A
    // rendering that rebuilt an id would merge them, and there would be no
    // `tool-result` left to close.
    const messages: readonly NormalizedMessage[] = [
      { role: "user", text: "lis deux fichiers" },
      { role: "tool", id: "call-a", name: "read_file", output: "content A" },
      { role: "tool", id: "call-b", name: "read_file", output: "content B" },
    ]
    const request: NormalizedRequest = { system: [], tools: [], messages }
    const rendered = renderRequest(request)

    expect(rendered).toContain("Tool read_file : content A")
    expect(rendered).toContain("Tool read_file : content B")
    // Order preserved, and above all **two** distinct blocks.
    expect(rendered.split("Tool read_file : ")).toHaveLength(3)
    // The rendering is stable: no identifier re-synthesised from one call to the
    // next.
    expect(renderRequest(request)).toBe(rendered)
  })
})
