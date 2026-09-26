#!/usr/bin/env node
/**
 * `verify:package` — **exécuter** le paquet pour vérifier son contrat (§14, R5).
 *
 * Inspiration : le `prepack` de `opencode-acpx` (MIT), qui importe réellement ses
 * points d'entrée au lieu de lire leur code. L'idée est simple et redoutable :
 *
 *   · un point d'entrée qui n'exporte pas ce qu'OpenCode appelle ne produit
 *     **aucune** erreur au chargement — le serveur importe le module, ne trouve
 *     pas `model` (ou `setup`), et le premier chat échoue ;
 *   · un champ `package` qui pointe sur un `file://` relatif, ou sur un fichier
 *     qui n'existe pas, ne produit **aucune** erreur non plus — le provider
 *     apparaît dans `/model`, et c'est au premier tour qu'on découvre un
 *     `ERR_MODULE_NOT_FOUND` sans rapport avec la configuration.
 *
 * Ni l'un ni l'autre n'est rattrapable à l'exécution : il faut les vérifier
 * **avant** la publication, en exécutant le module.
 *
 * ⚠️ **Node, pas Bun**, et c'est délibéré : ce script est branché sur `prepack`,
 * donc il tourne chez qui publie le paquet, dans une CI qui n'a pas Bun
 * d'installé. Pour importer des sources TypeScript sans bundler, il lui faut
 * deux choses que Bun fait nativement et Node non :
 *
 *   1. effacer les types — Node le fait depuis la 22.6 ;
 *   2. résoudre `./x.js` vers `./x.ts` — c'est le rôle du crochet
 *      `scripts/resolve-ts-extensions.mjs`, enregistré ci-dessous.
 *
 * Le contrat de `ProviderPackage.Definition` reste vérifié **à la compilation**
 * (`src/index.ts`) ; ce script ne fait que le vérifier **à l'exécution**, ce que
 * `tsc` ne peut pas faire.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { register } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, resolve } from "node:path"

register("./resolve-ts-extensions.mjs", import.meta.url)

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** Les contrôles rattrapés, pour en rapporter **tous** les champs d'un coup. */
const failures = []

/**
 * Note un échec en nommant le **champ** fautif.
 *
 * ⚠️ Le nom du champ est l'essentiel du message : « contract violation » sans
 * le nom ne dit pas où regarder, et l'utilisateur ne va pas lire le script.
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

/** Le `package.json` du paquet, lu depuis la racine du dépôt. */
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))

/**
 * Le chemin d'entrée **réellement publié** d'un sous-chemin d'`exports`.
 *
 * On lit `exports` et non une constante codée en dur : c'est le contrat que
 * l'hôte va résoudre, donc le seul qui compte. Un chemin valide ici mais absent
 * de `exports` ne sera jamais chargé par OpenCode.
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

// ── 1. Le point d'entrée plugin exporte un `setup` ───────────────────────────

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

// ── 2. Le point d'entrée provider exporte un `model` ─────────────────────────

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

// ── 3. L'URL du champ `package` est absolue, en `file://`, et existe ─────────

console.log("\n# champ Provider.Info.package")
if (plugin !== undefined && typeof plugin.resolvePackageURL === "function") {
  // On appelle la **fonction du plugin**, avec l'URL du **module du plugin** :
  // c'est littéralement le calcul que fait `setup`, pas une re-dérivation qui
  // pourrait diverger de lui.
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
      // ⚠️ **L'instance unique.** Si l'URL calculée ne désigne pas le même fichier
      // que `exports["."]`, l'hôte charge **deux** modules : deux `LanguageModel`,
      // deux classes `Usage`, et le `instanceof` du §4.0 qui échoue avec un
      // message indiscernable d'une troncature de flux. C'est le risque de
      // « double instance » du §14 (R3), et il se voit ici, en une comparaison.
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
