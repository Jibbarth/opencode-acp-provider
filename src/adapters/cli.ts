/**
 * `acp-run` - the debug CLI.
 *
 * It does nothing more than the core: it launches an ACP agent, displays its
 * inventory, and sends a prompt while printing the `AcpEvent` stream as JSONL on
 * stdout. It is the tool that lets an unknown agent be qualified ("does it obey
 * the JSON contract?") before investing in the OpenCode adapter.
 *
 *   acp-run --command copilot --arg --acp --list-models
 *   acp-run --command copilot --arg --acp --prompt "PING"
 *
 * Convention: **stdout = JSONL** (so `jq` can read it), **stderr = human**.
 */

import { createAcpAgent } from "../acp/agent.js"
import type { AcpAgent, Inventory, NormalizedRequest } from "../core/types.js"
import { allowAllPermissions, denyAllPermissions } from "../core/types.js"

/** What `--list-models` displays. */
interface InventoryReport {
  agentName: string
  agentVersion: string
  protocolVersion: number
  inventory: Inventory
}

interface CliOptions {
  command: string
  args: string[]
  cwd: string
  model?: string
  effort?: string
  prompt?: string
  listModels: boolean
  allowTools: boolean
}

/** Usage printed on stderr. */
const usage = (): string => `acp-run - runs an ACP agent and shows what it produces

  --command <cmd>     the agent command (mandatory, e.g. "copilot")
  --arg <value>       a command argument, repeatable (e.g. --acp)
  --cwd <dir>         working directory (default: current cwd)
  --model <id>        option value applied before the prompt (category "model")
  --effort <value>    option value applied before the prompt (category "thought_level")
  --prompt <text>     text sent to the agent; the answer is printed as JSONL
  --list-models       prints the inventory (models, efforts, modes, permissions)
  --allow-tools       allows the agent's native tools instead of denying everything
  -h, --help          this help

Examples:
  acp-run --command copilot --arg --acp --list-models
  acp-run --command copilot --arg --acp --model claude-sonnet-5 --list-models
  acp-run --command copilot --arg --acp --prompt '{"type":"text","text":"pong"}'

Exit codes:
  0  success   1  the stream emitted an "error" event
  2  invalid arguments   3  the agent could not start
  4  the agent refused an option (--model / --effort)
`

/** Minimal argument parser: no external dependency. */
const parseArgs = (argv: readonly string[]): CliOptions | { help: true } => {
  const options: CliOptions = {
    command: "",
    args: [],
    cwd: process.cwd(),
    listModels: false,
    allowTools: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // Both `--flag` and `--flag value` are accepted.
    const [flag, inlineValue] = splitFlag(arg ?? "")
    const value = (): string => {
      if (inlineValue !== undefined) return inlineValue
      const next = argv[i + 1]
      if (next === undefined) throw new Error(`option ${flag} expects a value`)
      i++
      return next
    }

    switch (flag) {
      case "-h":
      case "--help":
        return { help: true }
      case "--command":
        options.command = value()
        break
      case "--arg":
        options.args.push(value())
        break
      case "--cwd":
        options.cwd = value()
        break
      case "--model":
        options.model = value()
        break
      case "--effort":
        options.effort = value()
        break
      case "--prompt":
        options.prompt = value()
        break
      case "--list-models":
        options.listModels = true
        break
      case "--allow-tools":
        options.allowTools = true
        break
      default:
        throw new Error(`unknown option: ${arg ?? ""}`)
    }
  }

  if (options.command === "") throw new Error("--command is mandatory")
  return options
}

const splitFlag = (arg: string): [string, string | undefined] => {
  const index = arg.indexOf("=")
  if (index < 0) return [arg, undefined]
  return [arg.slice(0, index), arg.slice(index + 1)]
}

/** Minimal request: for now only raw text is sent. */
const toRequest = (text: string): NormalizedRequest => ({
  system: [],
  tools: [],
  messages: [{ role: "user", text }],
})

/** Human-readable inventory display, on stderr. */
const printInventory = (report: InventoryReport): void => {
  const line = (label: string, value: string): void => {
    process.stderr.write(`${label.padEnd(16)}${value}\n`)
  }
  const { inventory } = report
  const version = `protocol v${report.protocolVersion}`
  line("agent", `${report.agentName} ${report.agentVersion} (${version})`)
  line("models", inventory.models.map((m) => m.id).join(", ") || "(none)")
  line("active model", inventory.currentModel ?? "(none)")
  line("efforts", inventory.thoughtLevels.join(", ") || "(none)")
  line("modes", inventory.modes.map((m) => m.id).join(", ") || "(none)")
  const perms = inventory.permissions
  line(
    "permissions",
    perms ? `${perms.id}=${perms.currentValue} [${perms.values.join(", ")}]` : "(none)",
  )
}

/** The `acp-run` binary's entry point (see `bin/acp-run.ts`). */
export const main = async (argv: readonly string[]): Promise<number> => {
  let options: CliOptions | { help: true }
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`)
    return 2
  }
  if ("help" in options) {
    process.stderr.write(usage())
    return 0
  }

  if (!options.listModels && options.prompt === undefined) {
    process.stderr.write("nothing to do: pass --list-models and/or --prompt\n")
    return 2
  }

  let agent: AcpAgent
  try {
    agent = await createAcpAgent({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      policy: options.allowTools ? allowAllPermissions : denyAllPermissions,
      // Only the CLI wants to see the agent's logs: it **is** the user's
      // terminal. A host would keep the `"pipe"` default.
      stderr: "inherit",
    })
  } catch (error) {
    // `AcpAgentError` already carries a message naming the command: adding an
    // unreadable SDK stack on top of it is pointless.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 3
  }

  let failed = false
  try {
    process.stderr.write(
      `→ ${options.command} ${options.args.join(" ")}` +
        ` (${agent.info.name} ${agent.info.version})\n`,
    )

    // A single session for both operations: when `--list-models` is combined
    // with `--model`/`--effort`, the displayed inventory reflects the real state
    // after the toggles are applied.
    const session = await agent.open({ cwd: options.cwd })

    try {
      // "Unknown model" is the most likely diagnostic when facing an exotic
      // agent. Without this `try/catch` a refused value surfaces as an
      // unhandled rejection with an unreadable SDK stack, and the user sees
      // neither the accepted values nor the command that failed.
      try {
        if (options.model !== undefined) await session.setModel(options.model)
        if (options.effort !== undefined) {
          const effort = session.inventory().options.find((o) => o.category === "thought_level")
          if (effort !== undefined) await session.setOption(effort.id, options.effort)
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const known = session
          .inventory()
          .models.map((m) => m.id)
          .join(", ")
        process.stderr.write(
          `option refused by the agent: ${detail}\n` +
            (known === "" ? "" : `known models: ${known}\n`),
        )
        return 4
      }

      if (options.listModels) {
        printInventory({
          agentName: agent.info.name,
          agentVersion: agent.info.version,
          protocolVersion: agent.protocolVersion,
          inventory: session.inventory(),
        })
      }

      if (options.prompt !== undefined) {
        // One event per line: readable by eye *and* pipeable into `jq`.
        for await (const event of session.prompt(toRequest(options.prompt))) {
          process.stdout.write(`${JSON.stringify(event)}\n`)
          // An `error` in the stream must yield a **non-zero** code: with 0, CI
          // sees nothing and the failure goes unnoticed.
          if (event.type === "error") failed = true
        }
      }
      return failed ? 1 : 0
    } finally {
      await session.close()
    }
  } finally {
    await agent.close()
  }
}

// Direct execution (`bun run src/adapters/cli.ts`) - ignored when the module is
// imported (by `bin/acp-run.ts`).
if (import.meta.main === true) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      process.stderr.write(`${detail}\n`)
      process.exit(1)
    },
  )
}
