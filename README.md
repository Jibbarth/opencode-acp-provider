# opencode-acp-provider

Expose an **ACP** agent ([Agent Client Protocol](https://agentclientprotocol.com))
as an **OpenCode model provider**. The agent's models show up in `/model` as
`acp/<model>`, and every turn goes through ACP over stdio.

## Install

```bash
opencode plugin add github:Jibbarth/opencode-acp-provider
```

## Add an agent

Fastest path, no config file: in OpenCode, open `/connect`, pick **ACP**,
and fill the form:

- **Name** — the provider will be `acp-<name>` (e.g. `copilot`)
- **Command** — what starts the agent in ACP mode (e.g. `copilot --acp`)
- **API key** — type anything (e.g. `none`). OpenCode requires it for this
  kind of entry, the plugin never reads it: the agent authenticates itself.

The provider shows up in `/model` within seconds, no restart. Edit or remove
the connection any time from `/connect`; the catalogue follows. `/connect`
holds one active agent at a time (switch connections there to change it) —
for several agents side by side, use the file below.

Prefer a file? Declare agents under `plugins[].options` instead (or mix both
sources — they merge, `/connect` first):

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@barth/opencode-acp-provider",
      "options": { "agents": [{ "command": "copilot", "args": ["--acp"] }] },
    },
  ],
}
```

No build step: OpenCode loads the TypeScript sources directly. `plugin check`
and `plugin update` follow the pinned git revision like any other package
plugin.

<details>
<summary>Local install (dev checkout)</summary>

```bash
git clone https://github.com/Jibbarth/opencode-acp-provider
cd opencode-acp-provider
bun install
./install.sh                 # global config; --local for ./opencode.jsonc
```

`install.sh` writes a shim into the plugins directory and merges the agent
list into your config (backup first, `--status` to inspect, `--uninstall` to
remove). Moving the checkout breaks the absolute path: just re-run it.

</details>

## Configure

For several agents or tuning, use `plugins[].options` (same fields as above,
plus timeouts); defaults target `copilot --acp`.

```jsonc
{
  "agents": [
    { "id": "copilot", "command": "copilot", "args": ["--acp"], "session": "reuse" },
    { "id": "codex", "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"] },
  ],
  "refreshMs": 60000,
}
```

Each agent becomes one provider (`acp` or `acp-<id>`). Full reference:
[docs/configuration.md](docs/configuration.md).

## Use

Pick `acp/<model>` in `/model`. Effort levels appear as model variants; with
none selected the agent applies its own default. `session: "reuse"` keeps one
ACP session per conversation (faster, see [docs/sessions.md](docs/sessions.md));
the default `"fresh"` opens one per turn.

## Docs

- [configuration](docs/configuration.md) — full options reference
- [sessions](docs/sessions.md) — fresh vs reuse, token counting, cancellation, recovery
- [portability](docs/portability.md) — supported agents, ACP → OpenCode mapping
- [troubleshooting](docs/troubleshooting.md) — silent plugin, missing models, known limits
- [development](docs/development.md) — tests, probes, versions, no-build policy

## Requirements

- OpenCode `>= 2.0.16` (`@opencode/plugin` is pinned to the CLI that loads it)
- Bun (tests, dev), Node ≥ 20 also works for install and `verify:package`
- The ACP agent installed and authenticated (`copilot`, `opencode`, …)

## License

MIT — see [LICENSE](LICENSE).
