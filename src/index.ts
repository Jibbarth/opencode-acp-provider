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

import { makeRoute, providerIdOf } from "./adapters/opencode-transport.js"
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
 *
 * Note: one module serves **every** ACP provider, which is why the provider
 * identity is read from the settings rather than fixed here. Two providers
 * pointing at the same `package` differ only by the settings OpenCode hands
 * back, so anything else would make them the same provider.
 */
export const model: ModelContract = (modelID, settings) => {
  const parsed = parseSettings(settings)
  if (!parsed.ok) {
    // The provider identity comes from the settings for the same reason the
    // route takes it from there: this function is called without any other
    // context, and an error naming `acp-copilot` is the one the user can match
    // to the provider they selected. The `typeof` guard is what makes the
    // identity readable on a configuration that was **rejected**, which is the
    // only moment it is worth reporting: a non-string `provider` has no id to
    // give, so the default stands in.
    const id = typeof settings.provider === "string" ? settings : { provider: undefined }
    throw new ProviderConfigurationError({ provider: providerIdOf(id), message: parsed.message })
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
