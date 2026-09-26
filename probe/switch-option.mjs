// ACP probe 2: change the model and the effort mid-session.
import { spawn } from "node:child_process"

const child = spawn(process.argv[2] ?? "copilot", process.argv.slice(3), { stdio: ["pipe", "pipe", "pipe"] })

let buf = ""
const pending = new Map()
let id = 0
child.stdout.on("data", (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
})
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d.toString().slice(0, 200)))

function send(method, params) {
  const rid = ++id
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n")
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 20000)
    pending.set(rid, (m) => { clearTimeout(t); m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result) })
  })
}

const pick = (opts, id) => opts.find((o) => o.id === id)

try {
  const init = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "acp-probe", version: "0.0.1" },
  })
  console.log("=== INITIALIZE ===")
  console.log(JSON.stringify(init, null, 2).slice(0, 1200))

  const s = await send("session/new", { cwd: process.cwd(), mcpServers: [] })
  const sessionId = s.sessionId
  console.log("\n=== SESSION/NEW === sessionId =", sessionId)
  console.log("categories:", s.configOptions.map((o) => `${o.category ?? "_"}/${o.id}`).join("  "))
  console.log("model courant:", pick(s.configOptions, "model")?.currentValue)
  console.log("modes (champ dedie):", JSON.stringify(s.modes ?? null))

  const target = process.env.TARGET_MODEL ?? "claude-sonnet-5"
  console.log(`\n=== set_config_option model -> ${target} ===`)
  const r1 = await send("session/set_config_option", { sessionId, configId: "model", value: target })
  console.log("model apres:", pick(r1.configOptions, "model")?.currentValue)
  console.log("nb valeurs model:", pick(r1.configOptions, "model")?.options?.length)

  console.log("\n=== set_config_option reasoning_effort -> max ===")
  const r2 = await send("session/set_config_option", { sessionId, configId: "reasoning_effort", value: "max" })
  console.log("effort apres:", pick(r2.configOptions, "reasoning_effort")?.currentValue)
  console.log("model toujours:", pick(r2.configOptions, "model")?.currentValue)

  console.log("\n=== set_config_option model -> valeur invalide ===")
  try {
    await send("session/set_config_option", { sessionId, configId: "model", value: "pas-un-modele" })
    console.log("-> acceptee silencieusement (inattendu)")
  } catch (e) { console.log("-> rejetee:", String(e).slice(0, 160)) }
} catch (e) {
  console.log("ERREUR:", String(e).slice(0, 400))
} finally {
  child.stdin.end(); child.kill(); setTimeout(() => process.exit(0), 300)
}
