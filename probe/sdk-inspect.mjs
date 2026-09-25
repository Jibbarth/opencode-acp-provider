// Sonde ACP basée sur le SDK officiel @agentclientprotocol/sdk
// Usage: node sdk-inspect.mjs [commande] [args...]
import { spawn } from "node:child_process"
import { Writable, Readable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

const cmd = process.argv[2] ?? "copilot"
const argv = process.argv.slice(3)

const proc = spawn(cmd, argv, { stdio: ["pipe", "pipe", "inherit"] })
const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout))

const agent = {
  async requestPermission(params) {
    // Cereveau brut : on refuse par defaut.
    const reject = params.options.find((o) => String(o.kind).startsWith("reject"))
    console.log(`   [permission] ${params.toolCall.title} -> ${reject?.optionId ?? "?"}`)
    return { outcome: { outcome: "selected", optionId: reject?.optionId ?? params.options[0].optionId } }
  },
  async readTextFile() { return { content: "" } },
  async writeTextFile() { return {} },
}

try {
  const result = await acp
    .client({ name: "acp-sdk-probe" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => agent.requestPermission(ctx.params))
    .onRequest(acp.methods.client.fs.readTextFile, (ctx) => agent.readTextFile(ctx.params))
    .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => agent.writeTextFile(ctx.params))
    .connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      })
      console.log("\n=== INITIALIZE ===")
      console.log("  protocole  :", init.protocolVersion)
      console.log("  agent      :", init.agentInfo?.name, init.agentInfo?.version)
      console.log("  caps       :", JSON.stringify(init.agentCapabilities))

      return ctx.buildSession(process.cwd()).withSession(async (session) => {
        console.log("\n=== SESSION ===")
        console.log("  sessionId  :", session.sessionId)

        const opts = session.newSessionResponse.configOptions ?? []
        for (const o of opts) {
          const values = o.type === "select" ? o.options?.map((v) => v.value) : []
          console.log(`  [${o.category ?? "_"}] ${o.id} = ${JSON.stringify(o.currentValue)}  (${values?.length ?? 0} valeurs)`)
        }
        const model = opts.find((o) => o.category === "model")
        if (model) {
          console.log("\n=== MODELES ===")
          for (const v of model.options ?? []) console.log("  -", v.value, "|", v.name)
        }

        console.log("\n=== PROMPT ===")
        const promptPromise = session.prompt("Réponds uniquement par un objet JSON : {\"type\":\"text\",\"text\":\"pong\"}")
        for (;;) {
          const msg = await session.nextUpdate()
          if (msg.kind === "stop") {
            console.log("  stopReason :", msg.response.stopReason)
            break
          }
          const u = msg.notification.update
          if (u.sessionUpdate === "agent_message_chunk")
            process.stdout.write("  [txt] " + (u.content.type === "text" ? u.content.text : `<${u.content.type}>`) + "\n")
          else if (u.sessionUpdate === "agent_thought_chunk")
            process.stdout.write("  [thought] " + (u.content.type === "text" ? u.content.text : "") + "\n")
          else console.log(`  [${u.sessionUpdate}]`)
        }
        return await promptPromise
      })
    })
  console.log("\n=== TERMINE ===", JSON.stringify(result))
} catch (e) {
  console.log("\n=== ERREUR ===", String(e).slice(0, 400))
} finally {
  proc.kill()
  setTimeout(() => process.exit(0), 300)
}
