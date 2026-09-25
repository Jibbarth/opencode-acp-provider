// Sonde ACP : initialize + session/new, puis dump des configOptions/modes.
import { spawn } from "node:child_process"

const cmd = process.argv[2] ?? "copilot"
const argv = process.argv.slice(3)

const child = spawn(cmd, argv, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
})

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
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      console.error("[non-json stdout]", JSON.stringify(line.slice(0, 200)))
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    } else {
      console.error("[<- notification]", JSON.stringify(msg).slice(0, 300))
    }
  }
})
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d.toString()))

function send(method, params) {
  const rid = ++id
  const payload = { jsonrpc: "2.0", id: rid, method, params }
  child.stdin.write(JSON.stringify(payload) + "\n")
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 20000)
    pending.set(rid, (m) => {
      clearTimeout(t)
      m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result)
    })
  })
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
}

try {
  const init = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "acp-probe", version: "0.0.1" },
  })
  console.log("\n=== INITIALIZE ===")
  console.log(JSON.stringify(init, null, 2))

  const session = await send("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  })
  console.log("\n=== SESSION/NEW ===")
  console.log(JSON.stringify(session, null, 2))

  if (session?.configOptions?.length) {
    const byCat = {}
    for (const o of session.configOptions) (byCat[o.category ?? "_none"] ??= []).push(o)
    console.log("\n=== MODES PAR CATEGORIE ===")
    for (const [cat, opts] of Object.entries(byCat)) {
      console.log(`\n[${cat}]`)
      for (const o of opts) {
        console.log(
          `  id=${o.id} name=${JSON.stringify(o.name)} type=${o.type} current=${JSON.stringify(o.currentValue)}` +
            (o.options ? ` values=${JSON.stringify(o.options.map((v) => v.value))}` : ""),
        )
      }
    }
  }
} catch (e) {
  console.log("\n=== ERREUR ===", String(e).slice(0, 500))
} finally {
  child.stdin.end()
  child.kill()
  setTimeout(() => process.exit(0), 300)
}
