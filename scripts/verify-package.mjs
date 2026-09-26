#!/usr/bin/env node
/**
 * `verify:package` - **run** the package to check its contract.
 *
 * Inspired by `opencode-acpx`'s `prepack` (MIT), which really imports its entry
 * points instead of reading their code. The idea is simple and daunting:
 *
 *   - an entry point that does not export what OpenCode calls produces **no**
 *     error at load time - the server imports the module, does not find `model`
 *     (or `setup`), and the first chat fails;
 *   - a `package` field pointing at a relative `file://`, or at a file that does
 *     not exist, produces **no** error either - the provider shows up in
 *     `/model`, and it is on the first turn that an `ERR_MODULE_NOT_FOUND`
 *     unrelated to the configuration is discovered.
 *
 * Neither is catchable at runtime: they have to be checked **before**
 * publication, by executing the module.
 *
 * Note: **Node, not Bun**, and deliberately so: this script is wired to
 * `prepack`, so it runs wherever the package is published, in a CI that has no
 * Bun installed. To import TypeScript sources without a bundler, it needs two
 * things Bun does natively and Node does not:
 *
 *   1. stripping types - Node has done that since 22.6;
 *   2. resolving `./x.js` to `./x.ts` - that is the role of the
 *      `scripts/resolve-ts-extensions.mjs` hook, registered below.
 *
 * The `ProviderPackage.Definition` contract stays checked **at compile time**
 * (`src/index.ts`); this script only checks it **at runtime**, which `tsc`
 * cannot do.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { register } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, resolve } from "node:path"

register("./resolve-ts-extensions.mjs", import.meta.url)

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** The checks that failed, so that **all** their fields can be reported at once. */
const failures = []

/**
 * Records a failure, naming the offending **field**.
 *
 * Note: the field name is the essential part of the message. "contract
 * violation" without it says nothing about where to look, and the user is not
 * going to read the script.
 */
const fail = (field, message) => {
  failures.push({ field, message })
  console.error(`[échec] ${field} : ${message}`)
}

const check = (field, ok, message) => {
  if (ok) {
    console.log(`  [ok] ${field} : ${message}`)
    return ok
  }
  fail(field, message)
  return false
}

/** The package's `package.json`, read from the repository root. */
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))

/**
 * The **actually published** entry path of an `exports` subpath.
 *
 * `exports` is read rather than a hardcoded constant: it is the contract the
 * host will resolve, hence the only one that counts. A path that is valid here
 * but absent from `exports` will never be loaded by OpenCode.
 */
const entryOf = (subpath) => {
  const value = manifest.exports?.[subpath]
  if (typeof value !== "string" || value === "") {
    fail(`exports["${subpath}"]`, `absent ou non textuel dans package.json (trouvé : ${JSON.stringify(value)})`)
    return undefined
  }
  const path = resolve(root, value)
  if (!existsSync(path)) {
    fail(`exports["${subpath}"]`, `${value} est déclaré mais le fichier n'existe pas`)
    return undefined
  }
  return pathToFileURL(path).href
}

console.log(`# paquet   : ${manifest.name}@${manifest.version}`)
console.log(`# racine   : ${root}`)

const pluginURL = entryOf("./plugin")
const providerURL = entryOf(".")

if (pluginURL === undefined || providerURL === undefined) {
  console.error(
    `\n[échec] contrat du paquet : ${failures.length} champ(s) en défaut : ` +
      failures.map((f) => f.field).join(", "),
  )
  process.exit(1)
}

// ── 1. The plugin entry point exports a `setup` ───────────────────────────────

console.log(`\n# point d'entrée plugin : ${pluginURL}`)
let plugin
try {
  plugin = await import(pluginURL)
} catch (error) {
  fail("plugin (import)", `l'import a échoué : ${error?.message ?? String(error)}`)
}

if (plugin !== undefined) {
  check(
    "default.setup",
    typeof plugin.default?.setup === "function",
    typeof plugin.default?.setup === "function"
      ? "la fonction que l'hôte appelle au chargement est présente"
      : `l'hôte appelle \`mod.default.setup()\` et a trouvé ${typeof plugin.default?.setup}`,
  )
  check(
    "default.id",
    typeof plugin.default?.id === "string" && plugin.default.id.length > 0,
    `identifiant du plugin : ${JSON.stringify(plugin.default?.id)}`,
  )
}

// ── 2. The provider entry point exports a `model` ────────────────────────────

console.log(`\n# point d'entrée provider : ${providerURL}`)
let provider
try {
  provider = await import(providerURL)
} catch (error) {
  fail("provider (import)", `l'import a échoué : ${error?.message ?? String(error)}`)
}

if (provider !== undefined) {
  check(
    "model",
    typeof provider.model === "function",
    typeof provider.model === "function"
      ? "la fonction que l'hôte appelle pour construire un LanguageModel est présente"
      : `le champ \`package\` de Provider.Info n'a pas de \`model\` à appeler (trouvé : ${typeof provider.model})`,
  )
}

// ── 3. The `package` field's URL is absolute, `file://`, and exists ──────────

console.log("\n# champ Provider.Info.package")
if (plugin !== undefined && typeof plugin.resolvePackageURL === "function") {
  // The plugin's **function** is called, with the **plugin module's** URL: that
  // is literally the computation `setup` performs, not a re-derivation that
  // could drift from it.
  let computed
  try {
    computed = plugin.resolvePackageURL(pluginURL)
  } catch (error) {
    fail("Provider.Info.package", `le calcul a échoué : ${error?.message ?? String(error)}`)
  }
  if (typeof computed === "string") {
    check(
      "Provider.Info.package",
      computed.startsWith("file://"),
      `URL absolue : ${computed}`,
    )
    let target
    try {
      target = fileURLToPath(computed)
    } catch (error) {
      fail("Provider.Info.package", `ce n'est pas une URL de fichier exploitable : ${error?.message ?? String(error)}`)
    }
    if (target !== undefined) {
      check(
        "Provider.Info.package",
        existsSync(target),
        `le fichier existe : ${target}`,
      )
      // Note: **the single instance.** If the computed URL does not designate the
      // same file as `exports["."]`, the host loads **two** modules: two
      // `LanguageModel`s, two `Usage` classes, and an `instanceof` that fails
      // with a message indistinguishable from a stream truncation. That is the
      // "double instance" risk, and it shows up here, in one comparison.
      check(
        "Provider.Info.package",
        target === fileURLToPath(providerURL),
        `désigne le même module que exports["."] (${target === fileURLToPath(providerURL) ? "oui" : `non : ${target} ≠ ${fileURLToPath(providerURL)}`})`,
      )
    }
  }
} else {
  fail(
    "resolvePackageURL",
    "le plugin n'exporte pas resolvePackageURL : impossible de vérifier le champ `package`",
  )
}

// ── Verdict ───────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n[échec] ${failures.length} champ(s) en défaut : ${failures.map((f) => f.field).join(", ")}`)
  process.exit(1)
}
console.log("\n[ok] contrat du paquet vérifié : les deux points d'entrée s'importent et exposent leur contrat.")
