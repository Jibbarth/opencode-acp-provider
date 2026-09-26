/**
 * The `.js` -> `.ts` resolution hook, for **Node** only.
 *
 * Note: why this file exists. The project writes its internal imports with the
 * **compiled** extension (`./core/prompt.js`) while it ships TypeScript sources:
 * that is the convention making the code runnable both by Bun (which resolves
 * `.js` to `.ts`) and by a bundler, and it is checked at compile time by `tsc`.
 * Node, on the other hand, has stripped types since 22.6 but does **not** rewrite
 * specifiers: without this hook, importing `src/plugin.ts` fails on the first
 * `import "./core/publish.js"` with an `ERR_MODULE_NOT_FOUND` that says nothing
 * about the package contract.
 *
 * This is therefore **not** a code invention: only resolution is touched, and
 * only when the matching `.ts` file really exists. A legitimate `.js` (a
 * dependency, a build) passes through unchanged.
 */

import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** A relative specifier (`./x.js`, `../x.js`) - everything the project writes. */
const isRelative = (specifier) => specifier.startsWith("./") || specifier.startsWith("../")

export const resolve = (specifier, context, nextResolve) => {
  if (isRelative(specifier) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const base = specifier.slice(0, -".js".length)
    const candidate = new URL(`${base}.ts`, context.parentURL)
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(`${base}.ts`, context)
    }
  }
  return nextResolve(specifier, context)
}
