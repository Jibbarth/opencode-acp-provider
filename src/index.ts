/**
 * The **provider** entry point.
 *
 * This is the module the `package` field of a `Provider.Info` makes the
 * OpenCode server import. Its contract is minimal - a single function, `model` -
 * and it must not require anything else to be exported: what matters is that the
 * server can build a `LanguageModel` knowing nothing else.
 *
 * Note: `model` is **synchronous** and can **fail**. An invalid configuration
 * is a `ProviderConfigurationError` thrown here, not a request `AIError`. That
 * is exactly `@opencode/ai`'s distinction (see `ProviderConfigurationError` in
 * `schema/errors.d.ts`), and the reason `parseSettings` returns a diagnostic
 * rather than throwing: the message must name the offending field.
 */

import { ProviderConfigurationError } from "@opencode/ai/schema/index"
import type { LanguageModel, ProviderOptions } from "@opencode/ai/schema/index"
import type { ProviderPackage } from "@opencode/ai"

import { makeRoute, PROVIDER } from "./adapters/opencode-transport.js"
import { parseSettings } from "./settings.js"
import type { AcpProviderSettings, RawProviderSettings } from "./settings.js"

/** The `ProviderPackage.Definition` contract, as OpenCode consumes it. */
export type ProviderPackageContract = ProviderPackage.Definition<
  AcpProviderSettings,
  ProviderOptions,
  undefined
>

/** The only function the OpenCode server needs to call. */
export type ModelContract = (modelID: string, settings: RawProviderSettings) => LanguageModel

/**
 * Builds the `LanguageModel` of an ACP agent model.
 *
 * Note: the route is rebuilt **on every call**. It carries the settings (the
 * `systemSuffix` reaches `body.from`, the policy reaches the spawn), and sharing
 * it between two providers would let one be driven by the other's configuration.
 * The cost is nil: a `Route` is only a description, and the agent itself is
 * cached at module level.
 */
export const model: ModelContract = (modelID, settings) => {
  const parsed = parseSettings(settings)
  if (!parsed.ok) {
    throw new ProviderConfigurationError({ provider: PROVIDER, message: parsed.message })
  }
  return makeRoute(parsed.value).model({ id: modelID })
}

/**
 * **Compile-time** check of the provider package contract: the only place a
 * drift of that contract can be caught. Otherwise it is invisible - a cheerful
 * OpenCode server would load the module, find no `model`, and fail on the first
 * chat.
 */
const _contract: ProviderPackageContract = { model }
void _contract
