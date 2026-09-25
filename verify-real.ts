/**
 * Sonde manuelle : le provider contre un VRAI agent ACP (`copilot --acp`).
 *
 * Volontairement hors de `bun test` : la suite ne doit pas dépendre d'un agent
 * installé et authentifié. Cette sonde sert de preuve que la chaîne complète
 * fonctionne — OpenCode → `LLMRequest` → `Transport` Effect → JSON-RPC stdio →
 * agent → `AcpEvent` → `LLMEvent` — et pas seulement le chemin vers `fake-acp`.
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

const request = new LLMRequest({
  model: languageModel,
  system: [SystemPart.make("Tu es un assistant de test.")],
  messages: [Message.user(process.env.ACP_PROBE_TEXT ?? "ping")],
  tools: [
    ToolEntry.make({
      name: "read",
      description: "Lit un fichier du projet",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      },
    }),
  ],
  generation: GenerationOptions.make({ maxTokens: 200 }),
})

// Le transport ACP ne fait pas de HTTP : on fournit un exécuteur qui meurt
// s'il est appelé, pour que toute régression soit immédiatement visible.
const NO_HTTP = { http: { execute: () => Effect.die("le transport ACP ne fait pas de HTTP") } }

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
  console.log(`\nECHEC : ${outcome.failure.message}`)
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
        console.log("  !! providerExecuted devrait etre absent en mode cerveau brut")
        ok = false
      }
      break
    case "tool-result":
      console.log(`\n[tool-result] ${e.name}  <-- ne devrait pas apparaitre en mode cerveau brut`)
      ok = false
      break
    case "step-finish":
    case "finish": {
      console.log(`\n[${e.type}] reason=${e.reason.normalized}`)
      if (e.usage) {
        const u = e.usage as unknown as Record<string, unknown>
        console.log(`  usage: ${u.constructor?.name} input=${u.inputTokens} output=${u.outputTokens} cacheWrite=${u.cacheWriteInputTokens}`)
        if (u.constructor?.name !== "Usage") {
          console.log("  !! usage n'est pas une instance de Usage")
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
  console.log("  !! aucun step-finish")
  ok = false
}
console.log(`\n# sequence : ${types.join(" -> ")}`)
console.log(ok && hasFinish ? "# VERDICT : OK" : "# VERDICT : SOUPECT")

await closeCachedAgents()
process.exit(ok && hasFinish ? 0 : 1)
