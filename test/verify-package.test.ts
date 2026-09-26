/**
 * `verify:package`: the package contract, verified **by execution**.
 *
 * An entry point that does not export `setup` / `model`, or a `package` field
 * pointing at nothing, produces **no** error at load time: the server imports
 * the module, does not find the expected function, and the first chat fails.
 * `scripts/verify-package.mjs` catches that **before** publication.
 *
 * These tests run the script in a fresh Node process, because its whole purpose
 * is to prove that a runtime **different** from the development one can load the
 * package - a test inside the test runtime would therefore prove nothing.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT = fileURLToPath(new URL("../scripts/verify-package.mjs", import.meta.url))
const MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url))
const HOOK = fileURLToPath(new URL("../scripts/resolve-ts-extensions.mjs", import.meta.url))

/**
 * The **Node** binary, not `process.execPath`.
 *
 * Note: this detail is what gives the whole file its value. The suite runs under
 * Bun, so `process.execPath` is `bun` - and Bun resolves `./x.js` to `./x.ts`
 * and strips types natively. Running the script with it would test Bun, that is,
 * exactly what the script claims **not** to depend on. `bun` also fails on the
 * resolution, so the test has to find `node` by itself.
 */
const NODE = Bun.which("node")
if (NODE === null) {
  throw new Error("node est requis pour tester scripts/verify-package.mjs")
}

/** Runs the script and returns `{ code, stdout, stderr }`. */
const run = async (script = SCRIPT, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([NODE, script], {
    stdout: "pipe",
    stderr: "pipe",
    ...(cwd === undefined ? {} : { cwd }),
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

describe("verify:package", () => {
  test("the intact package passes, and every contract is named", async () => {
    const { code, stdout } = await run()
    // Note: this test would fail if the script held any TypeScript syntax Node
    // cannot strip (a parameter property, say): Node only strips what it knows
    // how to strip, and the failure would be a `SyntaxError` unrelated to the
    // contract - hence the value of launching it with the **Node binary** rather
    // than with `process.execPath`.
    expect(code).toBe(0)
    // The four requested contracts, one by one, with their field name.
    expect(stdout).toContain("default.setup")
    expect(stdout).toContain("model")
    expect(stdout).toContain("Provider.Info.package")
    expect(stdout).toContain("contrat du paquet vérifié")
  })

  test("the script uses no Bun API, and lives in a `.mjs`", async () => {
    // The whole point of the script is to run wherever publishing happens, in a
    // runtime that has no Bun. A dependency on `Bun.spawn` or `Bun.file` would
    // make it fail *before* the first check - the worst place for a guard.
    expect(SCRIPT.endsWith(".mjs")).toBe(true)
    const source = await readFile(SCRIPT, "utf8")
    // Neither the `Bun` global, nor a bun shebang, nor an internal import.
    expect(source).not.toMatch(/\bBun\s*[.[]/)
    expect(source.startsWith("#!/usr/bin/env node")).toBe(true)
    // The resolution hook is present, otherwise the import would fail on the
    // first `./x.js` and the message would be about resolution, not contract.
    expect(source).toContain("resolve-ts-extensions.mjs")
    expect(HOOK.endsWith(".mjs")).toBe(true)
  })

  test("`prepack` is properly wired, and fails when the verification fails", async () => {
    const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as {
      scripts?: Record<string, string>
    }
    expect(manifest.scripts?.["verify:package"]).toBe("node scripts/verify-package.mjs")
    expect(manifest.scripts?.["prepack"]).toContain("verify:package")
  })

  test("the resolution hook rewrites only what it should", async () => {
    // The hook must touch **only** relative `.js` specifiers whose `.ts`
    // exists: a dependency named `x.js` must stay intact, otherwise the package
    // would load the wrong dependency.
    const probe = [
      `const hook = await import(${JSON.stringify(HOOK)})`,
      'const cases = ["./core/prompt.js", "../core/prompt.js", "effect", "./agent.js", "/abs.js"]',
      // `src/acp/`: `../core/prompt.ts` exists, `./core/prompt.ts` does not.
      `const parentURL = ${JSON.stringify(
        new URL("../src/acp/", import.meta.url).href,
      )}`,
      'const nextResolve = (specifier) => ({ specifier, synthetic: true })',
      'const out = cases.map((s) => hook.resolve(s, { parentURL }, nextResolve).specifier)',
      'console.log(JSON.stringify(out))',
    ].join("\n")
    const probePath = await mkdtemp(join(tmpdir(), "acp-hook-"))
    try {
      const path = join(probePath, "probe.mjs")
      await writeFile(path, probe, "utf8")
      const proc = Bun.spawn([NODE, path], { stdout: "pipe", stderr: "pipe" })
      const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
      expect(code).toBe(0)
      const resolved: unknown = JSON.parse(stdout.trim())
      expect(resolved).toEqual([
        // `src/acp/core/prompt.ts` does not exist => no rewrite.
        "./core/prompt.js",
        // `src/core/prompt.ts` exists => rewrite.
        "../core/prompt.ts",
        // A bare package is never rewritten.
        "effect",
        // `src/acp/agent.ts` exists => rewrite.
        "./agent.ts",
        // An absolute path is never rewritten.
        "/abs.js",
      ])
    } finally {
      await rm(probePath, { recursive: true, force: true })
    }
  })

  test("a forged field is named in the failure message", async () => {
    // The repository's `package.json` is not broken: a copy is made in a
    // temporary directory, with the same script pointed at it. The script
    // determines its root **from its own location**, so both are copied, and
    // only the manifest is altered.
    const scratch = await mkdtemp(join(tmpdir(), "acp-verify-"))
    const root = fileURLToPath(new URL("..", import.meta.url))
    try {
      const { cp } = await import("node:fs/promises")
      await cp(join(root, "scripts"), join(scratch, "scripts"), { recursive: true })
      // The entry points must exist *in the copied root*: the forged
      // `package.json` and a minimal `src/` are what get copied.
      await cp(join(root, "src"), join(scratch, "src"), { recursive: true })
      const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as Record<string, unknown>
      const exportsField = manifest["exports"] as Record<string, string>
      manifest["exports"] = { ...exportsField, ".": "./src/inexistant.ts" }
      await writeFile(join(scratch, "package.json"), JSON.stringify(manifest, null, 2), "utf8")

      const { code, stderr } = await run(join(scratch, "scripts", "verify-package.mjs"), scratch)
      expect(code).not.toBe(0)
      // The offending field is named, and the summary lists them.
      expect(stderr).toContain('exports["."]')
      expect(stderr).toContain("champ(s) en défaut")
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
