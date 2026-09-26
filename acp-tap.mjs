#!/usr/bin/env node
/**
 * A stdio tap for ACP traffic. Sits between `createAcpAgent` and the agent.
 *
 * Usage: `acp-tap.mjs <log-file> <command> [args...]`
 *
 * Why a separate process: `createAcpAgent` spawns the agent itself, so the only
 * place that sees every byte on the wire is a process standing in the middle.
 * Counting `session/new` in the provider's own code would only count the calls it
 * *believes* it made; counting them here counts the ones that left.
 *
 * Frames are forwarded byte for byte. Only what a measurement needs is written
 * to the log, one JSON object per line:
 *
 *   - every request **sent to** the agent: method, id, and the character count
 *     of its params (the size of the prompt, which is what makes `reuse` vs
 *     `fresh` comparable);
 *   - the **result** of every `session/new` (`configOptions`, `models`): it is
 *     the one reply that carries the agent's inventory, and the only place a
 *     context window could be announced;
 *   - a count of the frames seen per direction, so a truncated log is detectable
 *     rather than silently read as a low count.
 *
 * The log is append-only and flushed per line: the probe reads it while the
 * agent is still running, and a crash loses nothing already measured.
 */
import { spawn } from "node:child_process"
import { appendFileSync, openSync } from "node:fs"

const [logPath, command, ...args] = process.argv.slice(2)

if (logPath === undefined || command === undefined) {
  process.stderr.write("usage: acp-tap.mjs <log-file> <command> [args...]\n")
  process.exit(2)
}

const log = openSync(logPath, "a")
/** Appends one record, unbuffered: a crash must not swallow what was measured. */
const record = (entry) => appendFileSync(log, `${JSON.stringify({ t: Date.now(), ...entry })}\n`)

const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] })
child.on("error", (error) => {
  record({ dir: "error", message: error.message })
  process.exit(1)
})

const counters = { out: 0, in: 0, new: 0, prompt: 0, close: 0, cancel: 0 }
record({ dir: "boot", pid: child.pid, argv: [command, ...args] })

/** Splits a byte stream into whole lines, keeping the incomplete tail. */
const tapLines = (sink) => {
  let tail = ""
  return (chunk) => {
    const lines = (tail + chunk).split("\n")
    tail = lines.pop() ?? ""
    for (const line of lines) sink(line)
  }
}

const onRequest = tapLines((line) => {
  if (line.trim() === "") return
  counters.out += 1
  const frame = JSON.parse(line)
  const method = frame.method
  if (typeof method !== "string") return
  if (method === "session/new") counters.new += 1
  if (method === "session/prompt") counters.prompt += 1
  if (method === "session/close") counters.close += 1
  if (method === "session/cancel") counters.cancel += 1
  const params = frame.params
  record({
    dir: "out",
    method,
    id: frame.id ?? null,
    bytes: line.length,
    ...(params === undefined ? {} : { paramsBytes: JSON.stringify(params).length }),
    counters: { ...counters },
  })
  child.stdin.write(line + "\n")
})

const onReply = tapLines((line) => {
  if (line.trim() === "") return
  counters.in += 1
  const frame = JSON.parse(line)
  const id = frame.id
  // The `session/new` result is the whole inventory, and the only reply large
  // enough to be worth keeping verbatim.
  if (frame.result !== undefined && id !== null) {
    record({ dir: "in", id, result: frame.result, counters: { ...counters } })
  }
  // `usage_update` is the agent's own statement of how full its context is. It is
  // the only way to tell a *context window* apart from a *running total*: the
  // `usage` of a `stop` does not say which of the two it counts, and the two
  // differ by an order of magnitude once a session is resumed.
  const update = frame.params?.update
  if (update?.sessionUpdate === "usage_update") {
    record({ dir: "in", kind: "usage_update", used: update.used ?? null })
  }
  process.stdout.write(line + "\n")
})

process.stdin.setEncoding("utf8")
process.stdin.on("data", onRequest)
process.stdin.on("end", () => child.stdin.end())

child.stdout.setEncoding("utf8")
child.stdout.on("data", onReply)

child.on("exit", (code, signal) => {
  record({ dir: "exit", code, signal, counters: { ...counters } })
  process.exit(code ?? 0)
})

const die = () => {
  child.kill("SIGTERM")
}
process.on("SIGTERM", die)
process.on("SIGINT", die)
