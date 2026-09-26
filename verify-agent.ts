/**
 * `verify:agent` - the conformity probe against **any** ACP server.
 *
 * The project's goal is to work with any agent speaking the protocol, not only
 * with `copilot`. This probe is how that claim is kept honest: pointed at any
 * command, it **qualifies** the agent and *reports what it can do* instead of
 * failing.
 *
 *   npm run verify:agent -- copilot --acp
 *   npm run verify:agent -- opencode acp
 *   npm run verify:agent -- gemini --experimental-acp
 *   npm run verify:agent -- npx -y @agentclientprotocol/codex-acp
 *
 * Note: it goes through the **project's own code** (`createAcpAgent`,
 * `renderRequest`, `parseAgentOutput`, `parseInventory`), not through a raw
 * JSON-RPC client. A difference the probe reports is then a difference *in this
 * project*, which is the only thing worth acting on: an agent that disagrees
 * with the specification is a fact to document, not a bug to fix here.
 *
 * Note: three verdicts per capability, and the distinction is the whole point.
 * `ok` - we do it. `degrade` - the agent does it differently and we cope.
 * `absent` - the agent cannot do it, so neither can we. **None of the three is a
 * failure of our code**, and a probe that reported them all as errors would be
 * useless: an agent with no permission support would look exactly like a broken
 * client.
 *
 * Exit code: `0` when no probe found a defect on our side, `1` otherwise. An
 * agent that simply lacks a capability never changes the exit code.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Model } from "@opencode/schema/model"

import { createAcpAgent } from "./src/acp/agent.js"
import { parseAgentOutput } from "./src/core/parse.js"
import { allowAllPermissions } from "./src/core/types.js"
import type { AcpAgent, AcpEvent, NormalizedRequest } from "./src/core/types.js"
import { PSEUDO_MODEL_IDS, inventoryToModels } from "./src/core/publish.js"

const argv = process.argv.slice(2)
const command = argv[0]
if (command === undefined || command === "-h" || command === "--help") {
  process.stderr.write(
    "usage: verify:agent <command> [args...]\n" +
      "  e.g. verify:agent copilot --acp\n" +
      "       verify:agent opencode acp\n" +
      "       verify:agent npx -y @agentclientprotocol/codex-acp\n",
  )
  process.exit(command === undefined ? 2 : 0)
}
const args = argv.slice(1)
const label = [command, ...args].join(" ")

/** How long a single probe waits before being declared mute. */
const PROBE_TIMEOUT_MS = Number(process.env["VERIFY_AGENT_TIMEOUT_MS"] ?? 120_000)

// ─────────────────────────────────────────────────────────────────────────────
// Verdicts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ok` - conformant. `degrade` - the agent does it its own way and we cope.
 * `absent` - the agent does not offer it. `broken` - **our** code does not cope,
 * which is the only verdict that fails the run.
 */
type Verdict = "ok" | "degrade" | "absent" | "broken"

interface Report {
  readonly capability: string
  readonly verdict: Verdict
  readonly detail: string
}

const reports: Report[] = []

const report = (capability: string, verdict: Verdict, detail: string): void => {
  reports.push({ capability, verdict, detail })
}

const MARK: Readonly<Record<Verdict, string>> = {
  ok: "ok      ",
  degrade: "degrade ",
  absent: "absent  ",
  broken: "BROKEN  ",
}

/**
 * Runs one probe, turning any escape into a `broken` verdict.
 *
 * Note: the probe reports its **own** verdict. Three-valued reporting is the
 * point of the file, and a wrapper that assigned the verdict would force every
 * probe to return one and lose the detail that explains it.
 */
const guarded = async (capability: string, run: () => Promise<void>): Promise<void> => {
  try {
    await withTimeout(run(), PROBE_TIMEOUT_MS)
  } catch (error) {
    report(capability, "broken", error instanceof Error ? error.message : String(error))
  }
}

const withTimeout = async <A>(work: Promise<A>, ms: number): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout of ${ms} ms exceeded`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Probes
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal request; the contract is added by `renderRequest` itself. */
const request = (text: string): NormalizedRequest => ({
  system: ["You are a test assistant."],
  tools: [
    {
      name: "read",
      description: "Reads a project file",
      schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
    },
  ],
  messages: [{ role: "user", text }],
})

/** Drains a turn, returning the events and the concatenated agent text. */
const drain = async (events: AsyncIterable<AcpEvent>): Promise<{ readonly all: AcpEvent[]; readonly text: string }> => {
  const all: AcpEvent[] = []
  for await (const event of events) all.push(event)
  return {
    all,
    text: all
      .filter((e): e is Extract<AcpEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.text)
      .join(""),
  }
}

/** `auto` and friends: the model option publishes them, `Model.Info` never does. */
const isPseudoModel = (id: string): boolean => {
  const normalized = id.trim().toLowerCase()
  return PSEUDO_MODEL_IDS.some((pseudo) => pseudo === normalized)
}

const CONTRACT_ASK =
  'Answer ONLY with this JSON object, no text around it: {"type":"text","text":"pong"}'

/**
 * The provider id the probe prefixes model ids with, to ask OpenCode's own
 * parser whether a published id is usable. The value is irrelevant to the
 * verdict - only the cut point matters - but it must be a legal `Provider.ID`.
 */
const PROBE_PROVIDER = "acp"

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

process.stderr.write(`# agent : ${label}\n\n`)

let defects = 0

let agent: AcpAgent | undefined
try {
  agent = await withTimeout(
    createAcpAgent({ command, args, stderr: "ignore" }),
    PROBE_TIMEOUT_MS,
  )
} catch (error) {
  // The agent could not even be launched. That is a fact about the agent, but
  // there is nothing left to qualify, so the run fails.
  process.stderr.write(
    `# FAILURE: the agent did not start: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}

try {
  const inventory = await withTimeout(agent.inventory(), PROBE_TIMEOUT_MS)

  process.stderr.write(`# agent        : ${agent.info.name} ${agent.info.version}\n`)
  process.stderr.write(`# protocol    : v${agent.protocolVersion}\n`)

  // ── 1. initialize ─────────────────────────────────────────────────────────
  report(
    "initialize",
    agent.protocolVersion === 1 ? "ok" : "degrade",
    `protocol v${agent.protocolVersion}`,
  )

  // ── 2. configOptions: presence and shape ─────────────────────────────────
  if (inventory.options.length === 0) {
    report("configOptions", "absent", "no configOption: the model is the only setting")
  } else {
    for (const option of inventory.options) {
      process.stderr.write(
        `#   [${option.category || "?"}] id=${option.id} type=${option.type} ` +
          `current=${JSON.stringify(option.currentValue)} values=${option.values.length}\n`,
      )
    }
    const unknownCategory = inventory.options.filter((o) => o.category === "")
    const idEqualsCategory = inventory.options.filter((o) => o.id === o.category)
    if (idEqualsCategory.length > 0) {
      // Legal, and `copilot` does it for `model` and `mode`. It is reported
      // because it is the one case where sending a **category** as a `configId`
      // would accidentally succeed - which is exactly how such a mistake can
      // survive on one agent and break on the next.
      process.stderr.write(
        `#   note: id == category for ${idEqualsCategory.map((o) => o.id).join(", ")} ` +
          "(a category sent by accident and accepted by this agent)\n",
      )
    }
    report(
      "configOptions",
      unknownCategory.length === 0 ? "ok" : "degrade",
      unknownCategory.length === 0
        ? `${inventory.options.length} option(s), all categorised`
        : `${inventory.options.length} option(s) - unknown category: ${unknownCategory.map((o) => o.id).join(", ")}`,
    )
  }

  // ── 3. models proposed ───────────────────────────────────────────────────
  const published = inventoryToModels(inventory)
  if (inventory.models.length === 0) {
    report("models", "absent", "no model: the provider can publish nothing")
  } else {
    const filtered = inventory.models.length - published.length
    // A `/` inside a model id is **not** a defect, and this probe used to
    // report it as one on a guess. OpenCode's own parser settles it:
    // `Model.Ref.parse` cuts at the **first** slash, so
    // `acp/opencode/big-pickle` resolves to the provider `acp` and the model id
    // `opencode/big-pickle` intact - and the ids OpenCode ships itself number
    // 4274 with a slash in them. So the parser is asked instead of a regex.
    //
    // Nothing is rewritten: the value is also the one `set_config_option` must
    // receive, so an id we altered could no longer be sent back.
    const unusable = published
      .map((model) => model.id)
      .filter((id) => {
        try {
          const ref = Model.Ref.parse(`${PROBE_PROVIDER}/${id}`)
          return ref.providerID !== PROBE_PROVIDER || ref.id !== id
        } catch {
          return true
        }
      })
    const slashed = published.filter((model) => model.id.includes("/")).length
    const detail =
      `${inventory.models.length} value(s), ${published.length} published` +
      (filtered > 0 ? ` (${filtered} pseudo-valeur(s))` : "") +
      (slashed > 0 ? ` - ${slashed} of them with "/", intact after Model.Ref.parse` : "")
    report(
      "models",
      unusable.length === 0 ? "ok" : "broken",
      unusable.length === 0 ? detail : `id that Model.Ref.parse refuses: ${unusable.join(", ")}`,
    )
  }

  // ── 4. effort levels ─────────────────────────────────────────────────────
  if (inventory.thoughtLevels.length === 0) {
    report("thoughtLevel", "absent", "no effort level: the variants will not be published")
  } else {
    report(
      "thoughtLevel",
      "ok",
      `${inventory.thoughtLevels.length} : ${inventory.thoughtLevels.join(", ")}`,
    )
  }

  // ── 5. modes ─────────────────────────────────────────────────────────────
  if (inventory.modes.length === 0) {
    report("mode", "absent", "no mode")
  } else {
    // Measured: copilot publishes URL ids, `opencode acp` plain strings.
    // `shortenModeId` handles both, so this is a report, not a defect.
    const raw = inventory.modes.map((m) => m.rawId)
    const urls = raw.filter((id) => id.includes("://"))
    report(
      "mode",
      "ok",
      `${inventory.modes.length} : ${inventory.modes.map((m) => m.id).join(", ")}` +
        (urls.length === 0 ? " (plain strings)" : ` (${urls.length} URLs)`),
    )
  }

  // ── 6. permissions category ──────────────────────────────────────────────
  if (inventory.permissions === undefined) {
    report("permissions", "absent", "no permissions category (the agent does not expose its tools)")
  } else {
    report("permissions", "ok", `id=${inventory.permissions.id} current=${inventory.permissions.currentValue}`)
  }

  // ── 7. the option round trip, by real id ─────────────────────────────────
  const session = await withTimeout(agent.open({ cwd: process.cwd() }), PROBE_TIMEOUT_MS)
  try {
    const effortOption = session.inventory().options.find((o) => o.category === "thought_level")
    if (effortOption === undefined) {
      report("set_config_option(effort)", "absent", "no option of category thought_level")
    } else {
      const target = effortOption.values.find((v) => v !== effortOption.currentValue)
      if (target === undefined) {
        report("set_config_option(effort)", "absent", "a single level: nothing to change")
      } else {
        // Sent through the portable contract by **id**. A category here is
        // refused by every agent measured, so this is where the id/category
        // confusion would show up.
        await session.setOption(effortOption.id, target)
        const now = session.inventory().options.find((o) => o.id === effortOption.id)?.currentValue
        report(
          "set_config_option(effort)",
          now === target ? "ok" : "broken",
          `id=${effortOption.id} → ${String(target)}${now === target ? "" : ` (received ${String(now)})`}`,
        )
      }
    }


    const modelOption = session.inventory().options.find((o) => o.category === "model")
    if (modelOption === undefined) {
      report("set_config_option(model)", "absent", "no option of category model")
    } else {
      // A **concrete** second model: a pseudo-value (`auto`) changes what the
      // agent publishes, so switching to one would prove the switch and nothing
      // about the option.
      const target =
        modelOption.values.find((v) => v !== modelOption.currentValue && !isPseudoModel(v)) ??
        modelOption.values.find((v) => v !== modelOption.currentValue)
      if (target === undefined) {
        report("set_config_option(model)", "absent", "a single model: nothing to change")
      } else {
        await session.setModel(target)
        const now = session.inventory().options.find((o) => o.id === modelOption.id)?.currentValue
        report(
          "set_config_option(model)",
          now === target ? "ok" : "broken",
          `id=${modelOption.id} → ${String(target)}${now === target ? "" : ` (received ${String(now)})`}`,
        )
      }
    }

    // ── 8. the JSON output contract ────────────────────────────────────────
    await guarded("outputContract", async () => {
      const { all, text } = await drain(session.prompt(request(CONTRACT_ASK)))
      if (all.some((e) => e.type === "error")) {
        throw new Error(
          all
            .filter((e): e is Extract<AcpEvent, { type: "error" }> => e.type === "error")
            .map((e) => e.message)
            .join(" ; "),
        )
      }
      if (text.trim() === "") {
        report("outputContract", "absent", "the agent answered nothing")
        return
      }
      const parsed = parseAgentOutput(text, [])
      if (parsed.ok) {
        report("outputContract", "ok", `usable JSON object (${text.trim().slice(0, 60)})`)
        return
      }
      // The agent answered, but not in our format. `parseAgentOutput` is
      // deliberately tolerant, so this is a real non-conformance and not a
      // formatting detail.
      report("outputContract", "degrade", parsed.error.message)
    })

    // ── 9. request_permission ──────────────────────────────────────────────
    // Probed with an **allowing** policy: the only way to learn whether the
    // agent is *able* to ask. Our production default refuses everything, which
    // is precisely what would hide the capability.
    //
    // Note: an allowing policy means the agent may really act, so the turn runs
    // in a throwaway directory. Probed from the project, the probe wrote
    // `sonde-acp.txt` into the repository - a qualification tool must not have
    // that side effect.
    const sandbox = await mkdtemp(join(tmpdir(), "acp-sonde-"))
    const permissive = await withTimeout(
      createAcpAgent({ command, args, stderr: "ignore", policy: allowAllPermissions }),
      PROBE_TIMEOUT_MS,
    )
    try {
      const ask = await permissive.open({ cwd: sandbox })
      try {
    await guarded("request_permission", async () => {
      const { all } = await drain(
        ask.prompt(
          request(
            "Write the file `probe-acp.txt` in the current directory with the content \"x\", " +
              'then answer ONLY with {"type":"text","text":"done"}.',
          ),
        ),
      )
      const asked = all.filter((e) => e.type === "permission")
      if (asked.length === 0) {
        report("request_permission", "absent", "the agent asked for nothing during the turn")
        return
      }
      const kinds = asked.flatMap((e) =>
        e.type === "permission" ? e.request.options.map((o) => o.kind) : [],
      )
      const refusable = asked.some(
        (e) => e.type === "permission" && e.request.options.some((o) => o.kind.startsWith("reject_")),
      )
      report(
        "request_permission",
        refusable ? "ok" : "degrade",
        `${asked.length} demande(s), options : ${[...new Set(kinds)].join(", ") || "aucune"}` +
          (refusable ? "" : " — aucun refus possible"),
      )
    })
      } finally {
        await ask.close()
      }
    } finally {
      await permissive.close()
      await rm(sandbox, { recursive: true, force: true })
    }

    // ── 10. cancellation ───────────────────────────────────────────────────
    await guarded("cancel", async () => {
      const controller = new AbortController()
      // Aborted **while the turn is running**: an agent that had already
      // finished would make the probe meaningless.
      setTimeout(() => controller.abort(), 1_500)
      const { all } = await drain(
        session.prompt(request('Answer ONLY with {"type":"text","text":"pong"}.'), {
          signal: controller.signal,
        }),
      )
      const done = all.find((e) => e.type === "done")
      if (done === undefined || done.type !== "done") {
        report("cancel", "absent", "the turn ended without `done`: nothing to observe")
        return
      }
      if (done.stopReason === "end_turn") {
        // The agent answered before the abort landed. Nothing was cancelled, so
        // the probe has learned **nothing** about cancellation - which is not the
        // agent failing, and must not be reported as if it were.
        report("cancel", "absent", "the turn ended before the abort: cancellation not observed")
        return
      }
      report("cancel", done.stopReason === "cancelled" ? "ok" : "degrade", `stopReason=${done.stopReason}`)
    })

    // ── 11. one turn at a time per session ─────────────────────────────────
    // Two concurrent turns would share `nextUpdate()` and the permission sink;
    // the session refuses the second rather than interleaving the two.
    await guarded("sessionIsolation", async () => {
      const first = session.prompt(request(CONTRACT_ASK))
      void drain(first).catch(() => undefined)
      const refused = await session
        .prompt(request(CONTRACT_ASK))
        [Symbol.asyncIterator]()
        .next()
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      report(
        "sessionIsolation",
        refused === undefined ? "broken" : "ok",
        refused === undefined
          ? "a second concurrent turn was accepted"
          : `the second is refused: ${refused instanceof Error ? refused.message : String(refused)}`,
      )
    })
  } finally {
    await session.close()
  }
} finally {
  await agent.close()
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict
// ─────────────────────────────────────────────────────────────────────────────

process.stderr.write("\n")
process.stderr.write("# CONFORMANCE\n")
for (const entry of reports) {
  const detail = entry.detail === "" ? "" : `  ${entry.detail}`
  process.stderr.write(`  [${MARK[entry.verdict]}] ${entry.capability}${detail}\n`)
  if (entry.verdict === "broken") defects++
}
process.stderr.write(
  `\n# VERDICT: ${defects === 0 ? "CONFORM" : `${defects} DEFECT(S) IN OUR CODE`}\n`,
)
process.exit(defects === 0 ? 0 : 1)
