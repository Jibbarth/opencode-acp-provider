/**
 * Making load failures **visible**.
 *
 * A plugin package that does not load produces **no** visible error: the host
 * notes "plugin skipped" and moves on. All the possible causes look alike - a
 * wrong path in `opencode.jsonc`, a module throwing while being evaluated,
 * `Plugin.define` never reached, a `setup` that rejects - and the diagnostic is
 * always the same: the provider is missing from `/model`, for no stated reason.
 *
 * What is missing is the distinction between two situations:
 *
 *   - **the module was never evaluated**;
 *   - **`setup()` was reached, and failed or registered nothing**.
 *
 * The marker `src/plugin.ts` writes **at the moment the module is evaluated**
 * settles it: if it is absent from stderr the problem is upstream of us (path,
 * installation, import error); if it is present, everything left to look at is in
 * `setup`'s log.
 *
 * Note: the tests therefore go through a **subprocess**. The only way to observe
 * what is written while a module is evaluated is to load it in a fresh runtime;
 * an `import` in the test itself would emit the line before the test even
 * starts.
 */

import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const PLUGIN = fileURLToPath(new URL("../src/plugin.ts", import.meta.url))
const FAKE = fileURLToPath(new URL("./fake-acp.ts", import.meta.url))

/** Loads the module in a fresh process and returns its stderr. */
const evaluatePlugin = async (args: readonly string[] = []): Promise<string> => {
  const script = `await import(${JSON.stringify(PLUGIN)}); ${args.join(" ")}`
  const proc = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  expect({ code, script }).toEqual({ code: 0, script })
  return stderr
}

describe("plugin loading leaves a trace", () => {
  test("the module writes its marker on stderr, as soon as it is evaluated", async () => {
    const stderr = await evaluatePlugin()
    // The marker carries the module's **URL**: that is what makes it obvious at
    // a glance that *this* file was evaluated, not another plugin that happened
    // to write the same line.
    expect(stderr).toContain("module évalué")
    expect(stderr).toContain(PLUGIN)
    // And **one** marker line only: "discreet" means discreet.
    expect(stderr.split("\n").filter((line) => line.includes("module évalué"))).toHaveLength(1)
  })

  test("the marker is written on stderr, never on stdout", async () => {
    // stdout is the server's protocol channel: writing a diagnostic line there
    // would pollute an output other components read.
    const script = `await import(${JSON.stringify(PLUGIN)})`
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    expect(stdout).toBe("")
  })

  test("`setup` returns instead of bringing down the startup", async () => {
    // Note: the invariant stated at the top of `src/plugin.ts`: an unreadable
    // configuration is logged and reduced to "nothing is registered". The process
    // must therefore **exit with 0**, letting nothing reject.
    const stderr = await evaluatePlugin([
      `const plugin = (await import(${JSON.stringify(PLUGIN)})).default;`,
      `await plugin.setup({ options: { agents: "pas un tableau" } });`,
    ])
    expect(stderr).toContain("module évalué")
    // The marker is **present** => the module really was evaluated, and the next
    // line is `setup`'s log: exactly the distinction this batch makes possible.
    expect(stderr).toContain("configuration ignorée")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The nominal path: the plugin really discovers an agent and registers a provider
// ─────────────────────────────────────────────────────────────────────────────

describe("the plugin registers a provider from a fake agent", () => {
  test("a valid agent produces a registration, logged and disposable", async () => {
    // A **minimal** host context is built: the plugin only reads `options`,
    // `provider.transform` and `event.subscribe` (with `refreshMs: 0` it does not
    // even subscribe). A `Proxy` supplies the rest, so no invented property can
    // make the test fail by surprise.
    const script = `
      const module = await import(${JSON.stringify(PLUGIN)})
      const added = []
      const disposables = []
      const context = new Proxy({}, {
        get: (_target, key) => {
          if (key === "options") return { agents: [{ id: "faux", command: process.execPath, args: ["run", ${JSON.stringify(FAKE)}] }], refreshMs: 0 }
          if (key === "provider") return {
            transform: (fn) => { fn({ add: (entry) => { added.push(entry) } }); const d = { dispose: () => {} }; disposables.push(d); return Promise.resolve(d) },
            reload: () => Promise.resolve(),
          }
          if (key === "event") return { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) }
          return undefined
        },
      })
      const dispose = await module.default.setup(context)
      const provider = added[0]
      console.log(JSON.stringify({
        dispose: typeof dispose,
        id: provider?.info?.id,
        package: provider?.info?.package,
        models: provider?.models?.map((m) => m.id),
      }))
      await dispose?.()
      process.exit(0)
    `
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr })
    const published: unknown = JSON.parse(stdout.trim())
    if (typeof published !== "object" || published === null) throw new Error(stdout)
    const record = published as Record<string, unknown>
    expect(record["dispose"]).toBe("function")
    // The agent named itself `faux`, so it gets **its own** provider: one
    // provider per agent is what keeps two agents' credentials, inventories and
    // sessions apart.
    expect(record["id"]).toBe("acp-faux")
    // This is the point of the package contract tests: the registered URL must
    // be an absolute `file://` pointing at a file that exists - otherwise `/model`
    // shows the provider and the first turn fails with `ERR_MODULE_NOT_FOUND`.
    expect(String(record["package"]).startsWith("file://")).toBe(true)
    // `auto` is filtered out (`PSEUDO_MODEL_IDS`): two models remain.
    expect(record["models"]).toEqual(["gpt-5.6-terra", "claude-sonnet-5"])
    expect(stderr).toContain("module évalué")
  })

  test("an unavailable agent does not bring down the startup", async () => {
    const script = `
      const module = await import(${JSON.stringify(PLUGIN)})
      const context = new Proxy({}, {
        get: (_target, key) =>
          key === "options"
            ? { agents: [{ id: "fantome", command: "opencode-acp-commande-inexistante-42" }] }
            : undefined,
      })
      const dispose = await module.default.setup(context)
      console.log("dispose=" + String(dispose))
    `
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect({ code, stdout }).toEqual({ code: 0, stdout: "dispose=undefined\n" })
    expect(stderr).toContain("module évalué")
    // The marker is present **and** the failure is logged: that is the difference
    // between "the module did not load" and "the agent is missing".
    expect(stderr).toContain("indisponible")
    expect(stderr).toContain("opencode-acp-commande-inexistante-42")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Discovery bounds
// ─────────────────────────────────────────────────────────────────────────────

describe("discovery is bounded", () => {
  /**
   * Runs `setup` with an **empty** context - so an agent that is never touched -
   * and returns the process output. `options` can be overridden.
   */
  const setup = async (options: string): Promise<{ code: number; stdout: string; stderr: string; elapsed: number }> => {
    const script = `
      const module = await import(${JSON.stringify(PLUGIN)})
      const context = new Proxy({}, { get: (_t, key) => (key === "options" ? ${options} : undefined) })
      console.log("dispose=" + String(await module.default.setup(context)))
    `
    const started = Date.now()
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, stdout, stderr, elapsed: Date.now() - started }
  }

  /** The options of an agent that answers, but only after `FAKE_SLOW_INIT_MS`. */
  const slowAgent = (ms: number) =>
    `{ agents: [{ id: "lent", command: process.execPath, args: ["run", ${JSON.stringify(FAKE)}], env: { FAKE_SLOW_INIT_MS: "${ms}" } }], ` +
    `discoveryTimeoutMs: 700, discoveryIdleTimeoutMs: 700 }`

  test("an agent that never answers initialize does not block the startup", async () => {
    // `FAKE_SLOW_INIT_MS=30000`: the agent takes thirty seconds. Without a
    // bound, OpenCode's startup would freeze for thirty seconds without a word.
    const { code, stdout, stderr, elapsed } = await setup(slowAgent(30_000))
    expect(code).toBe(0)
    expect(stdout).toBe("dispose=undefined\n")
    // The bound did its job: 700 ms of configuration, and injecting the agent
    // ('process' + 'execPath') is on the order of a millisecond.
    expect(elapsed).toBeLessThan(10_000)
    // The error names the agent **and** the bound: a diagnostic without the
    // agent's name says nothing when the list holds several.
    expect(stderr).toContain("agent « lent » indisponible")
    expect(stderr).toContain("700 ms")
  }, 20_000)

  test("the inactivity bound catches a rambling agent that never finishes", async () => {
    // An agent that **talks** without ever finishing is not a mute agent: the
    // global bound would leave it waiting out its term in silence. That is the
    // real case of an authentication loop, and it produces no message. What is
    // checked above all is that the output stays clean and bounded.
    const { code, stdout, stderr, elapsed } = await setup(
      `{ agents: [{ id: "bavard", command: process.execPath, args: ["run", ${JSON.stringify(FAKE)}], env: { FAKE_SLOW_INIT_MS: "30000", FAKE_NOISY_STDOUT: "1" } }], ` +
        `discoveryTimeoutMs: 600, discoveryIdleTimeoutMs: 3000 }`,
    )
    expect(code).toBe(0)
    expect(stdout).toBe("dispose=undefined\n")
    // The agent's noisy stdout is relayed **by** the agent, not by us: the plugin
    // does not copy it into its log.
    expect(stderr).not.toContain("Ceci n'est pas du JSON")
    expect(elapsed).toBeLessThan(10_000)
  }, 20_000)

  test("a slow but chatty agent gets the whole global bound", async () => {
    // The opposite mistake for the inactivity bound: it must not turn a chatty
    // agent into a mute one. Here the agent answers after 400 ms, the inactivity
    // bound is 3 s, and the discovery **succeeds**.
    const script = `
      const module = await import(${JSON.stringify(PLUGIN)})
      const added = []
      const context = new Proxy({}, {
        get: (_t, key) => {
          if (key === "options") return { agents: [{ id: "lent", command: process.execPath, args: ["run", ${JSON.stringify(FAKE)}], env: { FAKE_SLOW_INIT_MS: "400" } }], discoveryTimeoutMs: 10000, discoveryIdleTimeoutMs: 3000, refreshMs: 0 }
          if (key === "provider") return { transform: (fn) => { fn({ add: (e) => added.push(e) }); return Promise.resolve({ dispose: () => {} }) }, reload: () => Promise.resolve() }
          return undefined
        },
      })
      const dispose = await module.default.setup(context)
      console.log(JSON.stringify({ dispose: typeof dispose, models: added[0]?.models?.length ?? 0 }))
      await dispose?.()
    `
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    })
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    expect(code).toBe(0)
    const record = JSON.parse(stdout.trim()) as { dispose: string; models: number }
    expect(record.dispose).toBe("function")
    expect(record.models).toBe(2)
  }, 20_000)

  test("an abandoned slow agent leaves no orphan process", async () => {
    // Note: the point the bound alone does not cover. `createAcpAgent` returns
    // after `initialize`, so its promise is **in flight** when the bound fires.
    // The agent it will produce would be alive with nobody to close it - one
    // orphan per plugin load. The `fake-acp` processes are therefore counted
    // before and after.
    const script = `
      const module = await import(${JSON.stringify(PLUGIN)})
      const context = new Proxy({}, {
        get: (_t, key) => (key === "options" ? ${slowAgent(4_000)} : undefined),
      })
      await module.default.setup(context)
    `
    const countFake = (): number => {
      const ps = Bun.spawnSync(["ps", "-eo", "args="])
      return ps.stdout.toString().split("\n").filter((l) => l.includes("fake-acp.ts")).length
    }
    const before = countFake()
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    })
    await proc.exited
    // The abandoned agent takes 4 s to start: it is given time to exist, and
    // then it is checked to have been killed as it was born.
    await Bun.sleep(6_000)
    expect(countFake()).toBe(before)
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// Several agents: one provider each
// ─────────────────────────────────────────────────────────────────────────────

describe("one provider per agent", () => {
  /**
   * Runs `setup` in a fresh process and reports what reached the catalogue.
   *
   * Note: a real host context is **not** built. The plugin only reads `options`,
   * `provider.transform` and `event.subscribe`, and the editor is the part under
   * test here: `list()` decides whether a provider id is refused, so a minimal
   * editor lacking it would quietly skip the check instead of exercising it.
   */
  const setup = async (
    agents: string,
    catalogue: string = "[]",
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    const script = `
      const module = await import(${JSON.stringify(PLUGIN)})
      const added = []
      const catalogue = ${catalogue}
      const context = new Proxy({}, {
        get: (_target, key) => {
          if (key === "options") return { agents: ${agents}, refreshMs: 0 }
          if (key === "provider") return {
            transform: (fn) => {
              fn({ add: (entry) => { added.push(entry) }, list: () => catalogue })
              return Promise.resolve({ dispose: () => {} })
            },
            reload: () => Promise.resolve(),
          }
          if (key === "event") return { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) }
          return undefined
        },
      })
      const dispose = await module.default.setup(context)
      console.log(JSON.stringify({
        dispose: typeof dispose,
        providers: added.map((entry) => ({
          id: entry.info.id,
          name: entry.info.name,
          models: entry.models.map((m) => m.id),
          settings: entry.info.settings,
        })),
      }))
      await dispose?.()
      process.exit(0)
    `
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, stdout, stderr }
  }

  /** One entry of the JSON the harness above prints. */
  interface Published {
    readonly id: string
    readonly name: string
    readonly models: readonly string[]
    readonly settings: Readonly<Record<string, unknown>>
  }

  const read = (stdout: string): { dispose: string; providers: readonly Published[] } => {
    const parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed !== "object" || parsed === null) throw new Error(stdout)
    return parsed as { dispose: string; providers: readonly Published[] }
  }

  /** A list of two entries, each running the same fake agent under its own name. */
  const twoAgents = (first: string, second: string) =>
    `[
      { ${first} command: process.execPath, args: ["run", ${JSON.stringify(FAKE)}] },
      { ${second} command: process.execPath, args: ["run", ${JSON.stringify(FAKE)}] },
    ]`

  const NAMED = (id: string) => `id: ${JSON.stringify(id)},`

  test("two named agents are published side by side, each with its own inventory", async () => {
    const { code, stdout, stderr } = await setup(twoAgents(NAMED("copilot"), NAMED("codex")))
    expect(code).toBe(0)
    // The whole point of R2: `acp-copilot/…` and `acp-codex/…` coexist in `/model`.
    const { dispose, providers } = read(stdout)
    expect(dispose).toBe("function")
    expect(providers.map((entry) => entry.id)).toEqual(["acp-copilot", "acp-codex"])
    for (const entry of providers) {
      // Its **own** inventory, published with its own models...
      expect(entry.models).toEqual(["gpt-5.6-terra", "claude-sonnet-5"])
      // ... and its own id, carried to the transport through the settings: that
      // key is the only way `model()` learns which provider it is building.
      expect(entry.settings["provider"]).toBe(entry.id)
      expect(entry.settings["command"]).toBe(process.execPath)
    }
    // Both reached the catalogue, and neither was reported as dropped.
    expect(stderr).not.toContain("non enregistré")
    expect(stderr).toContain("2 provider(s) ACP : acp-copilot, acp-codex")
  }, 30_000)

  test("an unnamed agent keeps the `acp` provider id, so old configurations still apply", async () => {
    // The backward-compatibility half: a `providers.acp.settings` block in a
    // user's `opencode.jsonc` must keep addressing the same provider.
    const { code, stdout } = await setup(twoAgents(NAMED("copilot"), ""))
    expect(code).toBe(0)
    const { providers } = read(stdout)
    expect(providers.map((entry) => entry.id)).toEqual(["acp-copilot", "acp"])
    // The default id is **not** published: a hand-written `providers.acp.settings`
    // must be handed back exactly as the user wrote it.
    expect(providers[1]?.settings).toEqual({ command: process.execPath, args: ["run", FAKE] })
  }, 30_000)

  test("the session mode travels per agent, and an entry that says nothing adds no key", async () => {
    // The gap this closes, end to end: `session` existed in the settings but had
    // no way in from an agent entry, so a multi-agent configuration could not put
    // one agent in `reuse` and another in `fresh`.
    const { code, stdout } = await setup(`[
      { ${NAMED("rapide")} command: process.execPath, args: ["run", ${JSON.stringify(FAKE)}], session: "reuse" },
      { ${NAMED("prudent")} command: process.execPath, args: ["run", ${JSON.stringify(FAKE)}], session: "fresh" },
      { ${NAMED("muet")} command: process.execPath, args: ["run", ${JSON.stringify(FAKE)}] },
    ]`)
    expect(code).toBe(0)
    const { providers } = read(stdout)
    const settingsOf = (id: string): Readonly<Record<string, unknown>> => {
      const entry = providers.find((candidate) => candidate.id === `acp-${id}`)
      if (entry === undefined) throw new Error(`provider absent : acp-${id}`)
      return entry.settings
    }
    expect(settingsOf("rapide")["session"]).toBe("reuse")
    expect(settingsOf("prudent")["session"]).toBe("fresh")
    // Absent, not `"fresh"`: an undefined value published as such would overwrite,
    // at merge time, whatever the user put in `providers.acp-muet.settings`.
    expect(Object.keys(settingsOf("muet"))).not.toContain("session")
  }, 30_000)

  test("an agent that does not start does not prevent the others from registering", async () => {
    // The failure mode that mattered when a single provider was registered: one
    // broken entry in the list used to cost the user the whole configuration.
    const { code, stdout, stderr } = await setup(`[
      { ${NAMED("fantome")} command: "opencode-acp-commande-inexistante-42" },
      { ${NAMED("copilot")} command: process.execPath, args: ["run", ${JSON.stringify(FAKE)}] },
    ]`)
    expect(code).toBe(0)
    expect(read(stdout).providers.map((entry) => entry.id)).toEqual(["acp-copilot"])
    // And the failure is still explained, with the agent it concerns.
    expect(stderr).toContain("agent « fantome » indisponible")
  }, 30_000)

  test("two agents claiming the same id: the first wins, and the loser is named", async () => {
    // `editor.add` **replaces** the entry with the same id, so letting the
    // second through would hand `/model` the second agent's models under the
    // first agent's name - a silent substitution.
    const { code, stdout, stderr } = await setup(twoAgents(NAMED("copilot"), NAMED("Copilot")))
    expect(code).toBe(0)
    // `Copilot` and `copilot` normalise to the same id: the normalisation is
    // what makes that collision detectable at all.
    expect(read(stdout).providers.map((entry) => entry.id)).toEqual(["acp-copilot"])
    expect(stderr).toContain("agent « Copilot » ignoré")
    expect(stderr).toContain("acp-copilot")
  }, 30_000)

  test("an id already taken by another provider is refused, and the log says so", async () => {
    // The collision that the `acp-` prefix makes improbable but cannot forbid:
    // the user may have declared a provider under that very id.
    const taken = `[{ provider: { id: "acp-copilot" }, models: new Map() }]`
    const { code, stdout, stderr } = await setup(twoAgents(NAMED("copilot"), NAMED("codex")), taken)
    expect(code).toBe(0)
    // The other agent is published, and the refused one is named with what to
    // do about it - rather than overwriting a provider the user configured.
    expect(read(stdout).providers.map((entry) => entry.id)).toEqual(["acp-codex"])
    expect(stderr).toContain("« acp-copilot »")
    expect(stderr).toContain("déjà pris")
    expect(stderr).toContain("1 agent(s) écarté(s)")
  }, 30_000)

  test("no agent at all: nothing is published, and it is said once", async () => {
    const { code, stdout, stderr } = await setup(`[
      { ${NAMED("fantome")} command: "opencode-acp-commande-inexistante-42" },
    ]`)
    expect(code).toBe(0)
    // `dispose: "undefined"` is the contract with the host: nothing registered,
    // nothing to undo at unload.
    expect(read(stdout)).toEqual({ dispose: "undefined", providers: [] })
    expect(stderr).toContain("aucun agent enregistré")
  }, 30_000)
})
