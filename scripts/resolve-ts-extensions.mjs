/**
 * Crochet de résolution « `.js` → `.ts` » pour **Node** seul.
 *
 * ⚠️ Pourquoi ce fichier existe. Le projet écrit ses import internes avec
 * l'extension **compilée** (`./core/prompt.js`) alors qu'il distribue des
 * sources TypeScript : c'est la convention qui rend le code exécutable à la fois
 * par Bun (qui résout `.js` vers `.ts`) et par un bundler, et elle est vérifiée
 * à la compilation par `tsc`. Node, lui, sait effacer les types depuis la 22.6
 * mais **ne réécrit pas** les spécificateurs : sans ce crochet, importer
 * `src/plugin.ts` échoue sur le premier `import "./core/publish.js"` avec un
 * `ERR_MODULE_NOT_FOUND` qui ne dit rien du contrat du paquet.
 *
 * Ce n'est donc **pas** une invention de code : on ne touche qu'à la
 * résolution, et seulement quand le fichier `.ts` correspondant existe
 * réellement. Un `.js` légitime (une dépendance, un build) passe inchangé.
 */

import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** Un spécificateur relatif (`./x.js`, `../x.js`) — tout ce que le projet écrit. */
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
