/**
 * Le plugin OpenCode — PLAN.md §6 : c'est lui qui rend le provider visible.
 *
 * Il fait trois choses, et **rien d'autre** :
 *
 * 1. lit `ctx.options` (les agents déclarés dans `opencode.jsonc`) ;
 * 2. lance l'agent ACP, lit son inventaire de `configOptions` (§5), et
 *    l'enregistre dans le catalogue : un `Provider.Info` + un `Model.Info` par
 *    modèle ;
 * 3. surveille le flux d'événements d'OpenCode et **republie** quand
 *    l'inventaire a bougé, puis ferme l'agent au déchargement.
 *
 * ⚠️ **Aucune de ces étapes ne peut faire tomber le chargement d'OpenCode.**
 * Un plugin qui lève dans `setup` n'est pas « un plugin en défaut » : c'est une
 * liste de plugins qui refuse de démarrer, et l'utilisateur perd jusqu'à ses
 * autres plugins. Toute erreur est donc journalisée et ramenée à « rien n'est
 * enregistré » — un provider absent se voit, un serveur mort ne se voit pas.
 *
 * ⚠️ Ce fichier est le **seul** du projet à dépendre de `@opencode/plugin` :
 * toute la logique de transformation est dans `core/publish.ts`, qui n'en
 * dépend pas, et se teste donc sans hôte.
 *
 * ⚠️ `@opencode/plugin` est en `devDependencies` : au chargement, c'est
 * l'hôte qui le fournit (comme `@opencode/ai` au moment d'un `importPackage`).
 * Sa version suit celle du **CLI** — d'où `2.0.16` et non le `2.0.3` du §0 du
 * plan, dont le `Context` expose un domaine `catalog` que le serveur 2.0.16
 * n'implémente pas.
 */

import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { Model, Plugin, Provider } from "@opencode/plugin"

import { createAcpAgent } from "./acp/agent.js"
import type { AcpAgent, Inventory } from "./core/types.js"
import {
  PROVIDER_ID,
  inventorySignature,
  inventoryToModels,
  parsePluginConfig,
  providerInfo,
  providerSettingsOf,
} from "./core/publish.js"
import type { PublishOptions, RawModelInfo, RawProviderInfo } from "./core/publish.js"
import { parseSettings } from "./settings.js"

// ─────────────────────────────────────────────────────────────────────────────
// Types de l'API plugin
// ─────────────────────────────────────────────────────────────────────────────

/** Le contexte que l'hôte construit et passe à `setup`. */
type Context = Plugin.Context

/**
 * L'éditeur de catalogue, et l'enregistrement qu'un `transform` renvoie.
 *
 * ⚠️ Ni `ProviderEditor` ni `Registration` ne sont réexportés par la racine de
 * `@opencode/plugin` : on les **déduit** du `Context` plutôt que de les
 * recopier. Une recopie serait un second contrat à maintenir, et c'est
 * précisément le genre de dérive qu'un changement de version d'OpenCode doit
 * faire échouer à la compilation.
 */
type ProviderEditor = Parameters<Parameters<Context["provider"]["transform"]>[0]>[0]
type Registration = Awaited<ReturnType<Context["provider"]["transform"]>>

// ─────────────────────────────────────────────────────────────────────────────
// Journalisation
// ─────────────────────────────────────────────────────────────────────────────

const PLUGIN_ID = "opencode-acp-provider"

/**
 * Une ligne de journal, préfixée.
 *
 * ⚠️ `ctx.app` ne donne que `{ name, version, channel }` : l'API plugin n'a
 * **pas** de logger. `stderr` est donc le canal — c'est aussi celui qu'utilise
 * déjà l'agent ACP (§8.c), et le seul qui survive à un `setup` qui échoue.
 */
const log = (message: string): void => {
  process.stderr.write(`[${PLUGIN_ID}] ${message}\n`)
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// ─────────────────────────────────────────────────────────────────────────────
// URL du package provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * URL `file://` **absolue** du module exportant `model` (§3.1).
 *
 * ⚠️ Elle est calculée **depuis `import.meta.url`**, jamais écrite en dur : c'est
 * la seule façon de marcher à la fois en développement (le plugin est
 * `src/plugin.ts`) et installé (il est `dist/plugin.js` dans `node_modules`). Un
 * chemin figé marche dans un cas sur deux, et échoue dans l'autre avec un
 * `ERR_MODULE_NOT_FOUND` **au premier tour** — très tard, et sans rapport avec la
 * configuration.
 *
 * ⚠️ L'ordre des candidats suit la disposition réelle du paquet : le plugin et le
 * provider sont deux fichiers du **même répertoire** dans les deux layouts (le
 * build écrit tout dans `dist/`, le dépôt vit dans `src/`). On teste donc
 * l'existence au lieu de deviner, et le `.js` compilé passe avant le `.ts` : c'est
 * lui que l'hôte doit importer, et charger les deux ferait vivre deux caches
 * de process agent distincts dans le même serveur.
 */
export const resolvePackageURL = (moduleURL: string): string => {
  const here = dirname(fileURLToPath(moduleURL))
  const candidates = [
    resolve(here, "index.js"),
    resolve(here, "..", "dist", "index.js"),
    resolve(here, "index.ts"),
    resolve(here, "..", "src", "index.ts"),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    // Un `package` qui ne pointe sur rien ne doit pas être enregistré : le
    // provider apparaîtrait dans `/model` et échouerait au premier prompt. On
    // nomme les quatre chemins cherchés, parce que « package introuvable » sans
    // la liste des candidats est un diagnostic inutilisable.
    throw new Error(
      `aucun point d'entrée provider trouvé (cherché : ${candidates.join(", ")}) ; ` +
        "le plugin doit être installé avec ses sources, ou built vers dist/.",
    )
  }
  return pathToFileURL(found).href
}

// ─────────────────────────────────────────────────────────────────────────────
// Formes brutes → formes typées
// ─────────────────────────────────────────────────────────────────────────────

/** Le `Model.Info` que `/model` affiche, bâti sur les défauts du schéma. */
const toModelInfo = (providerID: Provider.ID, raw: RawModelInfo): Model.Info => {
  const base = Model.Info.default(providerID, Model.ID.make(raw.id))
  return {
    ...base,
    name: raw.name,
    // ⚠️ `Model.Info.default` annonce `input: ["text", "image"]` : on **écrase**,
    // parce que le réducteur ne sait rendre que du texte (cf. `core/publish`).
    capabilities: {
      tools: raw.capabilities.tools,
      input: [...raw.capabilities.input],
      output: [...raw.capabilities.output],
    },
    limit: { context: raw.limit.context, output: raw.limit.output },
    // `cost` reste vide : ACP ne publie aucun tarif. Inventer un prix afficherait
    // un coût par tour sans rapport avec la facture réelle.
    variants: raw.variants.map((variant) => ({
      id: Model.VariantID.make(variant.id),
      settings: { ...variant.settings },
    })),
  }
}

/** Le `Provider.Info` enregistré, bâti sur `Provider.Info.empty(id)`. */
const toProviderInfo = (raw: RawProviderInfo): Provider.Info => ({
  ...Provider.Info.empty(Provider.ID.make(raw.id)),
  name: raw.name,
  activation: raw.activation,
  package: raw.package,
  settings: { ...raw.settings },
})

/** Ce qu'on donne à `editor.add()` : le provider et tous ses modèles. */
interface Publication {
  readonly info: Provider.Info
  readonly models: readonly Model.Info[]
}

const publish = (options: PublishOptions, packageURL: string, inventory: Inventory): Publication => {
  const providerID = Provider.ID.make(PROVIDER_ID)
  return {
    info: toProviderInfo(providerInfo(options, packageURL)),
    models: inventoryToModels(inventory, options).map((raw) => toModelInfo(providerID, raw)),
  }
}

/**
 * Enregistre (ou réenregistre) le provider dans le catalogue.
 *
 * ⚠️ `editor.add` **remplace** l'entrée dont l'`id` est `info.id` : réenregistrer
 * est donc idempotent, et c'est ce qui rend le rafraîchissement possible sans
 * jamais dupliquer le provider. `dispose` reste nécessaire pour que la
 * transformation précédente cesse de contribuer au catalogue.
 */
const register = (ctx: Context, publication: Publication): Promise<Registration> =>
  ctx.provider.transform((editor: ProviderEditor) => {
    editor.add({ info: publication.info, models: publication.models })
  })

// ─────────────────────────────────────────────────────────────────────────────
// Rafraîchissement de l'inventaire
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rafraîchit le catalogue quand l'inventaire de l'agent a bougé.
 *
 * ⚠️ **Déclenchement par événement, pas par polling.** L'inventaire ACP change
 * quand l'agent change de modèle — donc pendant un tour. Le seul signal
 * d'OpenCode qui suit un tour terminé est `session.idle` : on s'y accroche, et un
 * garde-fou de temps (`refreshMs`) borne le nombre de redécouvertes. Sans ce
 * garde-fou, une session très active ouvrirait une session ACP par tour.
 *
 * ⚠️ Ce que le rafraîchissement **ne** fait pas : observer les `config_option_update` des
 * sessions du transport. Le contrat portable `AcpSession` (§2.1) ne les expose
 * que pendant un `prompt()`, et cette session-ci n'en fait jamais. Rouvrir une
 * session jetable est donc la seule voie honnête aujourd'hui ; P6 branchera le
 * rafraîchissement sur le flux de l'adaptateur, qui les voit déjà.
 *
 * ⚠️ `ctx.event.subscribe` **ignore ses options** côté serveur 2.0.16 (le
 * `signal` n'est pas transmis) : l'annulation passe donc aussi par
 * `iterator.return()`, sinon l'itérateur resterait en attente après le
 * déchargement du plugin.
 *
 * Renvoie la fonction d'arrêt.
 */
const watch = (ctx: Context, refreshMs: number, refresh: () => Promise<void>): (() => void) => {
  if (refreshMs === 0) {
    log("rafraîchissement désactivé (refreshMs: 0)")
    return () => {}
  }

  const controller = new AbortController()
  const iterator = ctx.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastRun = 0

  /** Programme une passe, sans jamais en empiler deux. */
  const schedule = (): void => {
    if (stopped || timer !== undefined) return
    const wait = Math.max(0, lastRun + refreshMs - Date.now())
    timer = setTimeout(() => {
      timer = undefined
      if (stopped) return
      lastRun = Date.now()
      refresh().catch((error: unknown) => log(`rafraîchissement ignoré : ${reason(error)}`))
    }, wait)
    // Le timer ne doit pas, à lui seul, garder le process en vie.
    timer.unref?.()
  }

  const pump = async (): Promise<void> => {
    try {
      for (;;) {
        const next = await iterator.next()
        if (next.done === true) return
        // Un tour qui vient de finir est le seul moment où l'agent a pu changer
        // son inventaire de modèles ou de niveaux d'effort.
        if (next.value.type === "session.idle") schedule()
      }
    } catch (error) {
      if (!stopped) log(`flux d'événements interrompu, rafraîchissement arrêté : ${reason(error)}`)
    }
  }
  void pump()

  return () => {
    stopped = true
    controller.abort()
    if (timer !== undefined) clearTimeout(timer)
    void iterator.return?.(undefined)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Le plugin
// ─────────────────────────────────────────────────────────────────────────────

export default Plugin.define({
  id: PLUGIN_ID,

  async setup(ctx) {
    // ── 1. Options ──────────────────────────────────────────────────────────
    const parsed = parsePluginConfig(ctx.options)
    if (!parsed.ok) {
      log(`configuration ignorée : ${parsed.message}`)
      return
    }
    const { agents, refreshMs } = parsed.value
    const agent = agents[0]
    if (agent === undefined) return

    // ⚠️ Un seul agent est enregistré en P3a, et c'est le **premier** : la route
    // porte un `provider` fixe (`adapters/opencode-transport.ts`), donc un
    // second provider porterait le même id. Plutôt que le publier en silence, on
    // le dit — et on nomme les agents ignorés.
    for (const ignored of agents.slice(1)) {
      log(`agent « ${ignored.id} » ignoré : un seul provider ACP est supporté en P3a`)
    }

    // Les settings sont validés **avant** tout spawn, avec les règles exactes que
    // `model()` appliquera à chaque tour : un `command` absent doit échouer ici,
    // avec son chemin, pas au premier prompt.
    const settings = parseSettings(providerSettingsOf(agent))
    if (!settings.ok) {
      log(`agent « ${agent.id} » ignoré : ${settings.message}`)
      return
    }

    // ── 2. Point d'entrée du package provider ──────────────────────────────
    let packageURL: string
    try {
      packageURL = resolvePackageURL(import.meta.url)
    } catch (error) {
      log(reason(error))
      return
    }

    // ── 3. Lancement de l'agent ─────────────────────────────────────────────
    // ⚠️ C'est un **second** process, distinct de celui que le transport lancera
    // par `model()`. On ne partage pas le cache de `opencode-transport.ts` : y
    // emprunter chargerait toute la pile `effect` + `@opencode/ai` dès le
    // chargement du plugin — dans le process du serveur — pour un simple relevé.
    let acp: AcpAgent
    try {
      acp = await createAcpAgent({
        command: settings.value.command,
        ...(settings.value.args === undefined ? {} : { args: settings.value.args }),
        ...(settings.value.cwd === undefined ? {} : { cwd: settings.value.cwd }),
        ...(settings.value.env === undefined ? {} : { env: settings.value.env }),
        // Pas de `policy` : le défaut de `createAcpAgent` est `denyAllPermissions`
        // (mode « cerveau brut », §7.4). Le plugin ne fait que de la découverte,
        // il n'ouvre aucun tour — mais il ne doit pas pouvoir faire mieux.
      })
    } catch (error) {
      log(`agent « ${agent.id} » indisponible, provider non enregistré : ${reason(error)}`)
      return
    }

    const options: PublishOptions = {
      label: `ACP — ${acp.info.name}`,
      settings: providerSettingsOf(agent),
      ...(agent.limits === undefined ? {} : { limits: agent.limits }),
    }

    // ── 4. Découverte ───────────────────────────────────────────────────────
    // `AcpAgent.inventory()` ouvre une session jetable, lit, referme : le relevé
    // est donc toujours frais, ce qui est justement le défaut signalé au §5.2
    // (19 valeurs au premier `session/new`, 20 après un `set_config_option`).
    let inventory: Inventory
    try {
      inventory = await acp.inventory()
    } catch (error) {
      await acp.close()
      log(`inventaire illisible pour « ${agent.id} », provider non enregistré : ${reason(error)}`)
      return
    }
    if (inventory.models.length === 0) {
      await acp.close()
      log(`« ${agent.id} » ne propose aucun modèle, provider non enregistré`)
      return
    }
    // On journalise le relevé **brut** : le nombre publié peut être plus petit
    // (`auto` est filtré), et c'est l'écart entre les deux qui dit si l'agent a
    // proposé autre chose que des modèles.
    log(
      `${acp.info.name} v${acp.info.version} (${agent.id}) : ${inventory.models.length} valeur(s) de ` +
        `modèle, ${inventory.thoughtLevels.length} niveau(s) d'effort`,
    )

    // ── 5. Enregistrement ───────────────────────────────────────────────────
    // ⚠️ Un `transform` rejeté laisserait l'agent ACP vivant sans rien nettoyer
    // derrière lui : on le ferme avant de rendre la main, et on journalise. Le
    // principe « jamais faire tomber le chargement d'OpenCode » vaut aussi pour
    // cette étape.
    let registration: Registration
    try {
      registration = await register(ctx, publish(options, packageURL, inventory))
    } catch (error) {
      await acp.close()
      log(`enregistrement refusé par l'hôte, provider non enregistré : ${reason(error)}`)
      return
    }
    let signature = inventorySignature(inventory)

    // ── 6. Rafraîchissement ─────────────────────────────────────────────────
    const stop = watch(ctx, refreshMs, async () => {
      const next = await acp.inventory()
      const nextSignature = inventorySignature(next)
      // ⚠️ Rien n'a changé : on ne touche à rien. `ctx.provider.reload()`
      // reconstruit tout le catalogue, donc l'appeler sans raison ferait perdre
      // la sélection en cours dans `/model` pour un inventaire identique.
      if (nextSignature === signature) return
      log(`inventaire modifié : ${next.models.length} modèle(s)`)
      // On n'enregistre le nouveau qu'**avant** de disposer l'ancien : si
      // l'enregistrement échoue, le catalogue précédent reste en place et `/model`
      // continue de fonctionner avec un inventaire daté mais valide.
      const fresh = await register(ctx, publish(options, packageURL, next))
      await registration.dispose()
      registration = fresh
      signature = nextSignature
      await ctx.provider.reload()
    })

    // ── 7. Déchargement ─────────────────────────────────────────────────────
    // ⚠️ L'ordre compte : on arrête le watcher **avant** l'agent, sinon une
    // redécouverte en vol échouerait sur un agent déjà mort — et cette erreur
    // masquerait la cause réelle, celle de l'arrêt. Le `finally` est la seule
    // garantie que l'agent est tué, même si `dispose` échoue.
    return async () => {
      stop()
      try {
        await registration.dispose()
      } finally {
        await acp.close()
      }
    }
  },
})
