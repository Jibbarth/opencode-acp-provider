# Sondes ACP

Utilitaires pour qualifier un agent ACP quelconque **sans** OpenCode ni le projet.
Ils ont servi à valider le plan : inventaire, changement de modèle, flux de sortie.

## Prérequis

```bash
npm install @agentclientprotocol/sdk@1.5.0 zod
```

## Lancement

```bash
node inspect.mjs        copilot --acp          # sonde brute, sans SDK
node switch-option.mjs  copilot --acp          # initialize + set_config_option
node sdk-inspect.mjs    copilot --acp          # sonde via le SDK officiel (+ un prompt)
```

Le premier argument est la commande, les suivants ses arguments. Fonctionne aussi sous Bun :

```bash
bun sdk-inspect.mjs copilot --acp
```

## Agents connus pour speak ACP (stdio)

| Agent | Commande | Remarque |
| --- | --- | --- |
| GitHub Copilot CLI | `copilot --acp` | natif, preview publique |
| Gemini CLI | `gemini --experimental-acp` | agent de référence ACP |
| Qwen Code | `qwen --experimental-acp` | |
| Codex CLI | `npx -y @agentclientprotocol/codex-acp` | **adaptateur requis**, pas de sous-commande `acp` |
| Claude Code | `npx @zed-industries/claude-agent-acp` | via l'adaptateur de Zed |
| Junie, Cursor, Cline, Goose… | voir la [liste ACP](https://agentclientprotocol.com/get-started/agents) | |

## Sortie attendue

`inspect.mjs` / `sdk-inspect.mjs` affichent les `configOptions` par catégorie
(`model`, `thought_level`, `mode`, `permissions`) et la liste des modèles.
`switch-option.mjs` change de modèle et d'effort, et vérifie qu'une valeur invalide
est bien rejetée en JSON-RPC `-32602`.
