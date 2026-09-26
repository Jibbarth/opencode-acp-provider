/**
 * The OpenCode plugin - it is what makes the provider visible.
 *
 * It does three things, and **nothing else**:
 *
 * 1. reads `ctx.options` (the agents declared in `opencode.jsonc`);
 * 2. launches the ACP agent, reads its `configOptions` inventory, and registers
 *    it in the catalogue: one `Provider.Info` plus one `Model.Info` per model;
 * 3. watches OpenCode's event stream and **republishes** when the inventory has
 *    moved, then closes the agent on shutdown.
 *
 * Note: **none of these steps may bring down OpenCode's startup.** A plugin that
 * throws in `setup` is not "one plugin in default state": it is a list of
 * plugins refusing to start, and the user loses every other plugin too. Every
 * error is therefore logged and reduced to "nothing is registered" - an absent
 * provider is visible, a dead server is not.
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
  const providerID = Provider.ID.make(PROVIDER_ID)
  return {
    info: toProviderInfo(providerInfo(options, packageURL)),
    models: inventoryToModels(inventory, options).map((raw) => toModelInfo(providerID, raw)),
  }
}

/**
 * Registers (or re-registers) the provider in the catalogue.
 *
 * Note: `editor.add` **replaces** the entry whose `id` is `info.id`, so
 * re-registering is idempotent, and that is what makes refreshing possible
 * without ever duplicating the provider. `dispose` is still needed so the
 * previous transformation stops contributing to the catalogue.
 */
const register = (ctx: Context, publication: Publication): Promise<Registration> =>
  ctx.provider.transform((editor: ProviderEditor) => {
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

/** `setup`'s work, without the safety net: `setup` is what carries it. */
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

    // Only one agent is registered, and it is the **first**: the route carries a
    // fixed `provider` (`adapters/opencode-transport.ts`), so a second provider
    // would carry the same id. Rather than publishing it silently, it is said
    // out loud - and the ignored agents are named.
    for (const ignored of agents.slice(1)) {
      log(`agent « ${ignored.id} » ignoré : un seul provider ACP est supporté en P3a`)
    }

    // The settings are validated **before** any spawn, with the exact rules
    // `model()` will apply on every turn: a missing `command` must fail here,
    // with its path, not on the first prompt.
    const settings = parseSettings(providerSettingsOf(agent))
    if (!settings.ok) {
      log(`agent « ${agent.id} » ignoré : ${settings.message}`)
      return
    }

    // ── 2. Provider package entry point ─────────────────────────────────────
    let packageURL: string
    try {
      packageURL = resolvePackageURL(import.meta.url)
    } catch (error) {
      log(reason(error))
      return
    }

    // ── 3. Launching the agent ──────────────────────────────────────────────
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
        discoveryTimeoutMs,
        discoveryIdleTimeoutMs,
      )
    } catch (error) {
      // The error names the **agent**: "agent unavailable" without the
      // configured agent's name is an unusable diagnostic when the list holds
      // several, or when the default (`copilot`) is not that one.
      log(`agent « ${agent.id} » indisponible, provider non enregistré : ${reason(error)}`)
      return
    }
    const acp = discovered.agent

    const options: PublishOptions = {
      label: `ACP — ${acp.info.name}`,
      settings: providerSettingsOf(agent),
      ...(agent.limits === undefined ? {} : { limits: agent.limits }),
    }

    // ── 4. Discovery ────────────────────────────────────────────────────────
    // `AcpAgent.inventory()` opens a throwaway session, reads, closes: the
    // capture is therefore always fresh, which is exactly the defect it papers
    // over (19 values on the first `session/new`, 20 after a `set_config_option`).
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
    // The **raw** capture is logged: the published count may be smaller (`auto`
    // is filtered out), and it is the gap between the two that says whether the
    // agent proposed anything other than models.
    log(
      `${acp.info.name} v${acp.info.version} (${agent.id}) : ${inventory.models.length} valeur(s) de ` +
        `modèle, ${inventory.thoughtLevels.length} niveau(s) d'effort`,
    )

    // ── 5. Registration ─────────────────────────────────────────────────────
    // A rejected `transform` would leave the ACP agent alive with nothing
    // cleaning up behind it: it is closed before returning, and logged. The
    // "never bring down OpenCode's startup" principle applies to this step too.
    let registration: Registration
    try {
      registration = await register(ctx, publish(options, packageURL, inventory))
    } catch (error) {
      await acp.close()
      log(`enregistrement refusé par l'hôte, provider non enregistré : ${reason(error)}`)
      return
    }
    let signature = inventorySignature(inventory)

    // ── 6. Refreshing ───────────────────────────────────────────────────────
    // The refresh pass goes through `discovered.inventory()` and not
    // `acp.inventory()`, so it is **bounded** too. A discovery dragging on in
    // the background cannot leave an ACP session open forever - and, awaited,
    // cannot leak a rejection either.
    const stop = watch(ctx, refreshMs, async () => {
      const next = await discovered.inventory()
      const nextSignature = inventorySignature(next)
      // Nothing changed: nothing is touched. `ctx.provider.reload()` rebuilds
      // the whole catalogue, so calling it without reason would lose the current
      // `/model` selection over an identical inventory.
      if (nextSignature === signature) return
      log(`inventaire modifié : ${next.models.length} modèle(s)`)
      // The new one is registered **before** the old one is disposed: if the
      // registration fails, the previous catalogue stays in place and `/model`
      // keeps working with a dated but valid inventory.
      const fresh = await register(ctx, publish(options, packageURL, next))
      await registration.dispose()
      registration = fresh
      signature = nextSignature
      await ctx.provider.reload()
    })

    // ── 7. Shutdown ─────────────────────────────────────────────────────────
    // The order matters: the watcher is stopped **before** the agent, otherwise
    // a rediscovery in flight would fail on an already dead agent - and that
    // error would mask the real cause, the shutdown. The `finally` is the only
    // guarantee that the agent is killed, even if `dispose` fails.
    return async () => {
      stop()
      try {
        await registration.dispose()
      } finally {
        await closeProviderSessions()
        await acp.close()
      }
    }
}

/**
 * Closes the ACP sessions retained by the **provider**.
 *
 * Note: the `import` is **dynamic**, and deliberately so. A static `import` of
 * `adapters/opencode-transport.ts` would pull the whole `effect` +
 * `@opencode/ai` stack into the plugin's process - exactly what discovery avoids
 * (step "3. Launching the agent" of `runSetup`) - for a module only useful at
 * exit time. Dynamic, it costs nothing at load, and it cannot fail anyway: the
 * server has already imported the provider package (its `package` field did
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
