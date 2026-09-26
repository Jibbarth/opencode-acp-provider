# ACP probes

Utilities to qualify any ACP agent **without** OpenCode nor this project.
They were used to validate the plan: inventory, model switch, output stream.

## Prerequisites

```bash
npm install @agentclientprotocol/sdk@1.5.0 zod
```

## Running

```bash
node inspect.mjs        copilot --acp          # raw probe, no SDK
node switch-option.mjs  copilot --acp          # initialize + set_config_option
node sdk-inspect.mjs    copilot --acp          # probe via the official SDK (+ one prompt)
```

The first argument is the command, the following ones its arguments. Works under Bun too:

```bash
bun sdk-inspect.mjs copilot --acp
```

## Agents known to speak ACP (stdio)

| Agent | Command | Note |
| --- | --- | --- |
| GitHub Copilot CLI | `copilot --acp` | native, public preview |
| Gemini CLI | `gemini --experimental-acp` | ACP reference agent |
| Qwen Code | `qwen --experimental-acp` | |
| Codex CLI | `npx -y @agentclientprotocol/codex-acp` | **adapter required**, no `acp` subcommand |
| Claude Code | `npx @zed-industries/claude-agent-acp` | via Zed's adapter |
| Junie, Cursor, Cline, Goose… | see the [ACP list](https://agentclientprotocol.com/get-started/agents) | |

## Expected output

`inspect.mjs` / `sdk-inspect.mjs` print the `configOptions` per category
(`model`, `thought_level`, `mode`, `permissions`) and the list of models.
`switch-option.mjs` switches the model and the effort, and checks that an invalid
value is indeed rejected with the JSON-RPC `-32602` code.
