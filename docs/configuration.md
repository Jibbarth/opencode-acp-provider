# Configuration

Everything lives in `plugins[].options`. Without configuration, the default
agent is `copilot --acp`.

```jsonc
{
  "plugins": [
    {
      "package": "@barth/opencode-acp-provider",
      "options": {
        "refreshMs": 30000,
        "agents": [
          {
            "id": "copilot",
            "command": "copilot",
            "args": ["--acp"],
            "session": "reuse",
          },
          {
            "id": "codex",
            "command": "npx",
            "args": ["-y", "@agentclientprotocol/codex-acp"],
          },
        ],
      },
    },
  ],
}
```

## Top-level fields

| Field | Type | Default | Role |
| --- | --- | --- | --- |
| `agents` | `AgentConfig[]` | `[{ "command": "copilot", "args": ["--acp"] }]` | Agents to discover; each becomes one provider |
| `refreshMs` | `number` | `60000` | Minimum delay between two rediscoveries; `0` disables |
| `discoveryTimeoutMs` | `number` | `10000` | Upper bound of one discovery (spawn + `initialize` + inventory) |
| `discoveryIdleTimeoutMs` | `number` | `10000` | Longest silence from the agent during discovery before giving up |

`setup()` is awaited by the host, so discovery is the one place that can block
OpenCode's startup. A slow-starting agent needs a larger `discoveryTimeoutMs`;
an agent that talks on stderr resets the idle bound and gets the full global
bound. Increase the global bound, not the idle one.

## Agent fields

| Field | Type | Role |
| --- | --- | --- |
| `command` | `string`, mandatory | Command to start |
| `args` | `string[]` | Arguments, e.g. `["--acp"]` |
| `id` | `string` | Label and provider id suffix; default: none (provider `acp`) |
| `session` | `"fresh"` \| `"reuse"` | Default `"fresh"`; see [sessions](sessions.md) |
| `cwd` | `string` | Agent working directory |
| `env` | `Record<string, string>` | Variables added to the server's environment |
| `allowedTools` | `string[]` | `["*"]` allows everything native; absent denies everything |
| `limits` | `{ context, output }` | Limits announced in `/model`; default `200000` / `32000` |

`allowedTools` is a switch, not a filter: the ACP permission request does not
always carry the tool name, so any list other than `["*"]` behaves like deny
all. That is the fail-safe choice, and `session` can also be set per provider
via `provider.acp-<id>.options.session` — `agents[].session` wins when both
are set.

## Provider ids

| `agents[].id` | Published provider |
| --- | --- |
| absent | `acp` |
| `"copilot"` | `acp-copilot` |
| `"My Agent!"` | `acp-my-agent` |

No `id` keeps `acp` (old configs keep working). A named `id` is prefixed with
`acp-` so it cannot silently replace a built-in provider (`editor.add`
replaces the entry with the same id). The `id` is lowercased to `[a-z0-9-]`;
an `id` with no usable character is refused.

A conflicting id drops the agent with a log line: first agent wins between two
config entries, and an id taken by another provider is refused rather than
renamed (auto-renaming would change `/model` ids on every restart). Other
agents still register. Discovery is sequential, so a dead agent costs at most
its bound, once.
