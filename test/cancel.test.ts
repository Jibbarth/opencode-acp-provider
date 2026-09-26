/**
 * Cancellation: `session/cancel` end to end.
 *
 * This is the condition for "Esc interrupts cleanly". What makes it hard to
 * prove is that a fast return proves **nothing**: a client that simply stops
 * waiting returns just as fast, while leaving the agent working behind our back
 * until the end of the turn - and keeping its session busy for the next one.
 *
 * Each test below therefore carries **two** distinct assertions:
 *
 *   1. the timing - the interruption ends within a few hundred ms, not after the
 *      full turn;
 *   2. the **proof** - `FAKE_CANCEL_FILE` records every `session/cancel` the
 *      agent actually received, so silently abandoning cannot pass.
 *
 * Note: what the cancellation path is **not**: a `finish`. A cancellation is not
 * a successful turn, and emitting a terminal event after the consumer abandoned
 * would produce an orphan `finish` - exactly the truncation `@opencode/ai`
 * reports as "The provider response ended unexpectedly."
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

/** The ACP transport never does HTTP: the executor must die loudly. */
const NO_HTTP = { http: { execute: () => Effect.die("the ACP transport does no HTTP") } }

afterAll(async () => {
  await closeCachedAgents()
})

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
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
    system: [SystemPart.make("You are an assistant.")],
    tools: [ToolEntry.make({ name: "read", description: "Lit", inputSchema: { type: "object" } })],
    messages: [Message.user(text)],
    generation: GenerationOptions.make({ maxTokens: 100 }),
  })

/** The `session/cancel` the agent received, with their timestamps. */
const cancelsOf = async (file: string): Promise<number[]> =>
  (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => Number(line.split(" ")[0] ?? "NaN"))

/** Waits until a read reaches a size, or the delay elapses. */
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
// The tests
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelling a slow turn, through the real route", () => {
  test("interrupting the stream cancels the turn within a few hundred ms, and the agent sees it", async () => {
    // `TICK`: an immediate `thought`, then **30 s** of interruptible latency.
    // The `thought` is what keeps streaming live (the text is buffered until the
    // `done`), so it is what we wait for - and then we cut.
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
          // `Stream.take(2)`: the `step-start` and the `reasoning-start` are
          // consumed, then we abandon - exactly what the TUI does on `Esc`.
          return yield* Stream.runCollect(
            route.streamPrepared(prepared, request, NO_HTTP).pipe(Stream.take(2)),
          )
        }),
      ).pipe(Effect.result),
    )
    const elapsed = Date.now() - started

    // 1. The timing. 30 s of agent-side latency: without cancellation this test
    //    would take 30 s. 2 s is allowed to absorb the fake's startup and the
    //    shutdown.
    expect(elapsed).toBeLessThan(2_000)

    // 2. The stream stops cleanly, with no orphan terminal event.
    expect(Result.isSuccess(outcome)).toBe(true)
    if (Result.isFailure(outcome)) return
    const seen: readonly LLMEvent[] = outcome.success
    expect(seen.map((event) => event.type)).toEqual(["step-start", "reasoning-start"])
    expect(seen.some((event) => event.type === "finish")).toBe(false)
    expect(seen.some((event) => event.type === "provider-error")).toBe(false)

    // 3. And above all: `session/cancel` **went out**. That is the assertion
    //    telling a cancellation apart from an abandonment.
    const cancels = await waitFor(async () => cancelsOf(cancelFile), (c: number[]) => c.length, 1)
    expect(cancels.length).toBeGreaterThanOrEqual(1)
    // The cancellation is after the start of the turn, obviously.
    expect(cancels[0] ?? 0).toBeGreaterThanOrEqual(started)
  })

  test("a cancelled turn does not render the agent unusable", async () => {
    // Note: a cancellation must not only be fast, it must be **clean**. A
    // session or an agent poisoned by the cancellation would make every
    // following turn fail, which is worse than an uncancelled turn.
    const directory = await temporaryDirectory("reuse")
    const cancelFile = join(directory, "cancels.log")
    // 1500 ms of latency: enough for the interruption to be **measurable**
    // (without it the turn would take 1500 ms instead of ~300), short enough
    // for the nominal verification turn to fit in the test's timeout.
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
    // Each interruption did cost the turn's latency, and no more.
    expect(Date.now() - started).toBeLessThan(3_000)
    const cancels = await waitFor(async () => cancelsOf(cancelFile), (c: number[]) => c.length, 2)
    expect(cancels.length).toBeGreaterThanOrEqual(2)

    // The same agent then serves a normal turn: the process cache was not
    // corrupted, and the fake's latency does not hinder a turn without `TICK`.
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

  test("a nominal turn sends no `session/cancel`", async () => {
    // The opposite mistake: arming the cancellation at open time, or too early,
    // would produce cancellations on perfectly finished turns - and the agent
    // would interrupt itself mid-way.
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
    // The file only exists if a cancellation was received: the fake is given a
    // moment for that, and it is then verified to be **absent**.
    await Bun.sleep(200)
    const cancels = await cancelsOf(cancelFile).catch(() => [])
    expect(cancels).toEqual([])
  })
})

describe("cancelling a slow turn, through the ACP session", () => {
  test("an `AbortSignal` reaches the session, bypassing the route", async () => {
    // The level below the transport: that is where the `finally` sending
    // `session/cancel` lives, and therefore the level where a wiring regression
    // shows up first.
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
      // The turn ends with an explicit `done`: never with a truncation.
      expect(events.at(-1)).toEqual({ type: "done", stopReason: "cancelled" })
      const cancels = await waitFor(async () => cancelsOf(cancelFile), (c: number[]) => c.length, 1)
      expect(cancels.length).toBeGreaterThanOrEqual(1)
      await session.close()
    } finally {
      await agent.close()
    }
  })
})
