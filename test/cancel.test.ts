/**
 * A.5 — Annulation : `session/cancel` de bout en bout (§14, R6 / §8).
 *
 * C'est la condition de « `Esc` interrompt proprement ». Ce qui la rend
 * difficile à prouver, c'est qu'un retour rapide ne prouve **rien** : un client
 * qui cesse simplement d'attendre rend la main tout aussi vite, tout en
 * laissant l'agent travailler dans notre dos jusqu'au bout du tour — et en
 * gardant sa session occupée pour le tour suivant.
 *
 * Chaque test ci-dessous porte donc **deux** assertions distinctes :
 *
 *   1. le temps — l'interruption se termine en quelques centaines de ms, pas à la
 *      durée du tour ;
 *   2. la **preuve** — `FAKE_CANCEL_FILE` note chaque `session/cancel` réellement
 *      reçu par l'agent, donc on ne peut pas passer en abandonnant en silence.
 *
 * ⚠️ Ce que la voie d'annulation n'est **pas** : un `finish`. Une annulation
 * n'est pas un tour réussi, et émettre un événement terminal après que le
 * consumer a abandonné produirait un `finish` orphelin — exactement la
 * troncature que `@opencode/ai` signale par « The provider response ended
 * unexpectedly. » (§4.0).
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Effect, Result, Stream } from "effect"
import {
  GenerationOptions,
  LLMRequest,
  Message,
  SystemPart,
  ToolEntry,
} from "@opencode/ai/schema/index"
import type { LanguageModel, LLMEvent } from "@opencode/ai/schema/index"

import { closeCachedAgents } from "../src/adapters/opencode-transport.js"
import type { AcpEvent } from "../src/core/types.js"
import type { AcpPrepared } from "../src/adapters/opencode-transport.js"
import { model } from "../src/index.js"
import { parseSettings } from "../src/settings.js"
import type { AcpProviderSettings } from "../src/settings.js"

const FAKE = fileURLToPath(new URL("./fake-acp.ts", import.meta.url))
const ROOT = fileURLToPath(new URL("..", import.meta.url))

/** Le transport ACP ne fait jamais de HTTP : l'exécuteur doit mourir bruyamment. */
const NO_HTTP = { http: { execute: () => Effect.die("le transport ACP ne fait pas de HTTP") } }

afterAll(async () => {
  await closeCachedAgents()
})

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────────────────────────────────────

const temporary: string[] = []

const temporaryDirectory = async (label: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), `acp-cancel-${label}-`))
  temporary.push(directory)
  return directory
}

afterAll(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })))
})

const settingsOf = (env: Record<string, string>): AcpProviderSettings => {
  const parsed = parseSettings({
    command: process.execPath,
    args: ["run", FAKE],
    cwd: ROOT,
    stderr: "ignore",
    env,
  })
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.value
}

const requestFor = (languageModel: LanguageModel, text: string): LLMRequest =>
  new LLMRequest({
    model: languageModel,
    system: [SystemPart.make("Tu es un assistant.")],
    tools: [ToolEntry.make({ name: "read", description: "Lit", inputSchema: { type: "object" } })],
    messages: [Message.user(text)],
    generation: GenerationOptions.make({ maxTokens: 100 }),
  })

/** Les `session/cancel` reçus par l'agent, avec leur horodatage. */
const cancelsOf = async (file: string): Promise<number[]> =>
  (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => Number(line.split(" ")[0] ?? "NaN"))

/** Attend qu'une lecture atteigne une taille, ou le délai. */
const waitFor = async <A>(read: () => Promise<A>, size: (value: A) => number, expected: number, timeoutMs = 5_000): Promise<A> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (size(value) >= expected) return value
    if (Date.now() >= deadline) return value
    await Bun.sleep(20)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Les tests
// ─────────────────────────────────────────────────────────────────────────────

describe("annulation d'un tour lent, à travers la vraie route", () => {
  test("interrompre le stream annule le tour en quelques centaines de ms, et l'agent le voit", async () => {
    // `TICK` : un `thought` immédiat, puis **30 s** de latence interruptible.
    // C'est le `thought` qui reste streamé en direct (le texte est tamponné
    // jusqu'au `done`), donc c'est lui qu'on attend — puis on coupe.
    const directory = await temporaryDirectory("slow")
    const cancelFile = join(directory, "cancels.log")
    const settings = settingsOf({ FAKE_SLOW_MS: "30000", FAKE_CANCEL_FILE: cancelFile })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = requestFor(languageModel, "TICK")

    const started = Date.now()
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const route = languageModel.route
          const body = yield* route.body.from(request)
          const prepared: AcpPrepared = yield* route.prepareTransport(body, request)
          // `Stream.take(2)` : on consomme le `step-start` et le `reasoning-start`,
          // puis on abandonne — c'est exactement ce que fait le TUI sur `Esc`.
          return yield* Stream.runCollect(
            route.streamPrepared(prepared, request, NO_HTTP).pipe(Stream.take(2)),
          )
        }),
      ).pipe(Effect.result),
    )
    const elapsed = Date.now() - started

    // 1. Le temps. 30 s de latence côté agent : sans annulation, ce test durait
    //    30 s. On tolère 2 s pour absorber le faux départ et la fermeture.
    expect(elapsed).toBeLessThan(2_000)

    // 2. Le flux s'arrête proprement, sans événement terminal orphelin.
    expect(Result.isSuccess(outcome)).toBe(true)
    if (Result.isFailure(outcome)) return
    const seen: readonly LLMEvent[] = outcome.success
    expect(seen.map((event) => event.type)).toEqual(["step-start", "reasoning-start"])
    expect(seen.some((event) => event.type === "finish")).toBe(false)
    expect(seen.some((event) => event.type === "provider-error")).toBe(false)

    // 3. Et surtout : `session/cancel` est **parti**. C'est l'assertion qui
    //    distingue une annulation d'un abandon.
    const cancels = await waitFor(async () => cancelsOf(cancelFile), (c: number[]) => c.length, 1)
    expect(cancels.length).toBeGreaterThanOrEqual(1)
    // L'annulation est postérieure au début du tour, évidemment.
    expect(cancels[0] ?? 0).toBeGreaterThanOrEqual(started)
  })

  test("un tour annulé ne rend pas l'agent inutilisable", async () => {
    // ⚠️ L'annulation ne doit pas seulement être rapide : elle doit être
    // **propre**. Une session ou un agent empoisonnés par l'annulation ferait
    // échouer tous les tours suivants, ce qui est pire qu'un tour non annulé.
    const directory = await temporaryDirectory("reuse")
    const cancelFile = join(directory, "cancels.log")
    // 1 500 ms de latence : assez pour que l'interruption soit **mesurable**
    // (sans elle, le tour prendrait 1 500 ms au lieu de ~300), assez court pour
    // que le tour nominal de vérification tienne dans le délai du test.
    const settings = settingsOf({ FAKE_SLOW_MS: "1500", FAKE_CANCEL_FILE: cancelFile })
    const languageModel = model("gpt-5.6-terra", settings)

    const interrupt = async (text: string): Promise<void> => {
      const request = requestFor(languageModel, text)
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const route = languageModel.route
            const body = yield* route.body.from(request)
            const prepared: AcpPrepared = yield* route.prepareTransport(body, request)
            return yield* Stream.runCollect(
              route.streamPrepared(prepared, request, NO_HTTP).pipe(Stream.take(2)),
            )
          }),
        ).pipe(Effect.result),
      )
    }

    const started = Date.now()
    await interrupt("TICK")
    await interrupt("TICK")
    // Chaque interruption a bien coûté la latence du tour, et pas plus.
    expect(Date.now() - started).toBeLessThan(3_000)
    const cancels = await waitFor(async () => cancelsOf(cancelFile), (c: number[]) => c.length, 2)
    expect(cancels.length).toBeGreaterThanOrEqual(2)

    // Le même agent sert ensuite un tour normal : le cache de processus n'a pas
    // été corrompu, et la latence du faux ne gêne pas un tour sans `TICK`.
    const request = requestFor(languageModel, "PING")
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const route = languageModel.route
          const body = yield* route.body.from(request)
          const prepared: AcpPrepared = yield* route.prepareTransport(body, request)
          return yield* Stream.runCollect(route.streamPrepared(prepared, request, NO_HTTP))
        }),
      ).pipe(Effect.result),
    )
    expect(Result.isSuccess(outcome)).toBe(true)
    if (Result.isFailure(outcome)) return
    const text = outcome.success
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join("")
    expect(text).toBe("PONG")
  }, 15_000)

  test("un tour nominal n'envoie aucun `session/cancel`", async () => {
    // Le contre-sens : armer l'annulation dès l'ouverture, ou trop tôt,
    // produirait des annulations sur des tours parfaitement terminés — et
    // l'agent s'interromprait lui-même en cours de route.
    const directory = await temporaryDirectory("nominal")
    const cancelFile = join(directory, "cancels.log")
    const settings = settingsOf({ FAKE_SLOW_MS: "50", FAKE_CANCEL_FILE: cancelFile })
    const languageModel = model("gpt-5.6-terra", settings)
    const request = requestFor(languageModel, "PING")

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const route = languageModel.route
          const body = yield* route.body.from(request)
          const prepared: AcpPrepared = yield* route.prepareTransport(body, request)
          return yield* Stream.runCollect(route.streamPrepared(prepared, request, NO_HTTP))
        }),
      ).pipe(Effect.result),
    )
    expect(Result.isSuccess(outcome)).toBe(true)
    if (Result.isFailure(outcome)) return
    expect(outcome.success.map((event) => event.type)).toEqual([
      "step-start",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
      "finish",
    ])
    // Le fichier n'existe que si une annulation a été reçue : on donne un tour
    // de délai au faux pour cela, puis on vérifie qu'il est **absent**.
    await Bun.sleep(200)
    const cancels = await cancelsOf(cancelFile).catch(() => [])
    expect(cancels).toEqual([])
  })
})

describe("annulation d'un tour lent, à travers la session ACP", () => {
  test("un `AbortSignal` atteint la session, sans passer par la route", async () => {
    // Le niveau en dessous du transport : c'est là qu'est le `finally` qui envoie
    // `session/cancel`, et c'est donc le niveau où une régression du câblage
    // se verrait en premier.
    const directory = await temporaryDirectory("session")
    const cancelFile = join(directory, "cancels.log")
    const { createAcpAgent } = await import("../src/acp/agent.js")
    const agent = await createAcpAgent({
      command: process.execPath,
      args: ["run", FAKE],
      stderr: "ignore",
      env: { FAKE_SLOW_MS: "30000", FAKE_CANCEL_FILE: cancelFile },
    })
    try {
      const session = await agent.open()
      const controller = new AbortController()
      const started = Date.now()
      const events: AcpEvent[] = []
      for await (const event of session.prompt(
        { system: [], tools: [], messages: [{ role: "user", text: "TICK" }] },
        { signal: controller.signal },
      )) {
        events.push(event)
        if (event.type === "thought") controller.abort()
      }
      expect(Date.now() - started).toBeLessThan(2_000)
      // Le tour se termine par un `done` explicite : jamais par une troncature.
      expect(events.at(-1)).toEqual({ type: "done", stopReason: "cancelled" })
      const cancels = await waitFor(async () => cancelsOf(cancelFile), (c: number[]) => c.length, 1)
      expect(cancels.length).toBeGreaterThanOrEqual(1)
      await session.close()
    } finally {
      await agent.close()
    }
  })
})
