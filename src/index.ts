/**
 * Point d'entrée **provider** — PLAN.md §3.1.
 *
 * C'est le module que le champ `package` d'un `Provider.Info` fait importer par
 * le serveur OpenCode. Son contrat est minimal — une seule fonction, `model` —
 * et il ne doit rien exporter d'autre d'obligatoire : ce qui compte, c'est que
 * le serveur puisse construire un `LanguageModel` sans rien savoir d'autre.
 *
 * ⚠️ `model` est **synchrone** et peut **échouer** : une configuration invalide
 * est un `ProviderConfigurationError` levé ici, pas une `AIError` de requête.
 * C'est exactement la distinction d'`@opencode/ai` (voir `ProviderConfigurationError`
 * dans `schema/errors.d.ts`), et la raison pour laquelle `parseSettings` renvoie
 * un diagnostic plutôt que de lever : le message doit nommer le champ fautif.
 */

import { ProviderConfigurationError } from "@opencode/ai/schema/index"
import type { LanguageModel, ProviderOptions } from "@opencode/ai/schema/index"
import type { ProviderPackage } from "@opencode/ai"

import { makeRoute, PROVIDER } from "./adapters/opencode-transport.js"
import { parseSettings } from "./settings.js"
import type { AcpProviderSettings, RawProviderSettings } from "./settings.js"

/** Contrat `ProviderPackage.Definition` (§3.1), tel qu'OpenCode le consomme. */
export type ProviderPackageContract = ProviderPackage.Definition<
  AcpProviderSettings,
  ProviderOptions,
  undefined
>

/** La seule fonction que le serveur OpenCode a besoin d'appeler. */
export type ModelContract = (modelID: string, settings: RawProviderSettings) => LanguageModel

/**
 * Construit le `LanguageModel` d'un modèle d'agent ACP.
 *
 * ⚠️ La route est reconstruite **à chaque appel** : elle porte les settings
 * (le `systemSuffix` atteint `body.from`, la politique atteint le spawn), et les
 * partager entre deux providers reviendrait à faire commander à l'un par la
 * configuration de l'autre. Le coût est nul : une `Route` n'est qu'une
 * description, et l'agent, lui, est mis en cache au niveau module.
 */
export const model: ModelContract = (modelID, settings) => {
  const parsed = parseSettings(settings)
  if (!parsed.ok) {
    throw new ProviderConfigurationError({ provider: PROVIDER, message: parsed.message })
  }
  return makeRoute(parsed.value).model({ id: modelID })
}

/**
 * ⚠️ Vérification **à la compilation** du contrat du §3.1 : c'est le seul endroit
 * où une dérive du contrat du package provider peut être détectée, et elle
 * serait sinon invisible — un serveur OpenCode joyful chargerait le module, ne
 * trouverait pas `model`, et échouerait au premier chat.
 */
const _contract: ProviderPackageContract = { model }
void _contract
