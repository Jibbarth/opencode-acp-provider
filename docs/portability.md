# Portability

`npm run verify:agent -- <command> [args...]` qualifies any ACP agent, one
capability per line: `ok`, `degrade` or `absent` are all fine — only `BROKEN`
(our code at fault) fails the run.

```bash
npm run verify:agent -- copilot --acp
npm run verify:agent -- opencode acp
```

| Capability | `copilot --acp` 1.0.88 | `opencode acp` 2.0.16 |
| --- | --- | --- |
| `model` option id | `model` | `model` |
| Effort option id | `reasoning_effort` | `effort` |
| `mode` option | 3 URL ids | 2 plain strings |
| `permissions` category | `allow_all` | none |
| Effort levels | `none` … `max` (6) | `low` … `max` + `default` (6) |
| `set_config_option(model)` | ok | ok |
| `set_config_option(effort)` | ok | ok |
| JSON output contract | ok | ok |
| `request_permission` | ok (3 options) | absent (asks nothing) |
| Verdict | CONFORM | CONFORM |

## Rules the probe locks in

- **`configId` is an `id`, never a category.** Options are resolved by category
  in the inventory, then the option's own `id` is sent. Both agents refuse
  their own category (`Unknown config option 'thought_level'`).
- **A model `id` can contain a `/`** (e.g. `opencode/big-pickle`). Nothing is
  sanitised: `Model.Ref.parse` cuts at the first `/`, so
  `acp/opencode/big-pickle` stays intact, and the agent accepts the exact value
  in `set_config_option`. A mapping table would buy nothing.
- **The `Model.ID` is exactly the ACP value**, for the same reason: no mapping
  table between the plugin (which publishes) and the transport (which sends).
- **One module serves all providers.** OpenCode only calls
  `model(modelID, settings)` on the provider package, so the provider identity
  travels in the settings under the `provider` key — that is also what isolates
  two agents' processes and sessions from each other.

## ACP → OpenCode mapping

| ACP category | OpenCode target |
| --- | --- |
| `model` values | One `Model.Info` per value (`acp/gpt-5.6-terra`, …) |
| `thought_level` | One `variant` per value (`settings: { effort: "high" }`) |
| `mode` | Nothing — ACP modes are agents, out of scope |
| `permissions` | Nothing — see `allowedTools` in [configuration](configuration.md) |

Effort levels vary per model (`copilot` drops `none` for some models).
Selecting a stale variant fails with the accepted values listed; with no
variant selected, nothing is sent and the agent applies its own default.
