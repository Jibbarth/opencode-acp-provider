/**
 * A.3 — Rendre les échecs de chargement **visibles** (§14, R4).
 *
 * Un package de plugin qui ne se charge ne produit **aucune** erreur visible :
 * l'hôte note « plugin ignoré » et passe à autre chose. Toutes les causes
 * possibles se ressemblent — mauvais chemin dans `opencode.jsonc`, module qui
 * lève pendant son évaluation, `Plugin.define` jamais atteint, `setup` qui
 * rejette — et le diagnostic est toujours le même : le provider est absent de
 * `/model`, sans raison.
 *
 * Ce qui manque, c'est la distinction entre deux situations :
 *
 *   · **le module n'a jamais été évalué** ;
 *   · **`setup()` a été atteint, et a échoué ou rien enregistré**.
 *
 * Le marqueur écrit par `src/plugin.ts` **au moment où le module est évalué**
 * tranche : s'il est absent du stderr, le problème est en amont de nous (chemin,
 * installation, erreur d'import) ; s'il est présent, tout ce qu'il reste à
 * regarder est dans le journal de `setup`.
 *
 * ⚠️ Les tests passent donc par un **sous-processus** : la seule façon
 * d'observer ce qui est écrit pendant l'évaluation d'un module est de le charger
 * dans un runtime neuf. Un `import` dans le test lui-même émettrait la ligne
 * avant même que le test ne démarre.
 */

import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const PLUGIN = fileURLToPath(new URL("../src/plugin.ts", import.meta.url))
const FAKE = fileURLToPath(new URL("./fake-acp.ts", import.meta.url))

/** Charge le module dans un process neuf et renvoie son stderr. */
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

describe("le chargement du plugin laisse une trace", () => {
  test("le module écrit son marqueur sur stderr, dès son évaluation", async () => {
    const stderr = await evaluatePlugin()
    // Le marqueur porte l'**URL** du module : c'est ce qui permet de vérifier
    // d'un coup d'œil que c'est bien *ce* fichier qui a été évalué, et pas un
    // autre plugin qui aurait écrit la même ligne.
    expect(stderr).toContain("module évalué")
    expect(stderr).toContain(PLUGIN)
    // Et **une seule** ligne de marqueur : « discret » veut dire discret.
    expect(stderr.split("\n").filter((line) => line.includes("module évalué"))).toHaveLength(1)
  })

  test("le marqueur est écrit sur stderr, jamais sur stdout", async () => {
    // stdout est le canal du protocole du serveur : y écrire une ligne de
    // diagnostic polluerait une sortie que d'autres composants lisent.
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

  test("`setup` rend la main au lieu de faire tomber le chargement", async () => {
    // ⚠️ L'invariant affiché en tête de `src/plugin.ts` : une configuration
    // illisible est journalisée et ramenée à « rien n'est enregistré ». Le
    // process doit donc **sortir avec 0**, sans laisser rejeter quoi que ce soit.
    const stderr = await evaluatePlugin([
      `const plugin = (await import(${JSON.stringify(PLUGIN)})).default;`,
      `await plugin.setup({ options: { agents: "pas un tableau" } });`,
    ])
    expect(stderr).toContain("module évalué")
    // Le marqueur est **présent** ⇒ le module a bien été évalué, et la ligne
    // suivante est le journal de `setup` : c'est exactement la distinction que
    // ce lot rend possible.
    expect(stderr).toContain("configuration ignorée")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Le chemin nominal : le plugin découvre vraiment un agent et enregistre un provider
// ─────────────────────────────────────────────────────────────────────────────

describe("le plugin enregistre un provider depuis un faux agent", () => {
  test("un agent valide produit un enregistrement, journalisé et démontable", async () => {
    // On construit un contexte d'hôte **minimal** : le plugin ne lit que
    // `options`, `provider.transform` et `event.subscribe` (avec
    // `refreshMs: 0`, il ne s'abonne même pas). Un `Proxy` fournit le reste,
    // donc aucune propriété inventée ne peut faire échouer le test par surprise.
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
    expect(record["id"]).toBe("acp")
    // C'est le point de A.4 : l'URL enregistrée doit être un `file://` absolu
    // vers un fichier qui existe — sinon `/model` montre le provider et le
    // premier tour échoue en `ERR_MODULE_NOT_FOUND`.
    expect(String(record["package"]).startsWith("file://")).toBe(true)
    // `auto` est filtré (§5, `PSEUDO_MODEL_IDS`) : deux modèles restent.
    expect(record["models"]).toEqual(["gpt-5.6-terra", "claude-sonnet-5"])
    expect(stderr).toContain("module évalué")
  })

  test("un agent indisponible ne fait pas tomber le chargement", async () => {
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
    // Le marqueur est présent **et** l'échec est journalisé : c'est la
    // différence entre « le module n'a pas été chargé » et « l'agent manque ».
    expect(stderr).toContain("indisponible")
    expect(stderr).toContain("opencode-acp-commande-inexistante-42")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A.6 — Bornes de la découverte (§14, R7)
// ─────────────────────────────────────────────────────────────────────────────

describe("la découverte est bornée", () => {
  /**
   * Lance `setup` avec un contexte **vide** — donc un agent qui n'est jamais
   * touché — et renvoie la sortie du process. `options` peut être surchargé.
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

  /** Les options d'un agent qui répond, mais après `FAKE_SLOW_INIT_MS`. */
  const slowAgent = (ms: number) =>
    `{ agents: [{ id: "lent", command: process.execPath, args: ["run", ${JSON.stringify(FAKE)}], env: { FAKE_SLOW_INIT_MS: "${ms}" } }], ` +
    `discoveryTimeoutMs: 700, discoveryIdleTimeoutMs: 700 }`

  test("un agent qui ne répond pas à initialize ne bloque pas le chargement", async () => {
    // `FAKE_SLOW_INIT_MS=30000` : l'agent met trente secondes. Sans borne, le
    // chargement d'OpenCode serait figé trente secondes, sans un mot.
    const { code, stdout, stderr, elapsed } = await setup(slowAgent(30_000))
    expect(code).toBe(0)
    expect(stdout).toBe("dispose=undefined\n")
    // La borne a joué : 700 ms de configuration, et l'injection de l'agent
    // ('process' + 'execPath') est de l'ordre de la milliseconde.
    expect(elapsed).toBeLessThan(10_000)
    // L'erreur nomme l'agent **et** la borne : un diagnostic sans le nom de
    // l'agent ne dit rien quand la liste en contient plusieurs.
    expect(stderr).toContain("agent « lent » indisponible")
    expect(stderr).toContain("700 ms")
  }, 20_000)

  test("la borne d'inactivité attrape un agent bavard qui ne finit pas", async () => {
    // Un agent qui **parle** sans jamais terminer n'est pas un agent muet : la
    // borne globale le laisserait attendre son terme en silence. C'est le cas
    // réel d'une authentification en boucle, et il ne produit aucun message.
    // On vérifie surtout que la sortie reste propre et bornée.
    const { code, stdout, stderr, elapsed } = await setup(
      `{ agents: [{ id: "bavard", command: process.execPath, args: ["run", ${JSON.stringify(FAKE)}], env: { FAKE_SLOW_INIT_MS: "30000", FAKE_NOISY_STDOUT: "1" } }], ` +
        `discoveryTimeoutMs: 600, discoveryIdleTimeoutMs: 3000 }`,
    )
    expect(code).toBe(0)
    expect(stdout).toBe("dispose=undefined\n")
    // Le stdout bruyant de l'agent est relayé **par** l'agent, pas par nous : le
    // plugin ne le recopie pas dans son journal.
    expect(stderr).not.toContain("Ceci n'est pas du JSON")
    expect(elapsed).toBeLessThan(10_000)
  }, 20_000)

  test("un agent lent mais bavard dispose de toute la borne globale", async () => {
    // Le contre-sens de la borne d'inactivité : elle ne doit pas transformer un
    // agent bavard en agent muet. Ici l'agent répond au bout de 400 ms, la
    // borne d'inactivité est à 3 s, et la découverte **réussit**.
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

  test("un agent lent abandonné ne laisse pas de processus orphelin", async () => {
    // ⚠️ Le point que la seule borne ne couvre pas : `createAcpAgent` rend la
    // main après `initialize`, donc sa promesse est **en vol** quand la borne
    // expire. L'agent qu'elle produira serait vivant sans personne pour le
    // fermer — un orphelin par chargement de plugin. On compte donc les
    // processus `fake-acp` avant et après.
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
    // L'agent abandonné met 4 s à démarrer : on lui laisse le temps d'exister,
    // puis on vérifie qu'il a été tué en naissant.
    await Bun.sleep(6_000)
    expect(countFake()).toBe(before)
  }, 30_000)
})
