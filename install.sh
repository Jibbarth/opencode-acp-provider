#!/usr/bin/env bash
#
# opencode-acp-provider - one-command installation.
#
#   git clone <repo> && cd opencode-acp-provider
#   ./install.sh                 # global configuration
#   ./install.sh --local         # current directory configuration
#
# What this script does, and above all what it refuses to do:
#
#   * it never replaces a configuration. It merges: it looks for a `plugins[]`
#     entry already pointing at this repository and does not duplicate it.
#     Two successive installations converge to a single entry;
#   * it backs the file up before writing it, then reads it back to check the
#     entry really survived;
#   * it refuses a configuration it cannot merge (`plugins` that is not an
#     array, a non-object entry, two entries already pointing here), and it
#     never leaves a half-written file;
#   * it refuses a **commented** configuration without `--force`, because the
#     rewrite would lose the comments. The backup is made in both cases, and
#     the refusal names it.
#
# The plugin path is **absolute**, resolved from this script: it does not depend
# on the directory OpenCode is launched from.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PLUGIN_ENTRY="$ROOT/src/plugin.ts"
PLUGIN_ENTRY="$(cd -- "$(dirname -- "$PLUGIN_ENTRY")" && pwd -P)/$(basename -- "$PLUGIN_ENTRY")"

MODE="install"
SCOPE="global"
SHIM_NAME="opencode-acp-provider.ts"
CONFIG=""
FORCE=""
ASSUME_YES=""
AGENTS_JSON=""
NO_AGENT=""
AGENTS_EXPLICIT=""
declare -a AGENT_SPECS=()

die() { printf '\ninstall.sh : %s\n' "$1" >&2; exit 1; }
note() { printf '%s\n' "$1"; }

usage() {
  cat <<'USAGE'
usage: install.sh [options]

  --global            writes ~/.config/opencode/opencode.jsonc   (default)
  --local             writes ./opencode.jsonc (current directory)
  --config <path>     explicit configuration file
  --status            reports the state, writes nothing
  --uninstall         removes this repository's entry
  --agent "<cmd> [args...]"
                      agent to configure, repeatable
                      (default: copilot --acp)
  --no-agent          writes no agent, you add them yourself
  --force             allows rewriting a commented configuration
                      (the comments will be lost; a backup is taken)
  --yes               does not ask for confirmation
  -h, --help          this help

 examples:
  ./install.sh
  ./install.sh --local --agent "opencode acp"
  ./install.sh --status
  ./install.sh --uninstall
USAGE
}

# ─────────────────────────────────────────────────────────────────────────────
# Arguments
# ─────────────────────────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --global) SCOPE="global" ;;
    --local) SCOPE="local" ;;
    --config) [ $# -ge 2 ] || die "--config requires a path"; CONFIG="$2"; shift ;;
    --status) MODE="status" ;;
    --uninstall) MODE="uninstall" ;;
    --force) FORCE="--force" ;;
    --yes|-y) ASSUME_YES="yes" ;;
    --agent) [ $# -ge 2 ] || die "--agent requires a command"; AGENT_SPECS+=("$2"); AGENTS_EXPLICIT="yes"; shift ;;
    --no-agent) NO_AGENT="yes"; AGENTS_EXPLICIT="yes" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

# ─────────────────────────────────────────────────────────────────────────────
# Prerequisites
# ─────────────────────────────────────────────────────────────────────────────

[ -f "$ROOT/package.json" ] || die "$ROOT does not look like opencode-acp-provider (package.json absent)."
[ -f "$PLUGIN_ENTRY" ] || die "plugin entry point not found: $PLUGIN_ENTRY"

# The provider is loaded by the OpenCode server, which resolves its dependencies
# from node_modules: without an install, the first turn fails on an import.
if [ ! -d "$ROOT/node_modules/@opencode/ai" ]; then
  note "! node_modules incomplete: run first"
  note "    bun install"
fi

RUNNER=""
for candidate in bun node; do
  if command -v "$candidate" >/dev/null 2>&1; then RUNNER="$candidate"; break; fi
done
[ -n "$RUNNER" ] || die "no JavaScript runtime found (bun or node is required to write the configuration)."

# OpenCode's version must match @opencode/plugin's: the plugin is loaded by the
# server, and its version is what decides the contract.
PINNED="$("$RUNNER" -e 'const p=require(process.argv[1]);process.stdout.write((p.devDependencies||{})["@opencode/plugin"]||"?")' "$ROOT/package.json" 2>/dev/null || echo '?')"
if command -v opencode >/dev/null 2>&1; then
  FOUND="$(opencode --version 2>/dev/null | sed -nE 's/.*v?([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
  if [ -n "$FOUND" ] && [ "$FOUND" != "$PINNED" ]; then
    note "! OpenCode $FOUND while @opencode/plugin is pinned to $PINNED."
    note "  The plugin is loaded by the server: its version is the one that counts."
  fi
else
  note "! opencode is not in the PATH: the configuration will be written, but OpenCode will not be able to read it."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Target
# ─────────────────────────────────────────────────────────────────────────────

if [ "$SCOPE" = "local" ]; then
  [ -n "$CONFIG" ] || CONFIG="$PWD/opencode.jsonc"
  SHIM_DIR="$PWD/.opencode/plugins"
else
  # The global target is the file OpenCode itself reads, and it may be either
  # name: `opencode.json` wins over `opencode.jsonc` when both exist. Without a
  # default, `--config ""` reached the merge step as an empty path, which
  # `resolve()` turned into the current directory and read as a file.
  [ -n "$CONFIG" ] || CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
  [ -f "$CONFIG" ] || CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.jsonc"
  SHIM_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
fi

# A symbolic link is followed, not rewritten: the target file may be versioned
# (dotfiles), and writing through the link would make the other name diverge.
if [ -L "$CONFIG" ]; then
  RESOLVED="$(cd -- "$(dirname -- "$CONFIG")" && pwd -P)/$(readlink -- "$CONFIG")"
  note "! $CONFIG is a symbolic link: the write targets $RESOLVED"
  CONFIG="$RESOLVED"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Agents
# ─────────────────────────────────────────────────────────────────────────────

if [ -n "$NO_AGENT" ]; then
  AGENTS_JSON='[]'
elif [ -z "$AGENTS_EXPLICIT" ]; then
  # `null` means "the user said nothing": the default agent applies only when
  # the entry is created, and a re-run then leaves a hand-written `options`
  # alone. Overwriting it with `copilot --acp` on every invocation would be a
  # silent loss, which is exactly what this script refuses to do elsewhere.
  AGENTS_JSON='null'
else
  AGENTS_JSON="$(
    printf '%s\n' "${AGENT_SPECS[@]}" | "$RUNNER" -e '
      const lines = require("fs").readFileSync(0, "utf8").split("\n").filter((l) => l.trim() !== "")
      // Each spec is a command line, split with quote awareness so an argument
      // containing a space stays one argument.
      const agents = lines.map((line) => {
        const parts = line.match(/"[^"]*"|\S+/g) ?? []
        const words = parts.map((p) => (p.startsWith("\"") ? JSON.parse(p) : p))
        const [command, ...args] = words
        return args.length > 0 ? { command, args } : { command }
      })
      if (agents.some((a) => typeof a.command !== "string" || a.command === "")) {
        throw new Error("an --agent is empty")
      }
      process.stdout.write(JSON.stringify(agents))
    '
  )" || die "cannot build the agent list."
  # `${arr[*]}` joins on the first character of IFS, hence a lone comma.
  [ "$MODE" = "install" ] && note "agents : $(IFS=$', '; echo "${AGENT_SPECS[*]}")"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Confirmation
# ─────────────────────────────────────────────────────────────────────────────

if [ "$MODE" = "install" ] && [ -z "$ASSUME_YES" ] && [ -t 0 ]; then
  [ -f "$CONFIG" ] && note "existing configuration: $CONFIG (backup before writing)"
  note "target           : $CONFIG"
  note "entry point      : $PLUGIN_ENTRY"
  printf 'Write? [y/N] '
  read -r reply
  case "$reply" in
    y|Y|o|O|oui|OUI) ;;
    *) note "cancelled."; exit 0 ;;
  esac
fi

# ─────────────────────────────────────────────────────────────────────────────
# Merge
# ─────────────────────────────────────────────────────────────────────────────

# A `plugins` entry in a config array does not load, measured repeatedly on
# both a global and a project config; a re-export file in a plugins directory
# does. The shim also leaves the user configuration untouched.
SHIM_PATH="$SHIM_DIR/$SHIM_NAME"

if [ "$MODE" = "uninstall" ]; then
  if [ -f "$SHIM_PATH" ]; then
    rm -f "$SHIM_PATH"
    note "removed: $SHIM_PATH"
  else
    note "nothing to remove: $SHIM_PATH is absent"
  fi
  exit 0
fi

mkdir -p "$SHIM_DIR"
cat > "$SHIM_PATH" <<SHIM_EOF
// Generated by opencode-acp-provider install.sh. Safe to delete.
//
// The agent list is read from your own configuration, so this file holds no
// agent of its own: configure them under
//   "acp": { "agents": [{ "command": "...", "args": ["..."] }] }
// in ~/.config/opencode/opencode.json, or under
//   plugins[].options.agents
// when the plugin is declared there directly.
import { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import acp from "$PLUGIN_ENTRY"

const readUserAgents = () => {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    try {
      const raw = JSON.parse(readFileSync(join(homedir(), ".config", "opencode", name), "utf8"))
      const agents = raw?.acp?.agents
      if (Array.isArray(agents) && agents.length > 0) return { agents }
    } catch {}
  }
  return undefined
}

export default Plugin.define({
  ...acp,
  setup: (ctx) =>
    acp.setup({ ...ctx, options: $AGENTS_JSON ?? readUserAgents() ?? ctx.options }),
})
SHIM_EOF
note "written: $SHIM_PATH"

[ -f "$SHIM_PATH" ] || die "the shim could not be written"
grep -q "$PLUGIN_ENTRY" "$SHIM_PATH" || die "the shim does not point at the expected entry point"

if [ "$MODE" = "status" ]; then
  note "installed: $SHIM_PATH"
  exit 0
fi

# `install-config.mjs` is what merges the agent list into the user's config: it
# reads the JSONC, writes a backup, refuses a commented config without --force,
# then reads the merge back and checks it. It never ran - the unconditional
# `exit 0` below this comment returned before the `exec`, so an install wrote
# the shim and stopped there, leaving the configuration merge silently undone.
exec "$RUNNER" "$ROOT/scripts/install-config.mjs" \
  "$MODE" \
  --config "$CONFIG" \
  --plugin "$PLUGIN_ENTRY" \
  --repo "$ROOT" \
  --agents "$AGENTS_JSON" \
  $FORCE
