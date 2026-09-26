# opencode-acp-provider

Expose an **ACP** agent ([Agent Client Protocol](https://agentclientprotocol.com))
as an **OpenCode model provider**: the agent's models show up in OpenCode's
`/model`, and every turn goes through an ACP `Transport` over stdio.

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-acp-provider",
      "options": { "agents": [{ "command": "copilot", "args": ["--acp"] }] }
    }
  ]
}
```

## Progress

The project follows the phases of `PLAN.md`. Where it stands, without rounding:

| Phase | State |
| --- | --- |
| P0 - ACP client (`initialize`, `session/new`) | done, tested against `copilot --acp` |
| P1 - Effect `Transport` over stdio | done, tested (end to end against a fake agent) |
| P2 - `AcpEvent` -> `LLMEvent` mapping | done, tested sequence by sequence |
| P2b - the agent **proposes** the tool, OpenCode executes it (§7.3) | done, tested |
| **P3a - plugin: provider + `Model.Info`, effort variants** | **done and tested in a real OpenCode** |
| **P3b - real acceptance**: `acp/<model>` visible in `/model`, one full turn | **done, verified** |
| P4 - fine-grained permissions, §8 errors | to do (`session/cancel` done, see "Cancellation") |
| R1 - persistent ACP sessions (`PLAN.md` §10) | done, tested (see "Persistent sessions") |
| R2 - several agents, one provider per agent | done, tested (see "Several agents") |
| P6 - per-model variants, MCP servers handed to the agent | to do |
| P7 - HTTP `/v1/chat/completions` adapter | to do |

**What was really verified, end to end.** In a real `opencode serve`, the plugin
loads (`opencode-acp-provider | local | active`), the `acp` provider is
registered with `package: file://…/src/index.ts`, **19 models** appear in
`/model` with their names and their effort variants, and one conversation turn
through `acp/claude-sonnet-5` returns the expected answer:

```
acp/claude-sonnet-5 | finish=stop | tokens=2/24
   text: BONJOUR-ACP
```

⚠️ **Acceptance pitfall, worth knowing.** `opencode models` exits **before** the
plugins have finished loading: it shows zero `acp/` model without anything being
wrong, and the result is flaky from one run to the next. To verify, you need a
**persistent server**: `opencode serve --port N`, then query `/api/plugin` and
`/api/model` with the basic auth `opencode:<password>` (the password is printed
at startup).

### Known limits

- **`auto` is filtered out.** It is a pseudo-value: the agent picks the model on
  every turn without saying so, so a `Model.Info` would be wrong (limits, cost)
  without ever flagging it. See `PSEUDO_MODEL_IDS` in `src/core/publish.ts`.
- **`allowedTools` is degraded to a switch.** `["*"]` allows everything native,
  any other list behaves like "deny everything": the ACP permission request does
  not always carry the tool name. This is the *fail-safe* choice of §7.4, not an
  oversight.
- **`session: "reuse"` is a heuristic, not a guarantee.** See
  "Persistent sessions": resuming is only valid if the received history is
  exactly an extension of the one already sent, and any divergence (edit, fork,
  `/compact`, model change) falls back to a fresh session. The default remains
  `"fresh"`.
- **`reuse` reports a cumulative `input`, and we correct it when the agent
  contradicts itself.** Measured: on a resumed session, `copilot` reports a
  cumulative `input` (≈ 4.4× its real window) instead of the context window it
  publishes itself through `usage_update`. The reducer therefore substitutes the
  window as soon as it is more than 2× smaller, which leaves `fresh` untouched
  (0.97×) and lets a silent agent through as-is. See "Persistent sessions".
- **Refreshing is triggered, not continuous.** The inventory is re-read at most
  once per `refreshMs` (60 s by default), and only after a `session.idle`. The
  `config_option_update` of the transport's sessions is not observed: the
  portable `AcpSession` contract only exposes it during a prompt.
- **Declared limits, not measured ones.** ACP publishes no model capability; we
  announce 200 000 / 32 000 by default, configurable per agent
  (`agents[].limits`). A `limit.context` that is too large only delays the
  compaction.
- **Text inputs only.** `copilot --acp` accepts images, but the reducer cannot
  render them: announcing `input: ["text"]` is better than an image accepted and
  then silently lost.
- **A second process.** Discovery starts its own agent, distinct from the one
  the transport will start through `model()`. Sharing the
  `opencode-transport.ts` cache would load the whole `effect` + `@opencode/ai`
  stack when the plugin loads, inside the server process.
- **An absent plugin is invisible... except for one line.** A package that does
  not load produces no error; `src/plugin.ts` therefore writes to `stderr`, at
  the moment the module is **evaluated** and **outside `setup`'s `try`**, a
  single line `[opencode-acp-provider] module evaluated: file://…/src/plugin.ts`.
  If it is missing, the problem is upstream (path, installation, import error);
  if it is there, all that is left to read is `setup`'s log. That is precisely
  why it is written there: nowhere else would it tell the two cases apart.
- **Namespaced tools are flattened in the prompt.** The agent must reproduce the
  name as-is, and that is `namespace_name` - the convention of `@opencode/ai`
  for protocols with no native namespace (`.` is not accepted everywhere). The
  emitted `tool-call` additionally carries the original `namespace`, otherwise
  OpenCode's runtime, which indexes its registry by `namespace.name`, would not
  find the tool.

## Cancellation

`Esc` interrupts cleanly, and "cleanly" means three things, all verified by
`test/cancel.test.ts`:

1. **the agent is told.** `@opencode/ai`'s `TransportRuntime` carries no
   interruption signal: when OpenCode abandons the stream, the `Scope` closes
   and... nothing else happens. A cancellation controller armed by a finalizer of
   the **same** `Scope` therefore sends `session/cancel`, registered **after**
   the session is opened so that the finalizers - which run in reverse order -
   produce `session/cancel` then `session/close`. The fake agent records every
   cancellation it receives in a file: a fast return proves nothing, a dated
   `session/cancel` does.
2. **the timing is the cancellation's, not the turn's.** Interrupting a 30 s
   turn hands control back within a few hundred ms, and the stream stops without
   an orphan `finish`.
3. **nothing leaks.** A cancelled turn leaves neither the session nor the agent
   unusable, and the process is not killed (it is cached and reused, on purpose)
   - but it is never left without an owner.

⚠️ Under `session: "reuse"`, a **cancelled** turn also abandons the ACP session
itself: its memory can no longer be considered reliable (the agent may have
stopped mid-turn), so it is closed and the next turn starts from a fresh session
with the whole history. This is the `fail-safe` fallback: losing a session costs
one `session/new`, resuming an inconsistent one corrupts the agent's context
with no sign at all.

## Persistent sessions

By default (`session: "fresh"`), every turn opens a new ACP session and sends
**the whole** history in the prompt. That is correct, and it is slow.

With `session: "reuse"`, a **durable ACP session per conversation** is reused from
one turn to the next, and **only the delta** - the messages added since the last
turn - is sent. The agent therefore keeps its own memory, and the prompt stops
growing linearly.

```jsonc
{ "command": "copilot", "args": ["--acp"], "session": "reuse" }
```

### What resuming brings - and what it does not

**Measured on `copilot --acp` v1.0.88** (agent `Copilot`), with the
`npm run verify:resume` probe: four turns, the same script in both modes, turn 1
planting a file name to remember.

| | turn 1 | turn 2 | turn 3 | turn 4 |
| --- | --- | --- | --- | --- |
| `reuse` - duration | 4 761 ms | 1 518 ms | 3 383 ms | 1 547 ms |
| `fresh` - duration | 8 251 ms | 2 940 ms | 7 539 ms | 9 788 ms |
| `reuse` - `cacheWrite` | 17 629 | 18 377 | 19 045 | 19 764 |
| `fresh` - `cacheWrite` | 17 628 | 17 684 | 17 737 | 17 789 |
| `reuse` - `input` | 17 632 | 36 012 | 55 060 | 74 827 |
| `fresh` - `input` | 17 631 | 17 687 | 17 740 | 17 792 |

**Resuming brings no memory: both modes remember.** Over the four turns,
`copilot` gave the file name back **8 times out of 8**, in `reuse` as in `fresh`.
That is expected - and it is what contradicts the claim "an agent forgets
everything between two turns": under `fresh`, the history **replayed in the
prompt** already carries the information. A fresh session does not suffer from
amnesia, it re-reads.

What resuming does bring is visible in `cacheWrite`:

- in **`fresh`**, the reconstructed prompt is **new text** on every turn: the
  agent rewrites it in its cache each time (~17 700 per turn, indefinitely);
- in **`reuse`**, the prefix is already in the agent's memory: it only writes
  the delta (~750 to 1 900 per turn).

Hence a per-turn latency **~3× lower** and flat, against a latency that
**grows** with the conversation in `fresh`.

⚠️ The counterpart is in the same column: `input` **grows linearly** under
`reuse` (17 k -> 75 k over four turns) whereas it stays flat under `fresh`. The
first explanation - "the agent's session holds everything it already received" -
**is wrong, and the measurement shows it**. Under `fresh`, the history rendered
in the prompt takes up exactly the same room in the agent's window; it is not
the session-side accumulation that tells the two modes apart.

What `input` really is, is the session's **cumulative cache counter** on a
resumed session: `cacheRead + cacheWrite`, that is 106 805 + 29 962 = 136 767
for an `input` of 136 785 on turn 6, where the real window takes up 30 809.
Recorded by `npm run verify:sessions` (six turns, controlled filler), by
comparing `input` with the `usage_update.used` the agent announces itself:

| turn 6, 9 000 chars filler/turn | reported `input` | real context (`usage_update`) |
| --- | --- | --- |
| `fresh` | 26 674 | 27 620 |
| `reuse` | 136 785 | 30 809 |

So the **real windows fill at the same rate** in both modes (≈ 2 200 tokens/turn
under `fresh`, ≈ 2 850 under `reuse`) - the agent is never the limiting factor,
and `reuse` does not reach its window earlier than `fresh`.

The figure that remains problematic is the other one. `input` is what
`adapters/opencode-protocol.ts` forwards to `Usage.inputTokens`: **136 785
instead of 30 809**, a factor of 4.4. That is the count the UI displays and the
one OpenCode's `/compact` threshold eventually runs into. (What is measured here:
the forwarding and the factor; OpenCode's exact threshold and the way it
aggregates per-message usages are not in this repository and have not been
extracted.)

Under `reuse`, a conversation would therefore be compacted ~4× too early, and
the token indicator would display a context that does not exist. This is
**corrected** - see "The token counter" - but the measurement is still what made
`reuse` an option rather than the default: `fresh` remains the default, simpler
and stateless.

What resuming therefore does **not** bring: a memory `fresh` would not have.
What it does bring: a constant prompt and a constant per-turn latency. `fresh`
remains the default - simpler, correct, and the only mode whose token counting
depends on no correction at all.

### The token counter

The agent does not always contradict itself. Under `fresh`, its `input` **is**
the window (0.97×); under `reuse`, it is the session's cumulative accounting
(4.4×). The same `events` carries both, and the `usage_update` the agent sends
during the turn gives the only unambiguous reading of what it really occupies.

The reducer (`adapters/opencode-protocol.ts`) therefore keeps that reading and
uses it **only** when the counter clearly contradicts it: beyond 2×. That
threshold is not an arbitrary setting - it is what separates the two measured
regimes. `fresh` sits at 0.97×, the natural gap between "tokens sent" and
"tokens reserved" never reaches 2×, and `reuse` exceeds it from the second turn
on: beyond the window, the counter would make OpenCode compact three turns early
instead of four times too early. An agent that sends no `usage_update` has
nothing to compare against, so its `input` is forwarded as-is.

The correction applies to the **total**, never to the turn's cost: `output` and
`total` are the agent's. And it rescales the three terms of the input, not just
their sum - a `cacheRead` left as-is would exceed the window it is part of.
`nonCached + cacheRead + cacheWrite = input` therefore remains true, rounding
errors aside, including for an agent that reports more cached tokens than sent
tokens.

### How a conversation is recognised

`LLMRequest` carries **neither `sessionID` nor `cwd`** (§9bis), so there is no
identifier to set against an ACP session. Recognition rests on two levels, and
that separation is what makes resuming safe:

1. **an indexing key** - `sha256(agent + cwd + model + first message)`.
   Stable despite the conversation growing: it is what allows finding "the live
   session of this conversation" in O(1).
2. **a proof of continuity** - the retained session has received `N` messages;
   the turn is only resumed if the received history is **exactly** an extension
   of those, message by message. At the slightest gap, the session is closed and
   a fresh one is started with the whole history.

The key is an **indexing trick**; continuity is a **guarantee**. The proof
covers the *whole* history, not a prefix: two conversations that share their
first N messages and diverge afterwards therefore cannot steal each other's
session - which is precisely the case a prefix fingerprint would not detect.

| Case | What happens |
| --- | --- |
| Normal next turn | Delta sent, session reused |
| **Edited** message | Different fingerprint at that rank -> fresh session, whole history |
| **Fork**, prepend | Same |
| `/compact` (summary at rank 0) | Different key -> fresh session, **and the old one is closed** |
| **Model change** | Different key -> fresh session (a session applied its model through `set_config_option`) |
| Different `cwd` or agent | Different key -> fresh session |
| Replay of the same turn | Empty delta refused -> fresh session (a prompt without a message would produce a silent `ACK:`) |
| Cancelled turn, dead agent | **Poisoned** session -> closed, next turn on a fresh session |
| Out of LRU (8 sessions) | The least recently used is closed, **unless** it carries a turn |

An **unreachable** session is closed as soon as it is recognised as such. A
rewrite of the anchor (what `/compact` does) moves the key, and the old session
would then stay alive under a key nothing will ever ask for again - an ACP
session lost to compaction, until the server stops. The pool recognises it by
what is left: **same agent, same directory, same model, and messages still
present in the received history** - which a `/compact` always leaves, since it
keeps the recent end of the exchanges and only replaces the head summary. Two
genuinely distinct conversations share no message, so theirs is never touched.
A session that still carries a turn is not touched either: the sweep waits for
it to free up, and the LRU collects whatever is left over.

⚠️ What resuming does **not** do: the system, the tool catalogue and the output
contract are **sent again in full on every turn**. Only the history is
deltafied - it is the history that doubles, not the instructions. The transcript
section is then titled "Conversation - continued", with a line telling the agent
that the continuation has already been exchanged and that it must not repeat it.

⚠️ Two requests **on the same conversation** are queued FIFO: ACP refuses two
concurrent `session/prompt` on one session, and the notifications of both turns
would be indistinguishable. Two different conversations have two keys, hence two
queues: they run in parallel.

Retained sessions are closed when the plugin unloads and by `closeAllSessions()`;
the LRU is bounded to 8 sessions per agent, and never evicts a session carrying
a turn in progress.

## Installation

The package exposes two entry points: the **plugin** (loaded by OpenCode) and the
**provider** (the `Provider.Info`'s `package` field, which points at
`src/index.ts` locally or `dist/index.js` after a build). The URL is computed
from `import.meta.url`, so both layouts work.

### In one command

No npm publication: clone, then run the script.

```bash
git clone <url> opencode-acp-provider
cd opencode-acp-provider
bun install
./install.sh
```

`install.sh` writes `~/.config/opencode/opencode.jsonc` (created if it does not
exist). That is all: there is nothing to compile, the plugin is loaded from
`src/`.

| Option | Effect |
| --- | --- |
| *(none)* | `--global`: `~/.config/opencode/opencode.jsonc` |
| `--local` | `./opencode.jsonc`, in the current directory |
| `--config <path>` | explicit configuration file |
| `--status` | reports the state, writes nothing |
| `--uninstall` | removes this repository's entry |
| `--agent "<cmd> [args…]"` | agent to configure, repeatable (default: `copilot --acp` **at creation only**) |
| `--no-agent` | writes no agent, you add them yourself |
| `--force` | allows rewriting a **commented** configuration |
| `--yes` | does not ask for confirmation |

```bash
./install.sh --local --agent "opencode acp" --agent "copilot --acp"
```

The result, for that command:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-acp-provider/src/plugin.ts",
      "options": {
        "agents": [
          { "command": "opencode", "args": ["acp"] },
          { "command": "copilot", "args": ["--acp"] }
        ]
      }
    }
  ]
}
```

⚠️ **The path is absolute, and it is computed from the script.** It therefore
does not depend on the directory OpenCode is launched from. In exchange, it
becomes wrong if the repository is moved: re-run `install.sh`, which repairs the
path without duplicating the entry.

### What the script refuses to do

It never replaces a configuration. Each of these situations stops with a
message, **writing nothing**:

| Situation | Why it is refused |
| --- | --- |
| `plugins` is not an array | a merge assumes an array; overwriting it would make the choice for you |
| a `plugins` entry is not an object | same reason, and the field's cursor would be lost |
| two entries already point at this repository | the script leaves **one**; choosing for you would be arbitrary |
| the file holds comments | the rewrite would lose them. `--force` goes through, and says so |

When it writes, it **backs up first** (`opencode.jsonc.bak-<timestamp>`), then
**re-reads** the file and checks the entry really survived; an unreadable
configuration or a failed write is restored. Finally, it recognises an entry
already present under another spelling - relative path, path to `dist/plugin.js`,
npm name `opencode-acp-provider` - and updates it instead of adding a second
one. Re-running the script therefore duplicates nothing.

⚠️ **`copilot --acp` is the default only at creation.** Re-running `./install.sh`
without `--agent` **keeps** the agents already declared, including a
hand-written list: a reinstaller that put `copilot --acp` back on top of your
agents would do so silently. To change the list, you ask for it explicitly with
`--agent`.

### Prerequisites

Verified by the script, which reports what is missing:

- **a complete `node_modules`** - otherwise run `bun install` first. The provider
  is imported by the OpenCode server, which resolves its dependencies: without
  them, the first turn fails on an import.
- **a JavaScript runtime** (`bun` or `node`) - it is what merges the
  configuration.
- **OpenCode's version** must match `@opencode/plugin`'s (see "Versions"). The
  plugin is loaded by the server: its version is the one that counts, not
  yours.
- **the ACP agent** installed and authenticated - `copilot`, `opencode`,
  `gemini`…

### Writing the configuration by hand

Nothing forces you to go through the script.

Locally, without a build (a relative path is resolved from the configuration
file):

```jsonc
{
  "plugins": [
    {
      "package": "./path/to/opencode-acp-provider/src/plugin.ts",
      "options": { "agents": [{ "command": "copilot", "args": ["--acp"] }] }
    }
  ]
}
```

Installed (npm):

```jsonc
{
  "plugins": [
    {
      "package": "opencode-acp-provider",
      "options": { "agents": [{ "command": "copilot", "args": ["--acp"] }] }
    }
  ]
}
```

Prerequisites: **Bun** (the plugin and the provider run in OpenCode's Bun
process), the ACP agent installed and authenticated, and an OpenCode whose
version matches `@opencode/plugin`'s (see "Versions" below).

## Configuration

Everything happens in `plugins[].options`. Without configuration, the default
agent is `copilot --acp`.

| Field | Type | Default | Role |
| --- | --- | --- | --- |
| `agents` | `AgentConfig[]` | `[{ "command": "copilot", "args": ["--acp"] }]` | The agents to discover; **each one becomes a provider** |
| `refreshMs` | `number` | `60000` | Minimum delay between two rediscoveries; `0` disables |
| `discoveryTimeoutMs` | `number` | `10000` | Upper bound of the discovery (spawn + `initialize` + inventory) |
| `discoveryIdleTimeoutMs` | `number` | `10000` | Maximum delay without a sign of life from the agent during the discovery |

`discoveryTimeoutMs` and `discoveryIdleTimeoutMs` exist because `setup()` is
**awaited by the host**: it is the only place in the project where a wait can
block OpenCode's loading. Both bounds are cleared in a `finally`, so a leftover
timer never keeps the server process alive. A slow-starting agent is handled by
**increasing** `discoveryTimeoutMs` - the inactivity bound, on the other hand,
lets any agent that **talks** (its stderr resets it) have the whole global bound.
An agent abandoned midway is killed as soon as it exists: no orphan per plugin
load.

`AgentConfig`:

| Field | Type | Role |
| --- | --- | --- |
| `command` | `string` **mandatory** | The command to start |
| `args` | `string[]` | The arguments (`["--acp"]`) |
| `cwd` | `string` | The agent's working directory (the process is *shared* across all requests - cf. `PLAN.md` §9bis) |
| `env` | `Record<string,string>` | Variables **added** to the server's |
| `allowedTools` | `string[]` | `["*"]` = allow everything; absent = deny everything (§7.4) |
| `limits` | `{ context, output }` | The limits announced in `/model` |
| `id` | `string` | **Label** and provider id; default: none (`acp`) |
Example:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-acp-provider",
      "options": {
        "refreshMs": 30000,
        "agents": [
          {
            "id": "copilot",
            "command": "copilot",
            "args": ["--acp"],
            "env": { "HTTPS_PROXY": "http://proxy.local:3128" },
            "limits": { "context": 200000, "output": 32000 }
          }
        ]
      }
    }
  ]
}
```

## Several agents

Each `agents` entry gives **one provider**: its own model inventory, its own
effort variants, its own agent process and its own pool of ACP sessions.

```jsonc
{
  "plugins": [
    {
      "package": "opencode-acp-provider",
      "options": {
        "agents": [
          { "id": "copilot", "command": "copilot", "args": ["--acp"] },
          { "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"] }
        ]
      }
    }
  ]
}
```

`/model` then displays `acp-copilot/claude-sonnet-5` **and**
`acp/claude-sonnet-5` side by side, and the setting is made per provider:

```jsonc
{ "provider": { "acp-copilot": { "options": { "session": "reuse" } } } }
```

### Choosing a session mode per agent

`agents[].session` is the way to **declare the mode in the agent entry**, that
is, where you already describe the command, the `cwd` and the `env`:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-acp-provider",
      "options": {
        "agents": [
          {
            "id": "copilot",
            "command": "copilot",
            "args": ["--acp"],
            "session": "reuse"
          },
          {
            "id": "codex",
            "command": "npx",
            "args": ["-y", "@agentclientprotocol/codex-acp"],
            "session": "fresh"
          }
        ]
      }
    }
  ]
}
```

Both forms write the same setting, and `agents[].session` **wins** over
`provider.acp-copilot.options.session`: the agent entry *is* the per-agent
configuration. An agent that says nothing publishes **no** `session` key, so a
configuration written before the field existed produces exactly the same
provider as before - and a test verifies that by comparing the published keys, not
only the behaviour.

| `agents[].session` | effect |
| --- | --- |
| absent (default) | `fresh` - one ACP session per model call |
| `"fresh"` | same, explicit |
| `"reuse"` | one ACP session per conversation, delta only |
| any other value | refused: `options.agents[N].session must be one of "fresh", "reuse"` |

### The provider id

| `agents[].id` | published provider |
| --- | --- |
| absent | `acp` |
| `"copilot"` | `acp-copilot` |
| `"My Agent!"` | `acp-my-agent` |

Three rules, and each has a reason:

- **An agent without an `id` keeps `acp`.** That is compatibility: a
  configuration written before multiple agents still publishes the provider its
  `providers.acp.settings` block refers to.
- **A named `id` is prefixed with `acp-`.** That is what makes a collision with
  an OpenCode provider unlikely: OpenCode ships `openai`, `anthropic`,
  `github-copilot`..., and the user can declare their own. `editor.add`
  **replaces** the entry carrying the same `id` - without that prefix, an agent
  named `copilot` would simply replace an existing provider.
- **The `id` is reduced to `[a-z0-9-]`** (lowercase, spaces and punctuation
  replaced with `-`). An identifier is typed after `provider/model`, used as a
  filter in the TUI and put in a URL: `acp-My Agent!` would have to be escaped
  at least once. An `id` leaving **no** usable character (`"///"`) is
  **refused** rather than brought back to `acp`: the user asked for a name, and
  giving them the default one would hide the typo behind a working
  configuration.

### What to do with a conflicting id

**The agent is dropped, and the log names the id.** Two cases:

- **Two agents from the configuration claim the same id** - after
  normalisation, `copilot` and `Copilot` are one and the same. The **first**
  wins, the other is logged. Letting both through would be worse than a
  duplicate: `editor.add` replaces, so `/model` would show the second one's
  models under the first one's name - a silent substitution.
- **The id is already taken by another provider** (built-in or declared by the
  user in `providers`). The agent is dropped. Renaming it automatically is not
  an option: "the next free name" is not stable from one restart to the next, so
  `/model` would change id with every provider added. Refusing is the only
  deterministic behaviour, and the message says what to do.

In both cases the other agents are registered normally, and the log ends with
`1 agent(s) dropped`.

⚠️ **A failing agent does not block the others**, but the discovery is
**sequential**: starting N agents is additive, not parallel. That is
deliberate - each discovery starts an agent that authenticates, and N agents
starting together at boot are exactly the burst `discoveryTimeoutMs` exists to
avoid. A dead agent costs at most its bound, once.

## ACP -> OpenCode mappings

Baseline reading on `copilot --acp` (agent `Copilot` v1.0.88): 20 values in the
`model` category (including `auto`), 6 effort levels, 3 modes, 1 permissions
option.

| ACP category | OpenCode target | Detail |
| --- | --- | --- |
| `model` | **one `Model.Info` per value** | `acp/gpt-5.6-terra`, `acp/claude-sonnet-5`... |
| `thought_level` | **one `variant` per value** | `settings: { effort: "high" }` -> `set_config_option(<the agent's `id`>)` before the prompt |
| `mode` | *(nothing)* | ACP modes are agents, not models: out of scope for now |
| `permissions` | *(nothing)* | unused by the policy - see "Portability" |

The `Model.ID` is **exactly** the ACP value: that is what the adapter sends back
to `set_config_option`, with no mapping table.

The provider is called `acp`, or `acp-<id>` for a named agent (see "Several
agents"), and its `name` is `ACP — <agentInfo.name>`. Its `package` is an
**absolute** `file://` URL to the module exporting `model`, computed from
`import.meta.url` (`resolvePackageURL` in `src/plugin.ts`).

## Portability - two agents, the same code

`verify:agent` qualifies any agent and reports one capability per line: `ok` (we
do it), `degrade` (the agent does it differently and we make do), `absent` (the
agent does not offer it). **None of these three verdicts is a failure**; only
`BROKEN`, which means that *our* code does not know how, changes the exit code.

```bash
npm run verify:agent -- copilot --acp
npm run verify:agent -- opencode acp
```

Real reading, side by side:

| Capability | `copilot --acp` 1.0.88 | `opencode acp` 2.0.16 |
| --- | --- | --- |
| `id` of the `model` option | `model` | `model` |
| `id` of the effort option | `reasoning_effort` | **`effort`** |
| `id` of the `mode` option | `mode` | `mode` |
| `permissions` category | `allow_all` | **none** |
| mode ids | 3 **URLs** | 2 **plain strings** |
| effort levels | `none … max` (6) | `low … max` + **`default`** (6) |
| model ids | `claude-sonnet-5` | **`opencode/big-pickle`** |
| `set_config_option(effort)` | `ok` | `ok` |
| `set_config_option(model)` | `ok` | `ok` |
| JSON output contract | `ok` | `ok` |
| `request_permission` | `ok` (3 options) | `absent` (asks for nothing) |
| cancellation | `absent` (turn too short) | `ok` (`stopReason=cancelled`) |
| **verdict** | **CONFORM** | **CONFORM** |

No assumption about `copilot` had to be withdrawn: the five differences are
already logged in the code, and the probe proves it on both.

### The `configId` is an `id`, never a category

That is the distinction everything else rests on. A `ConfigOption` carries a
`category` **and** an `id`, and only the `id` is a valid `configId` - measured,
both agents **refuse** their own category (`Unknown config option
'thought_level'`, `unknown config option`). The code therefore resolves the
option by category in the inventory, then sends its `id`: `applyOption` in
`adapters/opencode-transport.ts`, and the two other callers (`setModel` in
`acp/agent.ts`, `--effort` in `adapters/cli.ts`).

⚠️ `opencode acp` accepts `model` as a category **by accident**: its `id` is
`model`. A conformance probe that had only tested that case would have passed.
`test/fake-acp.ts` now refuses an unknown `configId`, as real agents do, so the
confusion cannot survive in a test.

### A model `id` can contain a `/`

That is the most serious point, and **it is not a defect**. `opencode acp`
publishes `opencode/big-pickle`; OpenCode's `provider/model` naming seems to
forbid the `/`, whereas it actually requires it.

The question is settled by OpenCode's own parser, not by a heuristic:
`Model.Ref.parse` cuts at the **first** `/` and takes everything after it as the
id. `acp/opencode/big-pickle` gives `{providerID: "acp", id:
"opencode/big-pickle"}` - intact. The catalogue OpenCode ships itself contains
4274 ids with a `/` (`subconscious/subconscious/glm-5.2`,
`tokengo/deepseek/deepseek-v4-flash`): it is a normal shape, not an edge case.

**Decision: sanitise nothing.** The `Model.ID` stays the exact ACP value, for
three measured reasons: OpenCode's parser accepts it as-is; the agent accepts
that value in `set_config_option` (reading: `id=model -> opencode/big-pickle`,
`ok`); and a modified id would require a threaded mapping table between the
plugin (which publishes) and the transport (which sends), for a zero gain.
`verify:agent` no longer relies on a pattern: it passes every published id to
`Model.Ref.parse` and only reports what the parser really refuses.

### Two filtered values, for the same reason

`auto` among the models and `default` among the effort levels are
pseudo-values: they mean "let the agent decide". Publishing them would produce
an entry in `/model` whose `settings` would never be applied - OpenCode rewrites
a variant named `default` into *no* variant before merging its settings. Both
are therefore filtered, and the absence of a selected variant lets the agent
apply what it announces itself.

The same module serves **all** ACP providers: OpenCode only calls one thing on a
provider package, `model(modelID, settings)`, and nothing else there carries the
provider's identity. The id therefore travels **in the settings** - the plugin
writes it under the `provider` key and `parseSettings` reads it back. That is
also what isolates two agents in `agentKey`: two providers share neither
process, nor authentication, nor ACP sessions.

## Per-model setting

The effort levels come from the inventory, and it **varies with the model**:
`copilot --acp` no longer offers `none` for `claude-sonnet-5`. Selecting a
variant that has become invalid therefore fails with the list of accepted values
in plain sight, rather than letting the agent refuse a value silently. Automatic
refreshing is the answer, not yet the rule.

With no variant selected, no `set_config_option` is sent: the agent applies the
value it announces itself in `session/new`.

There is deliberately **no** `default` variant: OpenCode rewrites that id into
"no variant" and therefore does not merge its `settings`. An agent that
publishes that level (`opencode acp`) sees it filtered - the same treatment as
`auto` among the models, and for the same reason.

## Versions

| Package | Version | Why |
| --- | --- | --- |
| `@opencode/ai` | `2.0.16` | **the version `opencode@2.0.16` ships**, and not an older one: our provider builds a `LanguageModel` and a `Usage` with *our* instance, the host reads them with *its own*. Two instances = two `Usage` classes, hence a false `instanceof` on the host side, which fails with "The provider response ended unexpectedly." - indistinguishable from a stream truncation. `test/opencode.test.ts` compares our version with the dependency declared by `@opencode/plugin`; `scripts/verify-package.mjs` checks that the `package` field's URL designates the **same** file as `exports["."]`, hence that a single module is loaded |
| `@opencode/schema` | `2.0.16` | same - that is where `LLMEvent` and `Usage` come from |
| `@opencode/plugin` | `2.0.16` | **in `devDependencies`**: at load time, it is the host that provides it. Its version follows the CLI's, not `@opencode/ai`'s |
| `effect` | `4.0.0-rc.112` | release candidate, pinned |
| `@agentclientprotocol/sdk` | `1.5.0` | the ACP protocol |

⚠️ `PLAN.md` refers to `@opencode/plugin@2.0.3`: its types expose a `catalog`
domain that the `2.0.16` server **does not implement** (its `Context` exposes
`provider` and `model`). It is `2.0.16` that is pinned here, because that is the
server version that loads the plugin.

### Token counting: why the UI displays `2/24`

The acceptance turn displayed `tokens=2/24` while the agent, called directly,
declares ~15 000 input tokens. **This is not a loss**: it is the cache
breakdown.

Real reading on `copilot --acp` v1.0.88, with the `verify:real` probe:

```
usage: Usage input=15604 output=43 cacheWrite=15601
```

`inputTokens` does carry the **whole** received window. The UI displays the
`nonCachedInputTokens` - the rest is `cacheWrite`, which the agent pays for once
and which OpenCode does not count again on every turn. The proof that the prompt
is not truncated is direct: adding ~4 000 tokens to the system makes
`inputTokens` **grow** by as much, and `nonCached` does not move.

`test/prompt-fidelity.test.ts` locks down the rest: the prompt is compared
**character by character** with the one the fake agent actually received on the
wire (`FAKE_PROMPT_FILE`), for a realistic request - multi-part system, three
tools with JSON schemas, transcript with a tool call and a tool result.

## Development

```bash
bun install
bun test            # 425 tests, including the full ACP chain against test/fake-acp.ts
bun run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run verify:package   # runs the package to verify its contract (Node)
npm run verify:agent -- copilot --acp   # qualifies an agent, one line per capability
npm run verify:real copilot --acp    # probe outside the suite: requires an installed agent
npm run verify:resume copilot --acp  # same, `session: "reuse"` measured against `fresh`
```

`verify:agent` is the **portability** probe: it goes through the project's own
code, it accepts any agent, and it exits `0` as long as no defect is **ours**.
See "Portability".

### `verify:package` - the contract, verified **by execution**

```bash
npm run verify:package    # or: node scripts/verify-package.mjs
```

Inspired by `opencode-acpx`'s `prepack` (MIT). An entry point that does not
export what OpenCode calls, or a `package` field that points at nothing,
produces **no** error at load time: the server imports the module, does not find
`model`, and the first chat fails. This script **actually imports** both entry
points and checks:

- `default.setup` is a function, and the plugin has an `id`;
- `model` is a function;
- the URL computed by the plugin for the `Provider.Info.package` field is an
  **absolute** `file://` pointing at a file that **exists**, and designates the
  **same** module as `exports["."]` (hence a single loaded instance);
- the files declared in `exports` exist.

It exits with a **non-zero** code and a message naming the faulty field
(`default.setup`, `model`, `Provider.Info.package`, `exports["."]`...). It is
wired into `prepack`, hence it runs before any publication.

⚠️ It runs under **Node**, not under Bun: `prepack` runs wherever publishing
happens, in a CI that does not necessarily have Bun. Node has stripped types
since 22.6 but does not rewrite specifiers - hence
`scripts/resolve-ts-extensions.mjs`, a twenty-line resolution hook that maps
`./x.js` to `./x.ts` **only if the file exists**. That is also the reason why
`AcpAgentError` declares its `subject` field explicitly: a "parameter property" is
TypeScript that Node's type stripping does not know how to handle.

`test/publish.test.ts` only tests pure functions - `src/core/publish.ts` imports
neither `@opencode/plugin`, nor `effect`, nor the SDK, and a test checks it.
That split is what makes the inventory testable without starting OpenCode.
