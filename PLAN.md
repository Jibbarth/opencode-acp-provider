# Plan - `opencode-acp-provider`

Expose an ACP agent (codex, copilot, gemini, qwen...) as an **OpenCode model
provider**, so that it can be used from OpenCode's TUI.

- Implementation target: `/home/barth/Projects/opencode-acp-provider` (empty directory, not versioned)
- Reference versions verified: `opencode v2.0.16`, `@opencode/ai 2.0.3`, `@opencode/plugin 2.0.3`, `effect 4.0.0-rc.112`, `bun 1.3.14`

---

## 0. Feasibility - validated by real execution

Before planning, every hypothesis was tested in a `bun` REPL against
`~/.config/opencode/node_modules`. Results:

| Hypothesis | Result |
| --- | --- |
| `providers.<id>.package` accepts an arbitrary module | ✅ `Provider.Info.package: Schema.String` (no enum); doc: "an absolute `file://` URL for a local package" |
| `Route.make` accepts a non-HTTP `transport` | ✅ `MakeTransportInput` overload (`route/client.d.ts`) |
| `Transport.execute` can emit its own frames | ✅ tested: custom transport → `Stream<Frame>` |
| The pipeline reduces our frames into valid `LLMEvent`s | ✅ tested: `["step-start","text-start","text-delta","text-end","step-finish","finish"]` |
| A malformed event sequence is rejected | ✅ `AI.Error: The provider response ended unexpectedly.` → **the mapping must be exact** |

The code that produced the evidence:

```ts
const route = make({
  id: "acp", provider: "acp", protocol,
  endpoint: E.path("/", { baseURL: "http://acp.local" }),  // placeholder
  auth: A.none,                                             // stdio ⇒ no auth
  transport,                                                // ← ours
  compact: undefined,
})
```

⚠️ The `http://acp.local` placeholder is required: the core renders the URL in
`compileRequest` (it accesses `request.model.provider`) even if the transport
ignores it.

---

## 1. Architecture decision - Option B

**Choice: custom provider package with an ACP `Transport` over stdio.**

The agent and the provider run in the **same Bun process**: the plugin is loaded
by the OpenCode server, and the `package` field is imported by that same server.
Direct communication, no port, no proxy.

### An honest B vs A comparison

| | **B - Native transport** | A - HTTP bridge |
| --- | --- | --- |
| ACP client (JSON-RPC stdio) | identical | identical |
| Extra code | 0 | HTTP server + SSE encoding + OpenAI format mapping (~200 lines) |
| Cost per token | none | 2 serialisations + 1 loopback hop |
| Process lifecycle | native `Scope` → clean kill | to be handled (idle timeout, ports, collisions) |
| `session/cancel` | direct | indirect |
| Errors / retry hook | ⚠️ **degraded** (see §8) | ✅ real HTTP status |
| `LLMEvent` reduction | ours to write, **strictly validated** | already done by the runtime |
| Coupling | ⚠️ `@opencode/ai` internals + `effect` RC | public API only |

The ACP client code is identical in both cases: B adds no layer, it avoids A's.
B's real cost is not the code, it is the **coupling** to the internals.

**Mitigation: §2's layered architecture.** The ACP client and the business core
contain **no import** of `@opencode/ai` nor of `effect`. The
`opencode-transport` adapter is a thin shell (~150 lines) on top. If the internals
move, only that shell is rewritten - or we switch to the HTTP adapter, already
written.

**Pinning:** exact versions of `@opencode/ai` and `effect` in `package.json` + a
smoke test that fails loudly if the contract changes.

---

## 2. Layered architecture - the core is portable

> ⚠️ **§2 revised after research**: an official SDK exists and covers the whole
> `acp/` layer. See **§2.0**. The layered architecture holds, but the ACP layer
> becomes a shell of a hundred-odd lines instead of ~400.

**The project's central contract is `AsyncIterable<AcpEvent>`.** Everything below
speaks ACP, everything above is an interchangeable adapter.

```
   ┌──────────────────────────────┐  ┌──────────────────────────┐  ┌──────────────┐
   │ adapters/opencode-transport   │  │ adapters/openai-http      │  │ adapters/cli  │
   │  Effect Transport + Protocol  │  │  /v1 SSE server          │  │  acp-run      │
   │  → LLMEvent   (~150 l.)       │  │  → OpenAI SSE   (~150 l.) │  │  (~60 l.)     │
   │  ⚠️ coupled to internals      │  │  ✅ portable               │  │  ✅ portable  │
   └───────────────┬──────────────┘  └────────────┬─────────────┘  └──────┬───────┘
                   │                            │                       │
   ┌───────────────┴────────────────────────────┴───────────────────────┴───────┐
   │  core/   -  NO dependency on any framework                                   │
   │   • prompt.ts   prompt construction (system + tool catalogue +              │
   │                 transcript + JSON contract)   <- §7.3, shared by all         │
   │   • normalize   common request model (system / tools / messages)             │
   │   • models.ts   inventory discovery via configOptions (§5)                  │
   └───────────────────────────────┬─────────────────────────────────────────────┘
                                   │
   ┌───────────────────────────────┴─────────────────────────────────────────────┐
   │  acp/   -  ACP protocol, zero import of anything                            │
 │   │   ├── agent.ts          #   spawn + ndJsonStream + client() + handlers
   └─────────────────────────────────────────────────────────────────────────────┘
```

### 2.0 The official SDK - `@agentclientprotocol/sdk`

**It exists and it is very complete.** npm package `@agentclientprotocol/sdk`,
**v1.5.0**, published by the ACP team (repository: `agentclientprotocol/typescript-sdk`).

It provides **both sides** of the protocol (agent *and* client). On the client
side, what it covers:

| Need | SDK API | Lines saved |
| --- | --- | --- |
| NDJSON JSON-RPC framing over stdio | `acp.ndJsonStream(input, output)` | ~150 |
| Typed client, handler registration | `acp.client({name}).onRequest(method, fn).connectWith(stream, fn)` | ~80 |
| Session lifecycle | `ctx.buildSession(cwd).withSession(s => …)`, `withMcpServer()`, `withAdditionalDirectories()` | ~150 |
| Prompt ↔ updates loop | `session.prompt(...)`, `session.nextUpdate()` → `{kind:"update"\|"stop"}`, `session.readText()` | ~100 |
| Permissions | `.onRequest(acp.methods.client.session.requestPermission, fn)` | ~80 |
| Protocol types | `schema/schema.json` + generated types | ~120 |
| `initialize`, `set_config_option`, `cancel` | `ctx.request(acp.methods.agent.…)` typed per method | ~60 |

**Validated in real execution** against `copilot --acp` (see `probe/sdk-inspect.mjs`):
initialize, session, inventory, prompt, permission, `stopReason` and `usage` -
**under Node AND under Bun**, which matters since the provider runs in OpenCode's
Bun runtime.

#### What it changes

- The project's `acp/` layer goes from **~400 lines to ~120** of glue.
- The protocol typing is no longer our burden.
- **The transport becomes interchangeable**: `ndJsonStream` (stdio) by default,
  but the SDK also exports `experimental/ws-client` (`createWebSocketStream`) and
  `experimental/http-client`. If an agent ever exposes ACP over WebSocket/HTTP,
  we change **one function** - the rest of the code is unchanged. That confirms
  the stdio decision (§13, Q5).
- There are even `ws-client` / `http-client` / `http-server` examples in the SDK.

#### What it introduces

- **`zod` is a `peerDependency`** (`^3.25 || ^4`) → to be installed explicitly.
- One more external dependency to pin (like `@opencode/ai`).
- `AgentSideConnection` / `ClientSideConnection` are **deprecated** in favour of
  the fluid `client()` / `agent()` APIs: do not rely on the old classes.

#### Verdict

**We use the SDK.** Writing our own JSON-RPC client would be a waste. The `core/`
(prompt, parse, models) stays entirely ours - that is where the real value is.

### 2.1 The core API (the pivot point)

```ts
// core/types.ts
export type AcpEvent =
  | { type: "text";    text: string }
  | { type: "thought"; text: string }
  | { type: "tool";    id: string; name: string; input: unknown; status: string; output?: unknown }
  | { type: "plan";    entries: readonly PlanEntry[] }
  | { type: "usage";   input?: number; output?: number }
  | { type: "done";    stopReason: "end_turn" | "max_tokens" | "refusal" | "cancelled" }
  | { type: "error";   message: string }

export interface AcpAgent {
  readonly info: { name: string; version: string }
  models(): Promise<readonly AcpModel[]>
  open(options?: { cwd?: string; signal?: AbortSignal }): Promise<AcpSession>
}

export interface AcpSession {
  setModel(modelID: string): Promise<void>
  setOption(configId: string, value: string): Promise<void>
  /** The ONLY point the three adapters have in common. */
  prompt(request: NormalizedRequest, options?: { signal?: AbortSignal }): AsyncIterable<AcpEvent>
  close(): Promise<void>
}
```

`core/prompt.ts` takes a `NormalizedRequest` **independent of OpenCode**:

```ts
interface NormalizedRequest {
  system: readonly string[]
  tools: readonly { name: string; description: string; schema: unknown }[]
  messages: readonly NormalizedMessage[]   // { role, text } | { role:"tool", name, output }
  maxOutputTokens?: number
  thinkingLevel?: string
}
```

The OpenCode adapter converts `LLMRequest` → `NormalizedRequest`; the HTTP
adapter converts the OpenAI body → `NormalizedRequest`. **The business logic
(prompt construction, JSON output parsing, permission policy) exists only
once.**

### 2.2 What is left if we leave OpenCode?

| Component | Lines | Portable? |
| --- | --- | --- |
| `acp/` (glue to the SDK: spawn + stream + handlers) | ~120 | ✅ entirely |
| `core/` (prompt, parse, models, events) | ~300 | ✅ entirely |
| `adapters/openai-http` | ~150 | ✅ reusable as is |
| `adapters/cli` | ~60 | ✅ |
| `adapters/opencode-transport` (Transport + Protocol + LLMEvent) | ~150 | ❌ **the only one to throw away** |
| `plugin.ts` | ~120 | ❌ **the only one to throw away** |

That is **~800 lines of which ~630 survive**, and the 270 to be thrown away are
themselves replaceable by the HTTP adapter in ~150 lines.

### 2.3 Why the HTTP bridge is not a plan B, it is a **tool**

The two are not exclusive, they add up:

- **Debugging**: `curl` against the bridge to see what the agent really
  produces.
- **Sharing a single agent** between opencode, Zed, Claude Code, etc.
- **Broad compatibility**: any OpenAI-compatible client (Cline, Continue,
  Aider...) can consume the ACP agent without installing a plugin.
- **A safety net**: if the `@opencode/ai` internals move (§1), we switch
  `package` to `@opencode/ai/providers/openai-compatible` + `baseURL` without
  rewriting the core.

And the simplest case stays open: **if the alternative is another ACP client**
(Zed, Gemini CLI), there is nothing to write - we point the ACP client at the
agent directly.

### 2.4 Repository structure

```
opencode-acp-provider/
├── package.json
├── tsconfig.json
├── src/
│   ├── acp/                  # layer 3 - glue on the official SDK (~120 l., cf. §2.0)
│   │   ├── agent.ts          #   spawn + ndJsonStream + client() + handlers
│   │   ├── transport.ts      #   ndJsonStream | ws-stream | http-stream  (§2.0)
│   │   └── policy.ts         #   options config (allow_all, effort, model)
│   ├── core/                 # layer 2 - shared business logic, 100% ours
│   │   ├── types.ts          #   AcpEvent / AcpAgent / AcpSession / NormalizedRequest
│   │   ├── agent.ts          #   AcpAgent built on the SDK
│   │   ├── prompt.ts         #   §7.3 - prompt construction + output contract
│   │   ├── parse.ts          #   extraction/validation of the agent's JSON output
│   │   └── models.ts         #   §5 - inventory via configOptions
│   ├── adapters/             # layer 1 - interchangeable
│   │   ├── opencode-transport.ts   # Effect Transport + Protocol + LLMEvent
│   │   ├── opencode-protocol.ts    #   LLMEvent ↔ AcpEvent
│   │   ├── openai-http.ts          #   /v1/chat/completions server (SSE)
│   │   └── cli.ts                  #   `acp-run` binary
│   ├── index.ts              # provider entry point  → exports `model`
│   ├── plugin.ts             # OpenCode plugin entry point
│   └── settings.ts
├── bin/
│   └── acp-run.ts
├── probe/                    # reusable ACP probes (inspect / switch-option / sdk-inspect)
└── test/
    ├── smoke.test.ts         # Route/Transport contract vs pinned @opencode/ai
    └── fake-acp.ts           # fake ACP agent (stdio)
```

---

## 3. Contracts

### 3.1 Provider `package` - minimalism

`@opencode/ai/dist/provider-package.d.ts`:

```ts
interface Definition<ProviderSettings, Options, Compact> {
  readonly model: (modelID: string, settings: ProviderSettings) => LanguageModel<Options, Compact>
}
```

`src/index.ts`:

```ts
import type { LanguageModel } from "@opencode/ai/schema/index"
import { makeRoute } from "./route"
import type { Settings } from "./settings"

export const model = (modelID: string, settings: Settings): LanguageModel => {
  const route = makeRoute(settings)
  return route.model({ id: modelID })
}
```

### 3.2 `Settings` (flat JSON - `ProviderPackage.Settings` forbids callbacks)

```ts
export interface Settings {
  command: string              // "copilot"
  args?: string[]              // ["--acp"]
  cwd?: string
  env?: Record<string, string>
  tools?: "none" | "all"       // "none" = raw-brain mode (default)
  session?: "reuse" | "fresh"
  systemSuffix?: string
}
```

Passed through `providers.<id>.settings` or, per agent, through
`models.<id>.settings` in the plugin.

### 3.3 `Transport`

```ts
export const transport: Transport<Body, AcpPrepared, string> = {
  id: "acp/stdio",
  prepare: (input) => Effect.succeed(buildPromptParams(input.body, input.request)),
  execute: (prepared, _req, _rt, _opts) =>
    Effect.gen(function* () {
      const session = yield* AcpSession.acquire(prepared)  // spawn + initialize + session/new
      const frames  = yield* session.promptFrames(prepared)
      return { frames, complete: session.release }
    }),
}
```

`execute` is typed `Effect<…, AIError, Scope>`: the end of the `Scope`
(interrupted stream, `session.cancel`) kills the process.
`TransportExecution.http` is omitted → no fake HTTP context.

### 3.4 `Protocol`

```ts
const protocol = Protocol.make({
  id: "acp",
  body: { schema: PromptBody, from: (request) => Effect.succeed(flatten(request)) },
  stream: {
    event: Protocol.jsonEvent(AcpNotification),  // one JSON line on stdout
    initial: () => ({ text: null, reasoning: null, step: 0, toolcalls: new Map() }),
    step: (state, ev) => Effect.succeed(reduce(state, ev)),
    onHalt: (state) => Effect.succeed(closeOpenBlocks(state)),
  },
})
```

---

## 4. ACP -> `LLMEvent` mapping

**Mandatory** sequence (verified): `step-start` → (`text-start` → `text-delta`* →
`text-end` | `reasoning-*` | `tool-*`) → `step-finish` → `finish`.
Everything must be closed, otherwise `The provider response ended unexpectedly.`

| ACP notification (`session/update`) | `LLMEvent` |
| --- | --- |
| `agent_message_chunk` (`text` content) | opens `text-start{id}` if closed; `text-delta{id, text}` |
| `agent_thought_chunk` | `reasoning-start{id}` / `reasoning-delta{id,text}` / `reasoning-end{id}` |
| `tool_call` (`pending`/`in_progress` status) | `tool-input-start` + `tool-input-delta` (streaming `rawInput`) + `tool-input-end`, then `tool-call{ id, name, input, providerExecuted }` |
| `tool_call_update` → `completed`/`failed` | `tool-result{ id, name, result: {type:"text"\|"error", value} }` |
| `tool_call_update` → `diff` | `tool-call.locations` / `rawOutput` content |
| `plan` | `reasoning-*` (or a dedicated `plan` tool) |
| `config_option_update` | ignored on the `LLMEvent` side; triggers `ctx.provider.reload()` (§5) |
| `usage_update` | cumulative counter; `finish.usage` at the end of the turn (see below) |
| `session_info_update` | ignored (session metadata) |
| `available_commands_update` | ignored, or exposed as OpenCode commands (§6) |
| `session/prompt` finished | `step-finish` then `finish` (see §5 for `usage`) |

`finish.reason.normalized`: ACP `stopReason` → `"stop"` / `"tool-calls"` (depending
on config) / `"error"`. Both `step-finish` and `finish` carry `reason` + `index`.

### 4.0 Event sequences - validated one by one

Each shape was submitted to the real pipeline (`Route` + custom `Transport`)
under Bun. Results:

| Emitted sequence | Verdict |
| --- | --- |
| `step-start` → `text-*` → `step-finish` → `finish` | ✅ |
| `reasoning-*` then `text-*` | ✅ |
| `tool-input-*` → `tool-call` → `tool-result` | ✅ |
| **`tool-call` alone, without `tool-result`** | ✅ |
| `tool-call` + `tool-result` with `providerExecuted: true` | ✅ |
| `text-*` then `tool-call` in the same step | ✅ |
| `tool-call` then `tool-error` | ✅ |

> 🔎 **The two results most important for the design:**
>
> 1. **A lone `tool-call` is accepted.** That is exactly what §7.3's mechanism
>    needs: the provider **proposes**, OpenCode **executes** and returns the
>    result on the next turn. So we must not emit a `tool-result` in that mode -
>    the core takes care of it.
>
> 2. **`usage` must be an instance of the `Usage` class**, not a literal object.
>    A plain object fails with `The provider response ended unexpectedly.` - a
>    message **identical** to the one of a truncated stream, hence almost
>    impossible to diagnose. Always build it via `new Usage({ … })` imported
>    from `@opencode/ai/schema/index`.

This state machine (`open`/`text`/`reasoning`/`tool`) is the reference spec for
`adapters/opencode-protocol.ts` in P1/P2.

### 4.1 `usage` - measured, it works

`PromptResponse` carries a complete `usage`, and a `usage_update` notification
updates it during the turn. Real reading on `copilot --acp`:

```json
{ "stopReason": "end_turn",
  "usage": { "inputTokens": 15076, "outputTokens": 13, "totalTokens": 15089,
             "thoughtTokens": 0, "cachedReadTokens": 0, "cachedWriteTokens": 15073 } }
```

The mapping to OpenCode's `Usage` is therefore **direct**:
`inputTokens`/`outputTokens`, and `cachedReadTokens`/`cachedWriteTokens` feed the
`Cache` tiers of the `Model.Info.cost` schema (§6). The "no token counting" risk
is **lifted**.

**`providerExecuted: true`** - the field exists on `tool-call`, `tool-result` and
`tool-error` (`schema/events.d.ts`) and is already consumed by the lowering
protocols (`protocols/anthropic-messages.js:657`,
`protocols/open-responses.js:505`). It is the official mechanism for "the
provider already executed the tool". **To spike** (§11, P3): check that the
core's agent loop does not re-execute those calls.

---

## 5. ACP `configOptions` → `/model` and variants

**Verified empirically** against `copilot --acp` (agent `Copilot` v1.0.88), cf. §5.1.

`session/new` returns `configOptions`; `session/set_config_option` modifies them.
Categories (`ConfigOptionCategory`):

| ACP category | OpenCode target |
| --- | --- |
| `model` | **one OpenCode model per value** → `acp-copilot/claude-sonnet-5`... |
| `thought_level` | **variants** of the model (effort / reasoning) |
| `model_config` | **variants** (context size, speed/quality trade-off) |
| `mode` | **OpenCode agents** (build ↔ `#agent`, plan ↔ `#plan`...) |
| *(outside the spec)* `permissions` | pinned to `off` in raw-brain mode (security, §7.4) |

### 5.1 Real reading - `copilot --acp`

`initialize`:

```json
{ "protocolVersion": 1,
  "agentCapabilities": { "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
    "sessionCapabilities": { "close": {}, "list": {} } },
  "agentInfo": { "name": "Copilot", "version": "1.0.88" },
  "authMethods": [ { "id": "copilot-login", "_meta": { "terminal-auth": {...} } } ] }
```

`session/new` → 4 options, distributed as follows:

```
[mode]           id=mode                current=#agent   values=[#agent, #plan, #autopilot]
[model]          id=model               current=gpt-5.6-terra
                 values=[auto, gpt-5.6-terra, gpt-5.6-luna, gpt-5.4, gpt-5.4-mini,
                         gpt-5.3-codex, gpt-5-mini, claude-sonnet-5, claude-haiku-4.5,
                         mai-code-1.1-flash, gemini-3.8-flash, gemini-3.7-flash,
                         gemini-3.6-flash, gemini-3.5-flash, grok-4.5, kimi-k3,
                         kimi-k2.7-code, gpt-6-luna, grok-4.6, grok-4.7]
[thought_level]  id=reasoning_effort    current=medium    values=[none, low, medium, high, xhigh, max]
[permissions]    id=allow_all           current=off       values=[on, off]
```

The `modes` field (inherited v1 API) is also present, with `currentModeId`.

**Model switch - tested and working:**

```
session/set_config_option { sessionId, configId: "model", value: "claude-sonnet-5" }
  → model = claude-sonnet-5   (the response returns the WHOLE state, as the doc specifies)
session/set_config_option { sessionId, configId: "reasoning_effort", value: "max" }
  → effort = max, model unchanged
session/set_config_option { configId: "model", value: "not-a-model" }
  → JSON-RPC ERROR -32602, "Invalid model", with the list of supported values
```

### 5.2 Consequences for the design

- **The inventory is dynamic**: 19 values on the first `session/new`, **20**
  after a `set_config_option`. The agent can add/remove models. The
  `config_option_update` notification must therefore be handled and
  `ctx.provider.reload()` called - an inventory frozen at startup would be wrong.
- **`auto`** is a pseudo-value: either expose it as is or filter it out.
- The mode identifiers are **URLs** (`https://agentclientprotocol.com/...#agent`)
  - to be shortened for OpenCode's display.
- `mcpCapabilities.http: true` ⇒ the agent accepts **MCP servers over HTTP/SSE**
  in `session/new.mcpServers`. That would revive §7.2's track B (exposing
  OpenCode's tools to the agent), but it remains **blocked**: the plugin API
  still has no way to **invoke** an OpenCode tool. To be re-examined if that API
  evolves.
- The model switch must be applied **before** `session/prompt`, in
  `transport.execute`.

Inventory discovery: the plugin starts the agent, calls `initialize` +
`session/new`, reads `configOptions`, then publishes one `Model.Info` per
`model` category value. Then `ctx.provider.reload()`.

---

## 6. Plugin - provider registration

```ts
import { Plugin, Provider, Model } from "@opencode/plugin"
import { pathToFileURL } from "node:url"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE = pathToFileURL(resolve(here, "../dist/index.js")).href  // absolute path

export default Plugin.define({
  id: "opencode-acp-provider",
  async setup(ctx) {
    const agents = ctx.options.agents as AgentConfig[]   // via opencode.jsonc
    const inventory = await discover(agents)            // spawn + initialize + configOptions

    const registration = await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(Provider.ID.make("acp")),
          name: "ACP",
          activation: "enabled",
          package: PACKAGE,
        },
        models: inventory.models,
      })
    })
    return () => registration.dispose()   // cleanup
  },
})
```

`Provider.Info.empty(id)` provides `id`/`name`/`activation`; we add `package`.
`package` points at an **absolute path computed from `import.meta.url`** →
portable, and the same `file://` specifier guarantees the module identity between
plugin and provider (useful if we want to share an in-process registry, §9).

Config:

```jsonc
{
  "plugins": [{ "package": "./opencode-acp-provider", "options": {
    "agents": [
      { "id": "copilot", "command": "copilot", "args": ["--acp"] },
      { "id": "codex",   "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"] }
    ]
  }}]
}
```

---

## 7. The central problem: who executes the tools?

In ACP v1, **the agent executes its own tools**; the client only *displays* and
*authorises*. OpenCode does the opposite: the model **emits** `tool-call`s and
**OpenCode executes them**.

### 7.1 The hole in the naive "raw-brain" mode

If we block the ACP agent's tools and pass it no tools, the agent answers in text
→ we only emit `text-delta` + `finish` → **the OpenCode loop sees no
`tool-call` and ends the turn. No OpenCode tool is ever triggered.**

Blocking the ACP tools is therefore not enough: the agent must **propose**
OpenCode tool calls, without executing them itself.

### 7.2 The three tracks evaluated

| Track | Verdict | Reason |
| --- | --- | --- |
| **A. Bridge with structured output** | ✅ **retained** | universal, no agent cooperation required |
| B. Expose OpenCode's tools as an MCP server to the agent (`session/new.mcpServers`) | ❌ blocked | the plugin API only exposes `tool.list` / `tool.transform` / `tool.reload` - **no way to invoke a tool** |
| C. Have the ACP client run fs/terminal (`fs/*`, `terminal/*`) | ❌ dead upstream | the ACP v2 RFC **removes that surface**: "it has not been widely adopted". And agents do not use it. |

> Note: B is nevertheless ACP v2's announced direction ("expose a special MCP
> server to the agent"). It would remain the most elegant the day the plugin API
> exposes tool invocation.

### 7.3 Retained mechanism - bridge with structured output

`body.from(request)` builds the ACP prompt from the OpenCode request:

1. **System**: `request.system` (hence AGENTS.md, instructions, injected skills)
   + a strict output contract.
2. **Tool catalogue**: the `request.tools` with their **real names and JSON
   schemas**.
3. **Transcript**: the `request.messages` rendered as text, including tool
   results.
4. **Output contract**: "Answer **only** with a JSON object, no text around it:
   `{ "type":"text", "text":"…" }` or `{ "type":"tool", "name":"<one of the tools
   above>", "arguments":{…} }`".

On the `protocol.ts` side, we parse that output:

- `{type:"text"}` → `text-start` / `text-delta` / `text-end`
- `{type:"tool"}` → `tool-input-start` / `tool-input-delta` / `tool-input-end`
  then `tool-call{ id, name, input }` - **without `providerExecuted`**, so the
  OpenCode loop really executes it (permissions, snapshots, undo, logging).
- On the next turn, the `role:"tool"` message of `request.messages` holds the
  result → we fold it back into the ACP prompt.

**Key advantage:** the tool names are imposed by our JSON, so there is **no
mapping problem** between the ACP tool names (explicitly "opaque") and
OpenCode's.

> ✅ **Validated empirically.** On `copilot --acp`, the agent obeyed the
> contract: for the instruction "answer only with a JSON object
> `{"type":"text",…}`", it produced exactly `{"type":"text","text":"pong"}`,
> streamed character by character, then `stopReason: end_turn`. The conformance
> rate still has to be measured on other agents and on more complex prompts
> (Q13.3), but the principle is demonstrated.

**Cost:** some prompt-shaping (the agent wastes tokens formatting JSON), and
malformed output has to be handled (bounded repair/retry).

### 7.4 Preventing the agent from acting anyway

In parallel with mechanism 7.3, we neutralise its native tool surface:

1. **Systematic answer to `session/request_permission`** → `optionId` of type
   `reject_*`. Requested for every tool ⇒ effective blocking even if the agent
   ignores the instructions.
2. **Surface reduction at spawn** when the agent supports it:
   - copilot: `--available-tools` ("Only these tools will be available")
   - configurable via `settings.tools: "none" | "all"`.
3. **Instruction**: "do not call any native tool" - safety net, not a guarantee.

### 7.5 What we forward

| OpenCode element | Transmission to the ACP agent |
| --- | --- |
| `request.system` (AGENTS.md, instructions) | ✅ inline at the head of the prompt - ACP has no "system" field |
| `request.tools` (+ JSON schemas) | ✅ the core of mechanism 7.3 |
| `request.messages` (transcript, tool results) | ✅ text rendering |
| **Skills** | ⚠️ no invocation possible; only the text already injected into `system` benefits |
| **OpenCode MCP servers** | ✅ `session/new.mcpServers` - read via `ctx.mcp.list()`, passed via the in-process registry (§9) |

---

## 8. Errors, retries, cancellation - identified limits

Three real frictions, to be documented and worked around:

**(a) `TransportError.transport` is a closed union `["http", "websocket"]`**
(`schema/errors.d.ts`). No `stdio` value ⇒ impossible to report a pipe failure
cleanly. Workaround: fail with `ProviderInternalError` / `UnknownProviderError`,
which stays in the same `AIError` union but without `status`.

**(b) The `session.hook("retry")` hook reasons in HTTP**: `event.error.status ===
429`, `error.type === "provider.invalid-request"`. Consequence: **no retry on
429/rate-limit for ACP**. To be compensated on the plugin side: we map the known
ACP errors (rate limit, quota) to `RateLimitError` / `QuotaExceededError` when
the agent flags them in `_meta` or in its text.

**(c) `http.request` / `http.response` / `experimental.ws.*` will never fire.**
Observability has to be ensured another way (log to stderr, or `ctx.event`).

**Cancellation:** `execute`'s `Scope` closes when the stream is interrupted → we
hook `session/cancel` (ACP notification) there, then the process kill.
`TransportExecution.complete` is not used by HTTP but is available: a good point
to release the session.

---

## 9. Permissions

`session/request_permission` is a **server → client** call during the stream, in
`execute`. The provider package has **no** access to `ctx.permission` (`Settings`
= flat JSON).

Three options, from the simplest to the most integrated:

1. **Auto-policy** (default): `reject` for `tools: "none"`, `allow-once` for
   `tools: "all"`.
2. **In-process registry**: the plugin exports a bus (`permissions.request()`);
   the provider package imports it via the **same absolute `file://` path** →
   module identity guaranteed in Bun. Makes it possible to display a real
   OpenCode permission.
3. ~~**fs/terminal delegation**~~ - **abandoned**: the ACP v2 RFC removes that
   client surface, and agents were not using it (§7.2).

OpenCode's permissions on **OpenCode tools** are natively covered by mechanism
7.3: those are real `tool-call`s of the OpenCode loop, which go through
OpenCode's permission system without extra code.

---

## 9bis. cwd - the unresolved point

`Transport.execute` receives **no session context**, and `LLMRequest` has no
`cwd` field (available fields: `id?`, `model`, `system`, `messages`, `tools`,
`toolChoice`, `generation`, `providerOptions`, `http`, `cache`, `promptCacheKey`,
`metadata`).

Options:

1. **Static `settings.cwd`**, filled in by the plugin from
   `ctx.location.directory`. ⚠️ The provider registry is **global** while
   `ctx.location` is **per project**: a single server serving several projects
   would share the same cwd. To be decided (provider suffixed per project, or
   explicit refusal in multi-project setups).
2. **`request.metadata`**: an "application-defined" field. **To be verified
   empirically in P0** - hook a `JSON.stringify(request)` log in `body.from` to
   see what the core puts there. If the session directory is in it, that is the
   clean solution.
3. **The server's `process.cwd()`**: matches OpenCode's launch directory, not
   necessarily the session's directory.

As long as (2) is not verified, we implement (1) and we log.

---

## 9ter. Distribution

The project is published as **a single npm package** exposing two entry points:

- the **plugin** (`plugins: ["opencode-acp-provider"]` in `opencode.jsonc`)
- the **provider** (`Provider.Info`'s `package`), absolute `file://` path computed
  from `import.meta.url` → works installed in `node_modules` too, not only
  locally.

Prerequisite: a build into `dist/`, and the pinning of `@opencode/ai` + `effect`
(cf. §1). The smoke test (P5) serves as a guard rail: it fails loudly if the
internals' contract changes after an OpenCode update, rather than letting the
provider break silently.

---

## 10. Sessions & continuity

`LLMRequest` contains **no** OpenCode `sessionID` - available fields: `id?`,
`model`, `system`, `messages`, `tools`, `toolChoice`, `generation`,
`providerOptions`, `http`, `cache`, `promptCacheKey`, `metadata`.

Consequence: impossible to map 1:1 an OpenCode session ↔ an ACP session by
identifier. Two strategies:

- **`session: "fresh"`** (default, correct): 1 `session/new` per request, the
  full OpenCode history is replayed via `body.from`. Simple, stateless, but slow
  (the agent re-reads the repository).
- **`session: "reuse"`**: cache key = fingerprint of the conversation **prefix**
  + `cwd` (`sha256(cwd + ids of the first N messages)`). If the key matches a
  live ACP session, we reuse it and send only the delta. Heuristic: correct for
  a linear conversation, to be invalidated on `/compact`, fork or model change.

---

## 11. Phases

| Phase | Deliverable | End criterion |
| --- | --- | --- |
| **P0** | Scaffolding: `package.json`, `tsconfig.json`, pinned versions, `acp/client.ts` + `acp/types.ts` | `initialize` + `session/new` work against `copilot --acp` |
| **P0b** | **cwd spike**: `JSON.stringify(request)` log in `body.from` | find out whether `request.metadata` carries the session cwd (§9bis) |
| **P1** | `transport.ts`: spawn, JSON-RPC, `session/prompt`, frame stream | ACP notifications arrive raw in `frames` |
| **P2** | `protocol.ts`: `LLMEvent` mapping (§4) + `errors.ts` | a `text-delta` displays in the TUI, a clean `finish`, no *ended unexpectedly* |
| **P2b** | **7.3 mechanism**: prompt (system + tool catalogue + transcript) and JSON output parsing | a `tool-call` emitted **without** `providerExecuted` triggers a real OpenCode tool |
| **P3** | `plugin.ts`: provider registration, `configOptions` discovery (§5), cleanup | `acp-copilot/<model>` visible in `/model`, one chat works end to end |
| **P4** | Permission policy (§7.4), `session/cancel`, §8 errors | no write by the agent; `Esc` interrupts cleanly |
| **P5** | Tests: `smoke.test.ts` (contract vs pinned `@opencode/ai`) + `fake-acp.ts` | the smoke fails loudly if the internals change |
| **P5b** | `probe/`: reusable ACP probes (initialize, inventory, set_config_option) | an unknown ACP agent qualifies in one command |
| **P6** | `thought_level`/`model_config` variants; forwarding MCP servers via `session/new` | `/model` effort switch; OpenCode MCP visible from the agent |
| **P7** | `adapters/openai-http`: `/v1/chat/completions` server (SSE) on top of the same core | `curl` a full chat; the plugin switches to `openai-compatible` if the internals move |

P3 is the value milestone. If the P2 mapping proves too strict, the fallback is to
go back to Option A reusing `acp/` as is (the ACP client is identical).

---

## 12. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Undocumented `@opencode/ai` internals | Breakage on a minor update | exact pin + loud smoke test; isolated ACP client |
| `effect@4.0.0-rc.112` (release candidate) | `Schema.Codec` instability | pin; avoid advanced `Schema` APIs, stay on `Struct`/`String` |
| Strictly validated `LLMEvent` sequence | Silent crash | dedicated tests per ACP notification type |
| ACP agent that ignores the tool refusal | Unwanted writes | `--available-tools` + policy + supervision; `tools: "all"` for delegation |
| Malformed JSON output from the agent | Blocked loop or invalid `tool-call` | tolerant extraction (```json``` block, first balanced object), 1 bounded repair attempt, otherwise an explicit `provider-error` |
| The agent spends too many tokens formatting JSON | Quality / cost | compact prompt, examples, per-agent templating if needed |
| `providerExecuted` not handled by the core loop | Double execution | P2b spike: we emit **without** `providerExecuted`, hence not concerned - unless delegation is ever enabled |
| `cwd` not available in the request | The agent works in the wrong directory | P0b spike; `settings.cwd` fallback (§9bis) |
| Global provider registry vs per-project `ctx.location` | cwd shared between projects | to be decided before P3 |
| `codex` has no `acp` subcommand in 0.154.0 | Requires the adapter | `npx @agentclientprotocol/codex-acp`; `copilot --acp` is native |
| `usage` mapped correctly | Cost/token missing from the UI | **resolved**: ACP `usage` measured, cf. §4.1 |
| Leaking ports/processes | Subprocess leak | `Scope` + finalizer; P4 |

---

## 13. Open questions

1. **Is `copilot --acp` stable?** The doc says *public preview* (Jan. 2026). The
   `configOptions` format may still move. To be frozen with an adapter if
   possible.
2. **Is refusing permissions enough to stop the agent from writing?** Some agents
   treat a refusal as fatal and abandon the turn. P0 must test that behaviour on
   copilot **and** codex before investing in P2.
3. **Does the agent reliably produce JSON?** That is **the** riskiest question
   of mechanism 7.3, which is now the heart of the design. P0b must measure it on
   copilot and codex: rate of usable outputs, need for repair, cost in tokens.
4. **Does `request.metadata` carry the session cwd?** It determines whether we can
   do without a static `settings.cwd` (§9bis).
5. **One provider or several?** A single `acp` with several models is simpler
   for the `/model` UX, but distinct credentials per agent (the copilot token is
   not codex's) argue for one provider per agent (`acp-copilot`, `acp-codex`).
6. **Should we handle `rawInput` streaming for ACP tool calls?** Outside the 7.3
   path (where the output is a JSON block), hence not blocking.

---

## 14. Roadmap after P3b

P3b is validated: in a real `opencode serve`, the plugin loads, the `acp` provider
is registered, **19 models** appear in `/model`, and one turn through
`acp/claude-sonnet-5` returns the expected answer. The full chain is therefore
proven end to end.

> ⚠️ **Acceptance pitfall to remember.** `opencode models` exits **before** the
> plugins have finished loading: it shows zero `acp/` model without anything
> being wrong, and the result is flaky. To verify, you need a persistent server
> (`opencode serve --port N`) then `/api/plugin` and `/api/model` with the basic
> auth `opencode:<password>`.

The priorities below come from an analysis of `intellectronica/opencode-acpx`
(MIT, compatible), a project that reaches the same goal but **on OpenCode 1.x**
and with a different design choice (see §14.1).

| # | Action | Why | V/E |
| --- | --- | --- | --- |
| **R1** | **Persistent ACP sessions** | The biggest functional gap: today a fresh session per request, hence **the agent forgets everything between two turns** | very high / L |
| **R2** | **Several agents** (`acp-copilot`, `acp-codex`, ...) | Lifts the README's #1 limit; distinct credentials per agent | high / M |
| **R3** | **Align `@opencode/ai` on 2.0.16** | Removes the risk of a double `LanguageModel`/`Usage` instance between our provider (2.0.3) and the host (2.0.16) | high / XS |
| **R4** | **Make loading failures visible** | A package that does not load produces **no** error: log **outside of `setup()`** | high / S |
| **R5** | **`verify:package` that runs the module** (their `prepack`) | Real import of `dist/plugin.js` + `dist/index.js`, verification of the exports, of the `file://` URL and of the candidates | high / M |
| **R6** | **Cancellation: `session/cancel`** | Condition for "`Esc` interrupts cleanly" (§8) | high / XS |
| **R7** | **Bound the discovery** (`discoveryTimeoutMs`) | `setup()` calls `acp.inventory()`: a silent agent would block OpenCode's loading | medium / S |
| **R8** | **Internal agents served locally** | `title`/`summary`/`compaction` must not trigger a full ACP agent | medium / M |
| **R9** | **Drop empty tool cards** | Our parser can produce a `tool-call` with no useful information | medium / XS |
| **R10** | **Fallback catalogue** | Prevent a slow-starting agent from making the provider disappear | low / S |
| **R11** | **HTTP adapter** (§P7) | `core/` is already ready; debugging and broad compatibility | medium / M |

### 14.1 What `opencode-acpx` does differently - and why we do not copy it

Their central mechanism is **`providerExecuted: true`**: they let the ACP agent
act, and mark its calls as already executed so that OpenCode does not replay
them. Consequence: **OpenCode has neither snapshot, nor undo, nor permissions on
those actions**.

We do the opposite (§7.3): the agent **proposes**, OpenCode **executes**. That
is a different product - a model in an editor, not an autonomous agent in an
editor - and it is a deliberate choice, to be kept.

On the other hand, two of their techniques deserve a study once R1 is done:

- **turn segmentation**: ACP's `session/prompt` *blocks* waiting for a
  permission, whereas the OpenCode loop waits for a `tool-call`. They close the
  segment, let OpenCode render the interaction, then **resume the ACP turn at its
  event cursor**;
- **persistent turns with a per-session FIFO queue**: that is exactly R1.

Their `session/identity.ts` and `session/keyed-queue.ts` are **MIT** and
adaptable.

### 14.2 One point to verify in priority

The acceptance turn reports `tokens=2/24`. That may be the agent's only
non-cached count (the `cacheWrite` is measured separately), but **if our
`LLMRequest` reconstruction loses the system prompt or the tools, it is a real
bug** that would not show up on a short answer. To be checked before R1.
