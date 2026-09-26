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

/** Le message d'une erreur quelconque, sans sa pile : c'est un journal, pas un rapport. */
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Marqueur « le module a été évalué » — §14, R4.
 *
 * ⚠️ **Pourquoi cette ligne est hors de `setup` — et c'est tout l'intérêt.**
 * Un package de plugin qui ne se charge ne produit **aucune** erreur visible :
 * l'hôte journalise « plugin ignoré » et n'insiste pas, et le fichier
 * `opencode.jsonc` pointe peut-être vers le mauvais chemin, ou le module lève
 * pendant son évaluation, ou `Plugin.define` n'est même pas atteint. Toutes ces
 * fins se ressemblent — un plugin absent, silencieusement.
 *
 * Il faut donc distinguer deux situations que rien ne distingue aujourd'hui :
 *
 *   · **le module n'a jamais été évalué** — cette ligne n'est jamais parue ;
 *   · **`setup()` a levé** — le `try/catch` de `setup` l'a journalisé, et cette
 *     ligne **est** parue juste avant.
 *
 * Une seule ligne, écrite au moment exact où le module est évalué, suffit à
 * faire la différence. Elle est volontairement **discrète** : c'est un
 * diagnostic, pas un rapport, et un serveur qui charge cent plugins ne doit pas
 * écrire cent lignes de plus dans son journal.
 */
log(`module évalué : ${import.meta.url}`)

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
// Bornes de la découverte — §14, R7
// ─────────────────────────────────────────────────────────────────────────────

/** Un dépassement de borne, avec la borne fautive et son terme. */
class DiscoveryTimeout extends Error {
  /**
   * ⚠️ Champs **déclarés explicitement**, comme `AcpAgentError` : la forme
   * « parameter property » est du TypeScript que l'effacement de types de Node
   * ne sait pas traiter, et ce fichier est dans le graphe d'import du point
   * d'entrée plugin — donc dans celui de `npm run verify:package`.
   */
  readonly reason: "silence" | "délai"
  readonly limitMs: number

  constructor(reason: "silence" | "délai", limitMs: number) {
    super(
      reason === "silence"
        ? `aucun signe de vie pendant ${limitMs} ms`
        : `délai de ${limitMs} ms dépassé`,
    )
    this.name = "DiscoveryTimeout"
    this.reason = reason
    this.limitMs = limitMs
  }
}

/**
 * Course une promesse contre **deux** bornes : un délai global, et un délai
 * d'inactivité remis à zéro par `beat()`.
 *
 * ⚠️ **Pourquoi deux, et pas une.** Un agent muet et un agent bavard sont deux
 * pannes différentes. Une seule borne les traite identiquement : elle les laisse
 * tous les deux attendre son terme, alors que la seconde est invisible — elle ne
 * produit aucun message, juste un chargement qui ne finit pas. La borne
 * d'inactivité rend la question utile : **l'agent parle-t-il encore ?** C'est la
 * seule information disponible pendant une découverte, et elle suffit à
 * distinguer « il met quatre-vingt-dix secondes à démarrer » (légitime, et son
 * stderr le dit) de « il est bloqué ».
 *
 * ⚠️ **Les deux minuteurs sont vidés dès que la course est décidée**, dans les
 * deux sens. Un minuteur laissé armé ne fait pas qu'attendre : il retient le
 * process du serveur OpenCode en vie pendant toute la durée du service, pour
 * rien — et il finirait par rejeter une promesse déjà résolue, donc par produire
 * une rejection orpheline.
 */
const withBounds = <A>(
  work: Promise<A>,
  timeoutMs: number,
  idleTimeoutMs: number,
): { readonly result: Promise<A>; readonly beat: () => void } => {
  let idle: ReturnType<typeof setTimeout> | undefined
  let overall: ReturnType<typeof setTimeout> | undefined
  /** Une fois la course décidée, `beat` devient neutre : plus rien à réarmer. */
  let armed = true

  const rearm = (): void => {
    if (!armed) return
    if (idle !== undefined) clearTimeout(idle)
    idle = setTimeout(() => {
      if (armed) reject(new DiscoveryTimeout("silence", idleTimeoutMs))
    }, idleTimeoutMs)
    // Un minuteur ne doit pas, à lui seul, garder le process en vie.
    idle.unref?.()
  }

  let resolve: (value: A) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const result = new Promise<A>((res, rej) => {
    resolve = res
    reject = rej
  })

  rearm()
  overall = setTimeout(() => {
    if (armed) reject(new DiscoveryTimeout("délai", timeoutMs))
  }, timeoutMs)
  overall.unref?.()

  // ⚠️ Le `finally` est le **seul** endroit où les minuteurs sont vidés : il
  // s'exécute dans tous les cas de sortie — résolution, rejet du travail, ou
  // dépassement d'une des deux bornes. C'est exactement ce que le §14 demande,
  // et c'est invisible dans une écriture qui vide « quand ça marche ».
  void work.then(
    (value) => {
      if (!armed) return
      resolve(value)
    },
    (error: unknown) => {
      if (!armed) return
      reject(error)
    },
  ).finally(() => {
    armed = false
    if (idle !== undefined) clearTimeout(idle)
    if (overall !== undefined) clearTimeout(overall)
    idle = undefined
    overall = undefined
  })

  return { result, beat: rearm }
}

/** Ce que la découverte borne : l'agent, et son relevé d'inventaire. */
interface Discovery {
  readonly agent: AcpAgent
  /** L'inventaire, lu sous les mêmes bornes et le même compteur d'inactivité. */
  readonly inventory: () => Promise<Inventory>
}

/**
 * Lance l'agent, relève son inventaire, le tout **borné**.
 *
 * ⚠️ **Le process ne doit jamais survivre à l'abandon.** `createAcpAgent` ne rend
 * la main qu'après `initialize` : si une borne expire avant, sa promesse est
 * encore **en vol**, et l'agent qu'elle produira sera vivant… sans personne pour
 * le fermer. D'où le `pending.then(close)` de chaque sortie en erreur : un agent
 * lent qui finit quand même par démarrer est tué dès qu'il existe, au lieu de
 * laisser un orphelin par chargement de plugin.
 */
const discover = async (
  options: Parameters<typeof createAcpAgent>[0],
  timeoutMs: number,
  idleTimeoutMs: number,
): Promise<Discovery> => {
  // Le compteur d'inactivité est alimenté par le **stderr** de l'agent : c'est
  // le seul flux observable depuis l'extérieur pendant une découverte, et le seul
  // qui distingue un agent qui travaille d'un agent bloqué. On ne le relaie pas
  // — un agent bavard au chargement inonderait le journal du serveur —, on ne
  // fait que le remettre à zéro.
  const signals: { beat: () => void } = { beat: () => {} }
  const pending = createAcpAgent({
    ...options,
    stderr: "pipe",
    onStderr: () => signals.beat(),
    // ⚠️ Le timeout d'`initialize` est aligné sur la borne de découverte : sinon
    // l'agent dispose de 30 s pour répondre là où le plugin n'en attend que 10,
    // et la borne de découverte ne bornerait... rien du tout.
    initializeTimeoutMs: options.initializeTimeoutMs ?? timeoutMs,
  })

  const launch = withBounds(pending, timeoutMs, idleTimeoutMs)
  signals.beat = launch.beat

  let agent: AcpAgent
  try {
    agent = await launch.result
  } catch (error) {
    void pending.then((late) => late.close()).catch(() => undefined)
    throw error
  }

  return {
    agent,
    inventory: () => withBounds(agent.inventory(), timeoutMs, idleTimeoutMs).result,
  }
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

  /**
   * Point d'entrée de l'hôte.
   *
   * ⚠️ Ce `try/catch` est la **seule** garantie de l'invariant affiché en tête
   * de ce fichier : rien de ce que fait le plugin ne doit faire tomber le
   * chargement d'OpenCode. Les étapes internes ont chacune leur garde, mais une
   * exception inattendue — une API de l'hôte qui change, un `Model.Info` rejeté
   * par `Provider.Info.default` — remonterait sinon jusqu'à l'hôte, qui
   * abandonnerait le chargement du plugin **et** de tous les suivants.
   *
   * On ne peut rien distinguer d'ici sans le marqueur « module évalué » écrit
   * plus haut : c'est exactement pour ça qu'il est hors de ce `try`.
   */
  async setup(ctx) {
    try {
      return await runSetup(ctx)
    } catch (error) {
      log(`chargement abandonné, provider non enregistré : ${reason(error)}`)
      return
    }
  },
})

/** Le travail de `setup`, sans le filet : c'est `setup` qui le porte. */
async function runSetup(ctx: Context): Promise<(() => Promise<void>) | undefined> {
    // ── 1. Options ──────────────────────────────────────────────────────────
    const parsed = parsePluginConfig(ctx.options)
    if (!parsed.ok) {
      log(`configuration ignorée : ${parsed.message}`)
      return
    }
    const { agents, refreshMs, discoveryTimeoutMs, discoveryIdleTimeoutMs } = parsed.value
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
    //
    // ⚠️ Les deux étapes sont **bornées** (`discover`) : c'est le seul endroit du
    // projet où une attente peut bloquer le chargement d'OpenCode, parce que
    // l'hôte await `setup` avant de rendre la main. Un agent muet, mort ou bloqué
    // doit donner « provider non enregistré », pas « OpenCode ne démarre pas ».
    let discovered: Discovery
    try {
      discovered = await discover(
        {
          command: settings.value.command,
          ...(settings.value.args === undefined ? {} : { args: settings.value.args }),
          ...(settings.value.cwd === undefined ? {} : { cwd: settings.value.cwd }),
          ...(settings.value.env === undefined ? {} : { env: settings.value.env }),
          // Pas de `policy` : le défaut de `createAcpAgent` est `denyAllPermissions`
          // (mode « cerveau brut », §7.4). Le plugin ne fait que de la découverte,
          // il n'ouvre aucun tour — mais il ne doit pas pouvoir faire mieux.
        },
        discoveryTimeoutMs,
        discoveryIdleTimeoutMs,
      )
    } catch (error) {
      // L'erreur nomme **l'agent** : « agent indisponible » sans le nom de
      // l'agent configuré serait un diagnostic inutilisable quand la liste en
      // contient plusieurs, ou quand le défaut (`copilot`) n'est pas celui-là.
      log(`agent « ${agent.id} » indisponible, provider non enregistré : ${reason(error)}`)
      return
    }
    const acp = discovered.agent

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
      inventory = await discovered.inventory()
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
    // ⚠️ La passe de rafraîchissement passe par `discovered.inventory()` et non
    // par `acp.inventory()` : elle est donc **bornée** elle aussi. Une
    // découverte qui traîne en arrière-plan ne peut pas laisser une session ACP
    // ouverte pour toujours — et, à la.await, pas de rejet non plus.
    const stop = watch(ctx, refreshMs, async () => {
      const next = await discovered.inventory()
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
}
