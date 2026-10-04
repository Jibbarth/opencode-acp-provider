/**
 * Package entry point, as OpenCode resolves it after
 * `opencode plugin add github:<owner>/opencode-acp-provider`.
 *
 * It only re-exports the plugin surface. The provider (`src/index.ts`) stays a
 * separate module, resolved at runtime by `resolvePackageURL`: importing it here
 * would pull the whole `effect` + `@opencode/ai` stack into the plugin's load
 * path, which discovery deliberately avoids (see `src/plugin.ts`).
 */

export { default } from "./src/plugin.ts"
export { resolvePackageURL } from "./src/plugin.ts"
