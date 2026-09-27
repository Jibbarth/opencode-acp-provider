import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The path is read from the environment at module load, so the test points it at
// a throwaway directory before importing anything that uses it.
const dir = join(tmpdir(), `acp-log-${process.pid}`)
process.env["XDG_DATA_HOME"] = dir

const { LOG_PATH, appendLog } = await import("../src/adapters/plugin-log.js")

describe("the plugin's diagnostic file", () => {
  beforeEach(() => rmSync(dir, { recursive: true, force: true }))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("a line lands in the file, and the directory is created if absent", () => {
    // The whole point of the file: in the TUI the plugin's stderr never reaches
    // the user, so this is the only channel that survives every host mode.
    expect(existsSync(dir)).toBe(false)
    appendLog("[acp] hello\n")
    expect(readFileSync(LOG_PATH, "utf8")).toContain("[acp] hello\n")
  })

  test("lines accumulate rather than overwriting each other", () => {
    // A log that truncates would take the evidence of a failure with it.
    appendLog("one\n")
    appendLog("two\n")
    const contents = readFileSync(LOG_PATH, "utf8")
    expect(contents).toContain("one\n")
    expect(contents).toContain("two\n")
    expect(contents.indexOf("one")).toBeLessThan(contents.indexOf("two"))
  })
})
