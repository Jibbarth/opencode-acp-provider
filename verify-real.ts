/**
 * Manual probe: the provider against a REAL ACP agent (`copilot --acp`).
 *
 * Deliberately outside `bun test`: the suite must not depend on an installed,
 * authenticated agent. This probe is the evidence that the whole chain works -
 * OpenCode -> `LLMRequest` -> Effect `Transport` -> stdio JSON-RPC -> agent ->
 * `AcpEvent` -> `LLMEvent` - and not only the path to `fake-acp`.
 *
 *   bun verify-real.ts copilot --acp
 *   bun verify-real.ts gemini --experimental-acp
 *   bun verify-real.ts npx -y @agentclientprotocol/codex-acp
 */
import { Effect, Result, Stream } from "effect"
import {
  GenerationOptions,
  LLMRequest,
  Message,
  SystemPart,
  ToolEntry,
  Usage,
} from "@opencode/ai/schema/index"
import type { LLMEvent } from "@opencode/ai/schema/index"

import { model } from "./src/index.js"
import { closeCachedAgents } from "./src/adapters/opencode-transport.js"
import type { AcpPrepared } from "./src/adapters/opencode-transport.js"

const command = process.argv[2] ?? "copilot"
const args = process.argv.slice(3)
const settings = {
  command,
  args: args.length > 0 ? args : ["--acp"],
  stderr: "ignore" as const,
}

const languageModel = model("gpt-5.6-terra", settings)
const route = languageModel.route
console.log(`# agent    : ${command} ${settings.args.join(" ")}`)
console.log(`# route    : id=${route.id} protocol=${route.protocol} transport=${route.transport.id}`)

// The contract is required by default: without that instruction the agent simply
// answers "pong" and the analysis fails, which would test the agent's
// consistency rather than our code.
const DEFAULT_TEXT =
  'Answer ONLY with this JSON object, no text around it: {"type":"text","text":"pong"}'

const request = new LLMRequest({
  model: languageModel,
  system: [SystemPart.make("You are a test assistant.")],
  messages: [Message.user(process.env.ACP_PROBE_TEXT ?? DEFAULT_TEXT)],
  tools: [
    ToolEntry.make({
      name: "read",
      description: "Reads a project file",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      },
    }),
  ],
  generation: GenerationOptions.make({ maxTokens: 200 }),
})

// The ACP transport does no HTTP: an executor that dies if called is supplied,
// so any regression is immediately visible.
const NO_HTTP = { http: { execute: () => Effect.die("the ACP transport does no HTTP") } }

const outcome = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const body = yield* route.body.from(request)
      const prepared: AcpPrepared = yield* route.prepareTransport(body, request)
      return yield* Stream.runCollect(route.streamPrepared(prepared, request, NO_HTTP))
    }),
  ).pipe(Effect.result),
)

if (Result.isFailure(outcome)) {
  console.log(`\nFAILURE: ${outcome.failure.message}`)
  await closeCachedAgents()
  process.exit(1)
}

const events: readonly LLMEvent[] = outcome.success
console.log(`\n# ${events.length} evenements LLMEvent`)
let ok = true

for (const e of events) {
  switch (e.type) {
    case "text-delta":
      process.stdout.write(e.text)
      break
    case "tool-call":
      console.log(`\n[tool-call] ${e.name} ${JSON.stringify(e.input)} providerExecuted=${e.providerExecuted}`)
      if (e.providerExecuted !== undefined) {
        console.log("  !! providerExecuted should be absent in raw-brain mode")
        ok = false
      }
      break
    case "tool-result":
      console.log(`\n[tool-result] ${e.name}  <-- should not appear in raw-brain mode`)
      ok = false
      break
    case "step-finish":
    case "finish": {
      console.log(`\n[${e.type}] reason=${e.reason.normalized}`)
      if (e.usage) {
        // `Usage` is a schema class: a plain object would fail the stream with
        // a misleading message, so it is checked for real rather than by name.
        const u = e.usage
        console.log(
          `  usage: ${u.constructor.name} input=${u.inputTokens} output=${u.outputTokens} cacheWrite=${u.cacheWriteInputTokens}`,
        )
        if (!(u instanceof Usage)) {
          console.log("  !! usage is not a Usage instance")
          ok = false
        }
      }
      break
    }
    case "provider-error":
      console.log(`\n[provider-error] ${e.message}`)
      break
    case "step-start":
    case "text-start":
    case "text-end":
      break
    default:
      console.log(`[${e.type}]`)
  }
}

const types = events.map((e) => e.type)
const hasFinish = types.includes("finish")
const hasStepFinish = types.includes("step-finish")
if (!hasStepFinish) {
  console.log("  !! no step-finish")
  ok = false
}
console.log(`\n# sequence : ${types.join(" -> ")}`)
console.log(ok && hasFinish ? "# VERDICT : OK" : "# VERDICT : SOUPECT")

await closeCachedAgents()
process.exit(ok && hasFinish ? 0 : 1)
