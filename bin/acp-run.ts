#!/usr/bin/env bun
/**
 * Point d'entrée binaire de la CLI de debug : `bin/acp-run.ts`.
 *
 * Toute la logique vit dans `src/adapters/cli.ts` (couche `adapters/`) ; ce
 * fichier ne fait que lier — ce qui garde `src/` en TypeScript pur, exécutable
 * par `bun` sans étape de build.
 *
 *   bun run bin/acp-run.ts --command copilot --arg --acp --list-models
 */

import { main } from "../src/adapters/cli.js"

const code = await main(process.argv.slice(2))
process.exit(code)
