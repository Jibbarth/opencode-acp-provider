/**
 * The OpenCode plugin - it is what makes the providers visible.
 *
 * It does four things, and **nothing else**:
 *
 * 1. reads `ctx.options` (the agents declared in `opencode.jsonc`) and the
 *    `/connect` connection, then publishes **one provider per agent**, with one
 *    `Model.Info` per model and its own effort variants;
 * 2. launches each ACP agent and reads its `configOptions` inventory, which is
 *    what names the provider and fills its models;
 * 3. registers the `/connect` entry itself, so an agent can be added from the
 *    OpenCode UI, and resynchronises when that connection changes;
 * 4. watches OpenCode's event stream and **republishes** when an inventory has
 *    moved, then closes every agent on shutdown.
 *
 * Note: **one provider per agent**, not one provider for the list. Credentials
 * are per agent, and a single provider would have to choose: either its settings
 * name one command and the other agent is unreachable, or the transport holds
 * two agents behind one identity and OpenCode can no longer tell which model
 * belongs to which - nor which settings to hand back on the first turn. Each
 * provider therefore carries its own agent's id, inventory, variants, process and
 * pool of ACP sessions.
 *
 * Note: **none of these steps may bring down OpenCode's startup.** A plugin that
 * throws in `setup` is not "one plugin in default state": it is a list of
 * plugins refusing to start, and the user loses every other plugin too. Every
 * error is therefore logged and reduced to "nothing is registered" - an absent
 * provider is visible, a dead server is not. One agent failing costs that agent,
 * and the others are still published.
 *
 * Note: this is the **only** file in the project depending on
 * `@opencode/plugin`. All the transformation logic lives in `core/publish.ts`,
 * which does not, and is therefore testable without a host.
 *
 * Note: `@opencode/plugin` is in `devDependencies`: at load time the host
 * provides it (as it provides `@opencode/ai` at `importPackage` time). Its
 * version tracks the **CLI**, hence `2.0.16` and not `2.0.3`, whose `Context`
 * exposes a `catalog` domain the 2.0.16 server does not implement.
 */

import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { Model, Plugin, Provider } from "@opencode/plugin"
import type { Form } from "@opencode/schema/form"

import { createAcpAgent } from "./acp/agent.js"
import {
  CONNECT_FORM_FIELDS,
  CONNECT_INTEGRATION_ID,
  CONNECT_INTEGRATION_NAME,
  CONNECT_METHOD_LABEL,
  agentsFingerprint,
  connectAgentToRawAgent,
  diffAgents,
  mergeAgents,
  parseConnectCredential,
} from "./core/connect.js"
import type { AcpAgent, Inventory } from "./core/types.js"
import {
  DEFAULT_DISCOVERY_IDLE_TIMEOUT_MS,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_REFRESH_MS,
  PROVIDER_ID,
  inventorySignature,
  inventoryToModels,
  parsePluginConfig,
  providerIdOf,
  providerInfo,
  providerSettingsOf,
} from "./core/publish.js"
import type { PluginConfig, PublishOptions, RawAgent, RawModelInfo, RawProviderInfo } from "./core/publish.js"
import { parseSettings } from "./settings.js"

// ─────────────────────────────────────────────────────────────────────────────
// Plugin API types
// ─────────────────────────────────────────────────────────────────────────────

/** The context the host builds and hands to `setup`. */
type Context = Plugin.Context

/**
 * The catalogue editor, and the registration a `transform` returns.
 *
 * Note: neither `ProviderEditor` nor `Registration` is re-exported from the root
 * of `@opencode/plugin`, so they are **deduced** from the `Context` rather than
 * copied. A copy would be a second contract to maintain, and drift of that kind
 * is exactly what an OpenCode version bump should break at compile time.
 */
type ProviderEditor = Parameters<Parameters<Context["provider"]["transform"]>[0]>[0]
type Registration = Awaited<ReturnType<Context["provider"]["transform"]>>
type IntegrationEditor = Parameters<Parameters<Context["integration"]["transform"]>[0]>[0]

/** How often the `/connect` connection is re-read, in milliseconds. */
const CONNECT_POLL_MS = 5_000

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

const PLUGIN_ID = "opencode-acp-provider"

/**
 * A prefixed log line.
 *
 * Note: `ctx.app` only gives `{ name, version, channel }`: the plugin API has
 * **no** logger. `stderr` is therefore the channel - the one the ACP agent
 * already uses, and the only one that survives a `setup` that fails.
 */
const log = (message: string): void => {
  process.stderr.write(`[${PLUGIN_ID}] ${message}\n`)
}

/** An arbitrary error's message, without its stack: this is a log, not a report. */
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The "the module was evaluated" marker.
 *
 * Note: **why this line sits outside `setup` - that is the whole point.** A plugin
 * package that fails to load produces **no** visible error: the host logs
 * "plugin skipped" and moves on, and `opencode.jsonc` may point at the wrong
 * path, or the module may throw while being evaluated, or `Plugin.define` may
 * not even be reached. All those endings look the same - a plugin silently
 * absent.
 *
 * Two situations that nothing distinguishes today must therefore be told apart:
 *
 *   - **the module was never evaluated**: this line never appeared;
 *   - **`setup()` threw**: `setup`'s `try/catch` logged it, and this line
 *     **did** appear just before.
 *
 * A single line, written at the exact moment the module is evaluated, is enough
 * to tell them apart. It is deliberately **discreet**: a diagnostic, not a
 * report, and a server loading a hundred plugins must not write a hundred extra
 * lines in its log.
 */
log(`module évalué : ${import.meta.url}`)

/**
 * **Absolute** `file://` URL of the module exporting `model`.
 *
 * Note: it is computed **from `import.meta.url`**, never hardcoded. That is the
 * only way to work both in development (the plugin is `src/plugin.ts`) and
 * installed (it is `dist/plugin.js` inside `node_modules`). A frozen path works
 * in one case out of two and fails in the other with an `ERR_MODULE_NOT_FOUND`
 * **on the first turn** - very late, and unrelated to the configuration.
 *
 * Note: the candidate order follows the real package layout. The plugin and the
 * provider are two files of the **same directory** in both layouts (the build
 * writes everything into `dist/`, the repository lives in `src/`). Existence is
 * therefore tested instead of guessed, and the compiled `.js` comes before the
 * `.ts`: that is what the host must import, and loading both would keep two
 * distinct agent process caches alive in the same server.
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
    // A `package` pointing at nothing must not be registered: the provider would
    // show up in `/model` and fail on the first prompt. The four paths searched
    // are named, because "package not found" without the candidate list is an
    // unusable diagnostic.
    throw new Error(
      `aucun point d'entrée provider trouvé (cherché : ${candidates.join(", ")}) ; ` +
        "le plugin doit être installé avec ses sources, ou built vers dist/.",
    )
  }
  return pathToFileURL(found).href
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery bounds
// ─────────────────────────────────────────────────────────────────────────────

/** A bound overrun, with the offending bound and its kind. */
class DiscoveryTimeout extends Error {
  /**
   * Note: fields **declared explicitly**, as in `AcpAgentError`. The parameter
   * property form is TypeScript that Node's type stripping cannot handle, and
   * this file is in the import graph of the plugin entry point, hence in that of
   * `npm run verify:package`.
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
 * Races a promise against **two** bounds: a global delay, and an inactivity
 * delay reset by `beat()`.
 *
 * Note: **why two, not one.** A mute agent and a rambling agent are two
 * different failures. A single bound treats them identically: it makes both wait
 * out its term, whereas the second is invisible - it produces no message, just a
 * load that never finishes. The inactivity bound makes the question useful:
 * **is the agent still talking?** That is the only information available during a
 * discovery, and it is enough to tell "it takes ninety seconds to start"
 * (legitimate, and its stderr says so) from "it is stuck".
 *
 * Note: **both timers are cleared as soon as the race is decided**, in both
 * directions. A timer left armed does not merely wait: it keeps the OpenCode
 * server process alive for the whole service lifetime, for nothing - and it
 * would eventually reject an already resolved promise, producing an orphan
 * rejection.
 */
const withBounds = <A>(
  work: Promise<A>,
  timeoutMs: number,
  idleTimeoutMs: number,
): { readonly result: Promise<A>; readonly beat: () => void } => {
  let idle: ReturnType<typeof setTimeout> | undefined
  let overall: ReturnType<typeof setTimeout> | undefined
  /** Once the race is decided, `beat` becomes a no-op: nothing left to rearm. */
  let armed = true

  const rearm = (): void => {
    if (!armed) return
    if (idle !== undefined) clearTimeout(idle)
    idle = setTimeout(() => {
      if (armed) reject(new DiscoveryTimeout("silence", idleTimeoutMs))
    }, idleTimeoutMs)
    // A timer must not, on its own, keep the process alive.
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

  // The `finally` is the **only** place the timers are cleared: it runs on every
  // exit path - resolution, rejection of the work, or one of the two bounds
  // firing. It is invisible in a version that clears "when it works".
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

/** What discovery bounds: the agent, and its inventory capture. */
interface Discovery {
  readonly agent: AcpAgent
  /** The inventory, read under the same bounds and the same inactivity counter. */
  readonly inventory: () => Promise<Inventory>
}

/**
 * Launches the agent, captures its inventory, the whole thing **bounded**.
 *
 * Note: **the process must never outlive the abandonment.** `createAcpAgent`
 * only returns after `initialize`: if a bound fires first, its promise is still
 * **in flight**, and the agent it will produce will be alive with nobody to
 * close it. Hence the `pending.then(close)` on every error exit: a slow agent
 * that does eventually start is killed as soon as it exists, instead of leaving
 * one orphan per plugin load.
 */
const discover = async (
  options: Parameters<typeof createAcpAgent>[0],
  timeoutMs: number,
  idleTimeoutMs: number,
): Promise<Discovery> => {
  // The inactivity counter is fed by the agent's **stderr**: it is the only
  // stream observable from outside during a discovery, and the only one telling
  // a working agent from a stuck one. It is not relayed - a chatty agent at
  // load time would flood the server's log - only used to reset the counter.
  const signals: { beat: () => void } = { beat: () => {} }
  const pending = createAcpAgent({
    ...options,
    stderr: "pipe",
    onStderr: () => signals.beat(),
    // The `initialize` timeout is aligned on the discovery bound: otherwise the
    // agent has 30 s to answer where the plugin only waits 10, and the discovery
    // bound would bound... nothing at all.
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
// Raw shapes -> typed shapes
// ─────────────────────────────────────────────────────────────────────────────

/** The `Model.Info` `/model` displays, built on the schema defaults. */
const toModelInfo = (providerID: Provider.ID, raw: RawModelInfo): Model.Info => {
  const base = Model.Info.default(providerID, Model.ID.make(raw.id))
  return {
    ...base,
    name: raw.name,
    // `Model.Info.default` announces `input: ["text", "image"]`: it is
    // **overwritten**, because the reducer can only render text (see
    // `core/publish`).
    capabilities: {
      tools: raw.capabilities.tools,
      input: [...raw.capabilities.input],
      output: [...raw.capabilities.output],
    },
    limit: { context: raw.limit.context, output: raw.limit.output },
    // `cost` stays empty: ACP publishes no pricing. Inventing a price would show
    // a per-turn cost unrelated to the real bill.
    variants: raw.variants.map((variant) => ({
      id: Model.VariantID.make(variant.id),
      settings: { ...variant.settings },
    })),
  }
}

/** The registered `Provider.Info`, built on `Provider.Info.empty(id)`. */
const toProviderInfo = (raw: RawProviderInfo): Provider.Info => ({
  ...Provider.Info.empty(Provider.ID.make(raw.id)),
  name: raw.name,
  activation: raw.activation,
  package: raw.package,
  settings: { ...raw.settings },
})

/** What is handed to `editor.add()`: the provider and all its models. */
interface Publication {
  readonly info: Provider.Info
  readonly models: readonly Model.Info[]
}

const publish = (options: PublishOptions, packageURL: string, inventory: Inventory): Publication => {
  const providerID = Provider.ID.make(options.id ?? PROVIDER_ID)
  return {
    info: toProviderInfo(providerInfo(options, packageURL)),
    models: inventoryToModels(inventory, options).map((raw) => toModelInfo(providerID, raw)),
  }
}

/**
 * Is this provider id already **taken by somebody else**?
 *
 * Note: `owned` is what separates "my own entry, replace it" from "a foreign
 * entry under the same id, refuse". Refusing is the decision: the id then belongs
 * to a built-in provider or to one the user declared in `opencode.jsonc`, and
 * overwriting it would replace a working provider with an ACP inventory, with
 * nothing in the log to explain the models that vanished. Renaming instead is no
 * option either - the next free name is not stable across restarts, so `/model`
 * would show a different id every time the user added a provider.
 *
 * Note: `list` is **optional at the call site**. The `acp-` prefix is the real
 * protection, this is the belt; a host whose editor does not expose `list` must
 * lose the belt and keep the providers, not the other way round. A plugin that
 * registers nothing is indistinguishable from one that never loaded.
 */
const isTakenByAnother = (editor: ProviderEditor, id: string, owned: ReadonlySet<string>): boolean => {
  if (owned.has(id)) return false
  if (typeof editor.list !== "function") return false
  return editor.list().some((record) => record.provider.id === id)
}

/**
 * Registers (or re-registers) the provider in the catalogue.
 *
 * Note: `editor.add` **replaces** the entry whose `id` is `info.id`, so
 * re-registering is idempotent, and that is what makes refreshing possible
 * without ever duplicating the provider. `dispose` is still needed so the
 * previous transformation stops contributing to the catalogue.
 */
const register = (
  ctx: Context,
  publication: Publication,
  owned: ReadonlySet<string>,
): Promise<Registration> =>
  ctx.provider.transform((editor: ProviderEditor) => {
    if (isTakenByAnother(editor, publication.info.id, owned)) {
      throw new Error(
        `identifiant de provider « ${publication.info.id} » déjà pris par un provider existant ; ` +
          "donne un autre `id` à cet agent (le préfixe `acp-` rend la collision improbable).",
      )
    }
    editor.add({ info: publication.info, models: publication.models })
  })

/**
 * Refreshes the catalogue when the agent's inventory has moved.
 *
 * Note: **event-driven, not polled.** The ACP inventory changes when the agent
 * changes model - that is, during a turn. The only OpenCode signal that follows
 * a finished turn is `session.idle`: it is hooked, and a time guard
 * (`refreshMs`) bounds the number of rediscoveries. Without that guard, a very
 * active session would open one ACP session per turn.
 *
 * Note: what refreshing does **not** do: observe the transport sessions'
 * `config_option_update`. The portable `AcpSession` contract only exposes them
 * during a `prompt()`, and this session never prompts. Reopening a throwaway
 * session is therefore the only honest way today; refreshing will eventually be
 * hooked onto the adapter's stream, which already sees them.
 *
 * Note: `ctx.event.subscribe` **ignores its options** on the 2.0.16 server (the
 * `signal` is not forwarded), so cancelling also goes through
 * `iterator.return()`, otherwise the iterator would stay waiting after the plugin
 * is unloaded.
 *
 * Returns the stop function.
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

  /** Schedules a pass, never stacking two. */
  const schedule = (): void => {
    if (stopped || timer !== undefined) return
    const wait = Math.max(0, lastRun + refreshMs - Date.now())
    timer = setTimeout(() => {
      timer = undefined
      if (stopped) return
      lastRun = Date.now()
      refresh().catch((error: unknown) => log(`rafraîchissement ignoré : ${reason(error)}`))
    }, wait)
    // The timer must not, on its own, keep the process alive.
    timer.unref?.()
  }

  const pump = async (): Promise<void> => {
    try {
      for (;;) {
        const next = await iterator.next()
        if (next.done === true) return
        // A turn that just finished is the only moment the agent could have
        // changed its model or effort-level inventory.
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
// The plugin
// ─────────────────────────────────────────────────────────────────────────────

export default Plugin.define({
  id: PLUGIN_ID,

  /**
   * The host's entry point.
   *
   * Note: this `try/catch` is the **only** guarantee of the invariant stated at
   * the top of this file: nothing the plugin does may bring down OpenCode's
   * startup. Each internal step has its own guard, but an unexpected exception -
   * a host API that changed, a `Model.Info` rejected by `Provider.Info.empty` -
   * would otherwise reach the host, which would abandon loading this plugin
   * **and** every one after it.
   *
   * Nothing can be told apart from here without the "module evaluated" marker
   * written above: that is exactly why it sits outside this `try`.
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

/** A registered agent, and everything that has to be undone for it. */
interface Registered {
  /** The provider id this agent is published under. */
  readonly id: string
  /** Stops the inventory watcher. */
  readonly stop: () => void
  /** Drops this agent's contribution to the catalogue. */
  readonly dispose: () => Promise<void>
  /** Kills the discovery agent process. */
  readonly closeAgent: () => Promise<void>
}

/**
 * Brings one agent all the way to a registered provider.
 *
 * Note: **every** failure path returns `undefined` instead of throwing. That is
 * what makes the list of agents independent: a dead agent - a command that does
 * not exist, a timeout, an id already taken - must cost the user that agent and
 * nothing else. A single `try/catch` around the whole loop would instead make
 * the order of the configuration decide whether the *working* agents are
 * registered at all.
 *
 * Note: the ACP process is closed on every failure exit. A discovery that ends
 * without a registration has opened a process nobody will ever close, and
 * `setup` returning would leave one orphan per agent.
 */
const bringUp = async (
  ctx: Context,
  agent: RawAgent,
  providerId: string,
  packageURL: string,
  bounds: { readonly timeoutMs: number; readonly idleTimeoutMs: number; readonly refreshMs: number },
  owned: Set<string>,
): Promise<Registered | undefined> => {
  // The settings are validated **before** any spawn, with the exact rules
  // `model()` will apply on every turn: a missing `command` must fail here,
  // with its path, not on the first prompt.
  const settings = parseSettings(providerSettingsOf(agent, providerId))
  if (!settings.ok) {
    log(`agent « ${agent.id} » ignoré : ${settings.message}`)
    return undefined
  }

  // This is a **second** process, distinct from the one the transport will
  // spawn through `model()`. The `opencode-transport.ts` cache is deliberately
  // not shared: borrowing it would load the whole `effect` + `@opencode/ai`
  // stack as soon as the plugin loads - in the server process - for a single
  // capture.
  //
  // Both steps are **bounded** (`discover`): this is the only place in the
  // project where a wait can block OpenCode's startup, because the host awaits
  // `setup` before yielding. A mute, dead or stuck agent must produce "provider
  // not registered", not "OpenCode does not start".
  let discovered: Discovery
  try {
    discovered = await discover(
      {
        command: settings.value.command,
        ...(settings.value.args === undefined ? {} : { args: settings.value.args }),
        ...(settings.value.cwd === undefined ? {} : { cwd: settings.value.cwd }),
        ...(settings.value.env === undefined ? {} : { env: settings.value.env }),
        // No `policy`: `createAcpAgent`'s default is `denyAllPermissions`. The
        // plugin only performs discovery, it opens no turn - but it must not be
        // able to do better.
      },
      bounds.timeoutMs,
      bounds.idleTimeoutMs,
    )
  } catch (error) {
    // The error names the **agent**: "agent unavailable" without the
    // configured agent's name is an unusable diagnostic when the list holds
    // several, or when the default (`copilot`) is not that one.
    log(`agent « ${agent.id} » indisponible, « ${providerId} » non enregistré : ${reason(error)}`)
    return undefined
  }
  const acp = discovered.agent

  const options: PublishOptions = {
    id: providerId,
    label: `ACP — ${acp.info.name}`,
    settings: providerSettingsOf(agent, providerId),
    ...(agent.limits === undefined ? {} : { limits: agent.limits }),
  }

  // `AcpAgent.inventory()` opens a throwaway session, reads, closes: the
  // capture is therefore always fresh, which is exactly the defect it papers
  // over (19 values on the first `session/new`, 20 after a `set_config_option`).
  let inventory: Inventory
  try {
    inventory = await discovered.inventory()
  } catch (error) {
    await acp.close()
    log(`inventaire illisible pour « ${agent.id} », « ${providerId} » non enregistré : ${reason(error)}`)
    return undefined
  }
  if (inventory.models.length === 0) {
    await acp.close()
    log(`« ${agent.id} » ne propose aucun modèle, « ${providerId} » non enregistré`)
    return undefined
  }
  // The **raw** capture is logged: the published count may be smaller (`auto`
  // is filtered out), and it is the gap between the two that says whether the
  // agent proposed anything other than models.
  log(
    `${acp.info.name} v${acp.info.version} (${providerId}) : ${inventory.models.length} valeur(s) de ` +
      `modèle, ${inventory.thoughtLevels.length} niveau(s) d'effort`,
  )

  // A rejected `transform` would leave the ACP agent alive with nothing
  // cleaning up behind it: it is closed before returning, and logged. The
  // "never bring down OpenCode's startup" principle applies to this step too.
  let registration: Registration
  try {
    registration = await register(ctx, publish(options, packageURL, inventory), owned)
  } catch (error) {
    await acp.close()
    log(`« ${providerId} » non enregistré : ${reason(error)}`)
    return undefined
  }
  owned.add(providerId)
  let signature = inventorySignature(inventory)

  // The refresh pass goes through `discovered.inventory()` and not
  // `acp.inventory()`, so it is **bounded** too. A discovery dragging on in the
  // background cannot leave an ACP session open forever - and, awaited, cannot
  // leak a rejection either.
  const stop = watch(ctx, bounds.refreshMs, async () => {
    const next = await discovered.inventory()
    const nextSignature = inventorySignature(next)
    // Nothing changed: nothing is touched. `ctx.provider.reload()` rebuilds the
    // whole catalogue, so calling it without reason would lose the current
    // `/model` selection over an identical inventory.
    if (nextSignature === signature) return
    log(`${providerId} : inventaire modifié, ${next.models.length} modèle(s)`)
    // The new one is registered **before** the old one is disposed: if the
    // registration fails, the previous catalogue stays in place and `/model`
    // keeps working with a dated but valid inventory.
    const fresh = await register(ctx, publish(options, packageURL, next), owned)
    await registration.dispose()
    registration = fresh
    signature = nextSignature
    await ctx.provider.reload()
  })

  // The order matters: the watcher is stopped **before** the agent, otherwise
  // a rediscovery in flight would fail on an already dead agent - and that
  // error would mask the real cause, the shutdown. The `finally` is the only
  // guarantee that the agent is killed, even if `dispose` fails.
  return {
    id: providerId,
    stop,
    dispose: () => registration.dispose(),
    closeAgent: () => acp.close(),
  }
}

/**
 * Undoes one registration, in the only order that leaves nothing half-alive.
 *
 * Note: the watcher is stopped **before** the agent, otherwise a rediscovery in
 * flight would fail on an already dead agent - and that error would mask the
 * real cause.
 *
 * Note: every step is guarded. An agent whose `dispose` throws must still have
 * its process killed, and must not keep the next agent from being lowered.
 *
 * Note: what it does **not** touch is the transport's own ACP sessions, which
 * belong to the provider package and are closed once for all at shutdown: an
 * agent removed from `/connect` mid-session keeps its open session until the
 * pool reclaims it, and closing the whole pool here would cut the live turns of
 * the agents that stay.
 */
const lower = async (entry: Registered): Promise<void> => {
  entry.stop()
  try {
    await entry.dispose()
  } catch (error) {
    log(`« ${entry.id} » non retiré du catalogue : ${reason(error)}`)
  }
  try {
    await entry.closeAgent()
  } catch (error) {
    log(`agent « ${entry.id} » non arrêté : ${reason(error)}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// `/connect`
// ─────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Is this array a form the host will read?
 *
 * Note: `core/connect.ts` cannot type its form - `Form.Fields` lives in
 * `@opencode/schema`, which `core/` may not import - so the check belongs here,
 * in the one file that knows the schema. A rejected form would leave `/connect`
 * showing an entry that cannot be filled in, which is worse than no entry.
 *
 * Note: the check is stricter than the schema on purpose. A `string` field holds
 * strings and booleans, and that is all the shipped form uses; a field carrying
 * something else is a mistake to be reported, not published.
 */
const isFormFields = (fields: readonly unknown[]): fields is Form.Fields =>
  fields.length > 0 &&
  fields.every(
    (field) =>
      isRecord(field) &&
      field["type"] === "string" &&
      typeof field["key"] === "string" &&
      Object.values(field).every((value) => typeof value === "string" || typeof value === "boolean"),
  )

/** The `/connect` form, or a failure the caller turns into a log line. */
const connectForm = (): Form.Fields => {
  if (!isFormFields(CONNECT_FORM_FIELDS)) throw new Error("le formulaire /connect est mal formé")
  return CONNECT_FORM_FIELDS
}

/**
 * Registers the `/connect` entry, so the user can add an agent without touching
 * `opencode.json`.
 *
 * Note: a `key` method **carries no `id`** - unlike `oauth` and `command` - so
 * this is the only key method the integration has, and `/connect` can hold one
 * connection. `update` on both the integration and the method is an upsert, so
 * a second load of the plugin re-registers rather than duplicates.
 *
 * Note: `reload` is what makes the entry appear in the UI. Registering without
 * it would leave the provider list correct and `/connect` showing nothing.
 *
 * Returns whether the entry is there. `false` means the host has no integration
 * domain, or refused the registration, and there is then nothing to poll: a poll
 * that could only fail would fill the log with a line every five seconds.
 */
const registerConnect = async (ctx: Context): Promise<boolean> => {
  if (typeof ctx.integration?.transform !== "function") {
    log("hôte sans domaine `integration` : /connect indisponible")
    return false
  }
  try {
    await ctx.integration.transform((editor: IntegrationEditor) => {
      editor.update(CONNECT_INTEGRATION_ID, (integration) => {
        integration.name = CONNECT_INTEGRATION_NAME
      })
      editor.method.update({
        integrationID: CONNECT_INTEGRATION_ID,
        method: { type: "key", label: CONNECT_METHOD_LABEL, form: connectForm() },
      })
    })
    await ctx.integration.reload()
  } catch (error) {
    log(`intégration /connect non enregistrée : ${reason(error)}`)
    return false
  }
  return true
}

/**
 * The agent `/connect` currently declares, if any.
 *
 * Note: an integration holds **one** active connection, hence one agent: the
 * answer is a single agent, not a list.
 *
 * Note: `undefined` covers every "no agent" case - no connection at all, a
 * credential of another type, a form half filled - because a `/connect` the
 * plugin cannot read must cost the user his ACP agent and nothing else. A thrown
 * error is logged: swallowing it would be indistinguishable from `/connect`
 * never having registered.
 */
const readConnectAgent = async (ctx: Context): Promise<RawAgent | undefined> => {
  try {
    const connection = await ctx.integration.connection.active(CONNECT_INTEGRATION_ID)
    if (connection === undefined) return undefined
    const answers = parseConnectCredential(await ctx.integration.connection.resolve(connection))
    if (answers === undefined) return undefined
    return connectAgentToRawAgent(answers)
  } catch (error) {
    log(`connexion /connect illisible : ${reason(error)}`)
    return undefined
  }
}

/** Rebuilds the catalogue, so a provider published mid-session reaches `/model`. */
const reloadCatalogue = async (ctx: Context): Promise<void> => {
  try {
    await ctx.provider.reload()
  } catch (error) {
    log(`catalogue non rechargé : ${reason(error)}`)
  }
}

/**
 * Re-reads the `/connect` connection every `CONNECT_POLL_MS`.
 *
 * Note: **polled, not pushed.** The host emits no `connection.updated`: the only
 * `.updated` events are `session.*`, `message.part.updated`,
 * `vcs.branch.updated`, `installation.updated` and `sdk.plugin.updated`, so a
 * subscription could never fire on a new connection. A tick that finds the same
 * list costs one credential read and nothing else.
 *
 * Note: `unref`. A periodic read must not be the reason the server stays alive
 * once its last session has closed.
 *
 * Note: ticks never overlap - one discovery can take longer than the period, and
 * two of them would bring the same agent up twice.
 */
const watchConnect = (resync: () => Promise<void>): (() => void) => {
  const timer = setInterval(() => {
    void resync()
  }, CONNECT_POLL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** `setup`'s work, without the safety net: `setup` is what carries it. */
async function runSetup(ctx: Context): Promise<(() => Promise<void>) | undefined> {
  // ── 1. Options ──────────────────────────────────────────────────────────
  // A refused configuration is **not** a reason to stop there. Agents come from
  // two sources, and `/connect` is one of them: stopping on a missing `agents`
  // array would make `/connect` unusable exactly when the user has nothing in
  // `opencode.json` yet, which is the case it is for. The refusal is logged, and
  // the defaults apply to the rest of the options.
  const parsed = parsePluginConfig(ctx.options)
  if (!parsed.ok) log(`configuration ignorée : ${parsed.message}`)
  const config: PluginConfig = parsed.ok
    ? parsed.value
    : {
        agents: [],
        refreshMs: DEFAULT_REFRESH_MS,
        discoveryTimeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS,
        discoveryIdleTimeoutMs: DEFAULT_DISCOVERY_IDLE_TIMEOUT_MS,
      }

  // ── 2. Provider package entry point ─────────────────────────────────────
  let packageURL: string
  try {
    packageURL = resolvePackageURL(import.meta.url)
  } catch (error) {
    log(reason(error))
    return
  }

  // ── 3. `/connect` ───────────────────────────────────────────────────────
  // Registered **before** the first discovery: an entry the user can already
  // see while the providers are still being discovered is the difference between
  // a feature and a feature one has to guess the timing of.
  const connectable = await registerConnect(ctx)
  const connectAgent = connectable ? await readConnectAgent(ctx) : undefined
  const fromConnect = connectAgent === undefined ? [] : [connectAgent]
  // `/connect` first: an agent the user typed in the UI is the one they last
  // touched (see `mergeAgents`).
  const wanted = mergeAgents(fromConnect, config.agents)

  // ── 4. One provider per agent ────────────────────────────────────────────
  const registered = new Map<string, Registered>()
  const owned = new Set<string>()
  const bounds = {
    timeoutMs: config.discoveryTimeoutMs,
    idleTimeoutMs: config.discoveryIdleTimeoutMs,
    refreshMs: config.refreshMs,
  }

  /**
   * Brings one agent up, unless its provider id is already spoken for.
   *
   * Note: two agents resolving to the same id would fight over one catalogue
   * entry - `editor.add` replaces, so the second would silently take the first's
   * models while `/model` still showed the first's name. First one wins, and the
   * loser is named.
   *
   * Returns whether the agent reached the catalogue; a failure has already said
   * why, in its own log line.
   */
  const raise = async (agent: RawAgent): Promise<boolean> => {
    const id = providerIdOf(agent.providerSlug)
    if (owned.has(id)) {
      log(`agent « ${agent.id} » ignoré : l'identifiant « ${id} » est déjà pris par un agent enregistré`)
      return false
    }
    const up = await bringUp(ctx, agent, id, packageURL, bounds, owned)
    if (up === undefined) return false
    registered.set(id, up)
    return true
  }

  // Agents are brought up **one after another**, and that is a decision rather
  // than an accident: each discovery spawns an agent that authenticates, and N
  // of them starting together at boot is exactly the burst `discoveryTimeoutMs`
  // exists to avoid. It also keeps the log in the order the user wrote.
  for (const agent of wanted) await raise(agent)

  // ── 5. Resynchronisation ────────────────────────────────────────────────
  /**
   * Brings the catalogue to what `/connect` now says.
   *
   * Note: the config file is read once, for the lifetime of the process, so a
   * difference between two wanted lists can only come from the connection.
   *
   * Note: the fingerprint compared against is that of the list **last attempted**,
   * not of what is registered. Retrying an agent that failed to start would mean
   * spawning a process every five seconds for an agent that cannot start; an
   * agent is therefore retried when the list moves, which is what editing the
   * `/connect` connection does.
   */
  let settled: readonly RawAgent[] = wanted
  let fingerprint = agentsFingerprint(wanted)
  let running = false
  const resync = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const agent = await readConnectAgent(ctx)
      const next = mergeAgents(agent === undefined ? [] : [agent], config.agents)
      // Nothing moved: no comparison of the catalogue, no `reload`, no process.
      if (agentsFingerprint(next) === fingerprint) return
      const { added, removed } = diffAgents(settled, next)
      // An agent that had never been published has nothing to tear down and
      // nothing to announce: only what the catalogue really gained or lost is
      // worth a `reload`.
      let moved = false
      for (const gone of removed) {
        // The id is freed **before** the new agent claims it, and the two halves
        // of a changed agent are exactly this order: `editor.add` would replace
        // the entry of the old one silently.
        const id = providerIdOf(gone.providerSlug)
        const entry = registered.get(id)
        if (entry === undefined) continue
        registered.delete(id)
        owned.delete(id)
        await lower(entry)
        moved = true
        log(`agent « ${gone.id} » retiré : absent de /connect`)
      }
      for (const fresh of added) {
        if (!(await raise(fresh))) continue
        moved = true
        log(`agent « ${fresh.id} » ajouté depuis /connect`)
      }
      settled = next
      fingerprint = agentsFingerprint(next)
      if (moved) await reloadCatalogue(ctx)
    } catch (error) {
      log(`resynchronisation /connect ignorée : ${reason(error)}`)
    } finally {
      running = false
    }
  }
  const stopWatching = connectable ? watchConnect(resync) : undefined

  // ── 6. What ended up published ──────────────────────────────────────────
  // The source of a provider is the one thing `/model` cannot show: both sources
  // publish under the same `acp-` ids, and nothing else says whether an agent
  // was typed in `opencode.json` or in `/connect`.
  const published = [...registered.keys()]
  const connectIDs = new Set(fromConnect.map((agent) => providerIdOf(agent.providerSlug)))
  const fromConnectCount = published.filter((id) => connectIDs.has(id)).length
  if (published.length === 0) {
    log("aucun agent enregistré, aucun provider ACP publié")
  } else {
    const dropped = wanted.length - published.length
    log(
      `${published.length} provider(s) ACP : ${published.join(", ")}` +
        (dropped > 0 ? ` — ${dropped} agent(s) écarté(s)` : "") +
        ` — ${fromConnectCount} depuis /connect, ${published.length - fromConnectCount} depuis la configuration`,
    )
  }

  // Nothing registered and nothing to watch: there is nothing for the host to
  // unload, and a teardown that only clears a timer that does not exist would
  // be a lie about the work done.
  if (published.length === 0 && stopWatching === undefined) return

  // ── 7. Shutdown ─────────────────────────────────────────────────────────
  // Every agent is lowered even if one fails: `lower` guards each of its steps,
  // so an agent whose `dispose` throws must not leave its process - and its ACP
  // sessions - alive until the server exits.
  return async () => {
    stopWatching?.()
    for (const entry of registered.values()) await lower(entry)
    await closeProviderSessions()
  }
}

/**
 * Closes the ACP sessions retained by the **provider**.
 *
 * Note: the `import` is **dynamic**, and deliberately so. A static `import` of
 * `adapters/opencode-transport.ts` would pull the whole `effect` +
 * `@opencode/ai` stack into the plugin's process - exactly what discovery avoids
 * (the "one provider per agent" step of `runSetup`) - for a module only useful
 * at exit time. Dynamic, it costs nothing at load, and it cannot fail anyway:
 * the server has already imported the provider package (its `package` field did
 * that), so it is a plain module cache hit, in the same process.
 *
 * Note: the call must **never** make a shutdown fail: a recalcitrant session
 * must not keep the other plugins from quitting. Hence the `catch` that logs and
 * returns.
 */
const closeProviderSessions = async (): Promise<void> => {
  try {
    const { closeAllSessions } = await import("./adapters/opencode-transport.js")
    await closeAllSessions()
  } catch (error) {
    log(`sessions ACP non fermées au déchargement : ${reason(error)}`)
  }
}
