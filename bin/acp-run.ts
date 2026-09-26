#!/usr/bin/env bun
/**
 * Binary entry point of the debug CLI.
 *
 * All the logic lives in `src/adapters/cli.ts`; this file only wires it up,
 * which keeps `src/` pure TypeScript, runnable by `bun` with no build step.
 *
 *   bun run bin/acp-run.ts --command copilot --arg --acp --list-models
 */

import { main } from "../src/adapters/cli.js"

const code = await main(process.argv.slice(2))
process.exit(code)
