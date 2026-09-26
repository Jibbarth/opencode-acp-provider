/**
 * A.4 — `verify:package` : le contrat du paquet, vérifié **par exécution**.
 *
 * Un point d'entrée qui n'exporte pas `setup` / `model`, ou un champ `package`
 * qui ne pointe sur rien, ne produit **aucune** erreur au chargement : le
 * serveur importe le module, ne trouve pas la fonction attendue, et le premier
 * chat échoue. `scripts/verify-package.mjs` attrape ça **avant** la publication.
 *
 * Ces tests exécutent le script dans un process Node neuf, parce que sa
 * raison d'être est précisément de proving qu'un runtime **différent** de celui
 * du développement sait charger le paquet — donc un test dans le runtime de
 * test ne prouverait rien.
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
 * Le binaire **Node**, et non `process.execPath`.
 *
 * ⚠️ C'est le détail qui fait toute la valeur de ce fichier de test : la suite
 * tourne sous Bun, donc `process.execPath` est `bun` — et Bun résout
 * `./x.js` vers `./x.ts` et efface les types nativement. Lancer le script avec
 * lui testerait Bun, c'est-à-dire exactement ce que le script prétend **ne**
 * pas dépendre. `bun` échoue aussi sur la résolution : le test doit donc trouver
 * `node` par lui-même.
 */
const NODE = Bun.which("node")
if (NODE === null) {
  throw new Error("node est requis pour tester scripts/verify-package.mjs")
}

/** Lance le script et renvoie `{ code, stdout, stderr }`. */
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
  test("le paquet intact passe, et chaque contrat est nommé", async () => {
    const { code, stdout } = await run()
    // ⚠️ Ce test échouerait si le script contenait la moindre syntaxe
    // TypeScript non effaçable (une « parameter property », par exemple) :
    // Node n'efface les types qu'il sait effacer, et l'échec serait un
    // `SyntaxError` sans rapport avec le contrat — d'où la valeur de le
    // lancer par le **binaire Node** plutôt que par `process.execPath`.
    expect(code).toBe(0)
    // Les quatre contrats demandés, un par un, avec leur nom de champ.
    expect(stdout).toContain("default.setup")
    expect(stdout).toContain("model")
    expect(stdout).toContain("Provider.Info.package")
    expect(stdout).toContain("contrat du paquet vérifié")
  })

  test("le script n'utilise aucune API Bun, et vit dans un `.mjs`", async () => {
    // La raison d'être de ce script est precisely de tourner chez qui publie,
    // dans un runtime qui n'a pas Bun. Une dépendance à `Bun.spawn` ou
    // `Bun.file` le ferait échouer *avant* le premier contrôle — le pire endroit
    // pour un garde-fou.
    expect(SCRIPT.endsWith(".mjs")).toBe(true)
    const source = await readFile(SCRIPT, "utf8")
    // Ni l'identifiant global `Bun`, ni un shebang bun, ni un import interne.
    expect(source).not.toMatch(/\bBun\s*[.[]/)
    expect(source.startsWith("#!/usr/bin/env node")).toBe(true)
    // Le crochet de résolution est bien présent, sinon l'import échouerait sur
    // le premier `./x.js` et le message parlerait de résolution, pas de contrat.
    expect(source).toContain("resolve-ts-extensions.mjs")
    expect(HOOK.endsWith(".mjs")).toBe(true)
  })

  test("`prepack` est bien branché, et il échoue si la vérification échoue", async () => {
    const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as {
      scripts?: Record<string, string>
    }
    expect(manifest.scripts?.["verify:package"]).toBe("node scripts/verify-package.mjs")
    expect(manifest.scripts?.["prepack"]).toContain("verify:package")
  })

  test("le crochet de résolution ne réécrit que ce qui doit l'être", async () => {
    // Le crochet ne doit toucher **que** les spécificateurs relatifs en `.js`
    // dont un `.ts` existe : une dépendance qui s'appelle `x.js` doit rester
    // intacte, sinon le paquet chargerait la mauvaise dépendance.
    const probe = [
      `const hook = await import(${JSON.stringify(HOOK)})`,
      'const cases = ["./core/prompt.js", "../core/prompt.js", "effect", "./agent.js", "/abs.js"]',
      // `src/acp/` : `../core/prompt.ts` existe, `./core/prompt.ts` non plus.
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
        // `src/acp/core/prompt.ts` n'existe pas ⇒ on ne réécrit pas.
        "./core/prompt.js",
        // `src/core/prompt.ts` existe ⇒ réécriture.
        "../core/prompt.ts",
        // Un paquet nu n'est jamais réécrit.
        "effect",
        // `src/acp/agent.ts` existe ⇒ réécriture.
        "./agent.ts",
        // Un chemin absolu n'est jamais réécrit.
        "/abs.js",
      ])
    } finally {
      await rm(probePath, { recursive: true, force: true })
    }
  })

  test("un champ falsifié est nommé dans le message d'échec", async () => {
    // On ne casse pas le `package.json` du dépôt : on en fait une copie dans un
    // répertoire temporaire, avec le même script pointé dessus. Le script
    // détermine sa racine **depuis son propre emplacement**, donc on copie les
    // deux, et on n'altère que le manifeste.
    const scratch = await mkdtemp(join(tmpdir(), "acp-verify-"))
    const root = fileURLToPath(new URL("..", import.meta.url))
    try {
      const { cp } = await import("node:fs/promises")
      await cp(join(root, "scripts"), join(scratch, "scripts"), { recursive: true })
      // Les points d'entrée doivent exister *dans la racine copiée* : on n'en
      // copie que le `package.json` falsifié et un `src/` minimal.
      await cp(join(root, "src"), join(scratch, "src"), { recursive: true })
      const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as Record<string, unknown>
      const exportsField = manifest["exports"] as Record<string, string>
      manifest["exports"] = { ...exportsField, ".": "./src/inexistant.ts" }
      await writeFile(join(scratch, "package.json"), JSON.stringify(manifest, null, 2), "utf8")

      const { code, stderr } = await run(join(scratch, "scripts", "verify-package.mjs"), scratch)
      expect(code).not.toBe(0)
      // Le champ fautif est nommé, et le résumé les récapitule.
      expect(stderr).toContain('exports["."]')
      expect(stderr).toContain("champ(s) en défaut")
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
