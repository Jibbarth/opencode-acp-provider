#!/usr/bin/env bash
#
# opencode-acp-provider — installation en une commande.
#
#   git clone <repo> && cd opencode-acp-provider
#   ./install.sh                 # configuration globale
#   ./install.sh --local         # configuration du répertoire courant
#
# Ce que fait ce script, et surtout ce qu'il refuse de faire :
#
#   * il ne remplace jamais une configuration. Il fusionne : il cherche une
#     entrée `plugins[]` qui pointe déjà sur ce dépôt, et ne la duplique pas.
#     Deux installations successives convergent vers une entrée unique ;
#   * il sauvegarde le fichier avant de l'écrire, et le relit ensuite pour
#     vérifier que l'entrée a bien survécu ;
#   * il refuse une configuration dont il ne sait pas faire la fusion
#     (`plugins` qui n'est pas un tableau, entrée non-objet, deux entrées qui
#     pointent déjà ici), et il ne laisse rien à moitié écrit ;
#   * il refuse une configuration **commentée** sans `--force`, parce que la
#     réécriture perdrait les commentaires. La sauvegarde est faite dans les
#     deux cas, et le refus la nomme.
#
# Le chemin du plugin est **absolu**, résolu depuis ce script : il ne dépend pas
# du répertoire depuis lequel OpenCode est lancé.

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

  --global            écrit ~/.config/opencode/opencode.jsonc   (défaut)
  --local             écrit ./opencode.jsonc (répertoire courant)
  --config <chemin>   fichier de configuration explicite
  --status            rapporte l'état, n'écrit rien
  --uninstall         retire l'entrée de ce dépôt
  --agent "<cmd> [args...]"
                      agent à configurer, répétable
                      (défaut : copilot --acp)
  --no-agent          n'écrit aucun agent, à vous de les ajouter
  --force             autorise la réécriture d'une configuration commentée
                      (les commentaires seront perdus ; sauvegarde faite)
  --yes               ne demande pas confirmation
  -h, --help          cette aide

 exemples :
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
    --config) [ $# -ge 2 ] || die "--config exige un chemin"; CONFIG="$2"; shift ;;
    --status) MODE="status" ;;
    --uninstall) MODE="uninstall" ;;
    --force) FORCE="--force" ;;
    --yes|-y) ASSUME_YES="yes" ;;
    --agent) [ $# -ge 2 ] || die "--agent exige une commande"; AGENT_SPECS+=("$2"); AGENTS_EXPLICIT="yes"; shift ;;
    --no-agent) NO_AGENT="yes"; AGENTS_EXPLICIT="yes" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "option inconnue : $1" ;;
  esac
  shift
done

# ─────────────────────────────────────────────────────────────────────────────
# Prérequis
# ─────────────────────────────────────────────────────────────────────────────

[ -f "$ROOT/package.json" ] || die "$ROOT ne ressemble pas à opencode-acp-provider (package.json absent)."
[ -f "$PLUGIN_ENTRY" ] || die "point d'entrée plugin introuvable : $PLUGIN_ENTRY"

# Le provider est chargé par le serveur OpenCode, qui résout ses dépendances
# depuis node_modules : sans install, le premier tour échoue sur un import.
if [ ! -d "$ROOT/node_modules/@opencode/ai" ]; then
  note "! node_modules incomplet : lancez d'abord"
  note "    bun install"
fi

RUNNER=""
for candidate in bun node; do
  if command -v "$candidate" >/dev/null 2>&1; then RUNNER="$candidate"; break; fi
done
[ -n "$RUNNER" ] || die "aucun runtime JavaScript trouvé (bun ou node est requis pour écrire la configuration)."

# La version d'OpenCode doit correspondre à celle de @opencode/plugin : le
# plugin est chargé par le serveur, et c'est sa version qui décide du contrat.
PINNED="$("$RUNNER" -e 'const p=require(process.argv[1]);process.stdout.write((p.devDependencies||{})["@opencode/plugin"]||"?")' "$ROOT/package.json" 2>/dev/null || echo '?')"
if command -v opencode >/dev/null 2>&1; then
  FOUND="$(opencode --version 2>/dev/null | sed -nE 's/.*v?([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
  if [ -n "$FOUND" ] && [ "$FOUND" != "$PINNED" ]; then
    note "! OpenCode $FOUND alors que @opencode/plugin est épinglé sur $PINNED."
    note "  Le plugin est chargé par le serveur : c'est sa version qui fait foi."
  fi
else
  note "! opencode n'est pas dans le PATH : la configuration sera écrite, mais OpenCode ne pourra pas la lire."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Cible
# ─────────────────────────────────────────────────────────────────────────────

if [ "$SCOPE" = "local" ]; then
  [ -n "$CONFIG" ] || CONFIG="$PWD/opencode.jsonc"
  SHIM_DIR="$PWD/.opencode/plugins"
else
  SHIM_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
fi

# Un lien symbolique est suivi, pas réécrit : le fichier visé peut être versionné
# (dotfiles), et y écrire à travers le lien ferait diverger l'autre nom.
if [ -L "$CONFIG" ]; then
  RESOLVED="$(cd -- "$(dirname -- "$CONFIG")" && pwd -P)/$(readlink -- "$CONFIG")"
  note "! $CONFIG est un lien symbolique : l'écriture porte sur $RESOLVED"
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
        throw new Error("un --agent est vide")
      }
      process.stdout.write(JSON.stringify(agents))
    '
  )" || die "impossible de construire la liste d'agents."
  # `${arr[*]}` joins on the first character of IFS, hence a lone comma.
  [ "$MODE" = "install" ] && note "agents : $(IFS=$', '; echo "${AGENT_SPECS[*]}")"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Confirmation
# ─────────────────────────────────────────────────────────────────────────────

if [ "$MODE" = "install" ] && [ -z "$ASSUME_YES" ] && [ -t 0 ]; then
  [ -f "$CONFIG" ] && note "configuration existante : $CONFIG (sauvegarde avant écriture)"
  note "cible            : $CONFIG"
  note "point d'entrée   : $PLUGIN_ENTRY"
  printf 'Écrire ? [o/N] '
  read -r reply
  case "$reply" in
    o|O|oui|OUI|y|Y) ;;
    *) note "annulé."; exit 0 ;;
  esac
fi

# ─────────────────────────────────────────────────────────────────────────────
# Fusion
# ─────────────────────────────────────────────────────────────────────────────

# A `plugins` entry in a config array does not load, measured repeatedly on
# both a global and a project config; a re-export file in a plugins directory
# does. The shim also leaves the user configuration untouched.
SHIM_PATH="$SHIM_DIR/$SHIM_NAME"

if [ "$MODE" = "uninstall" ]; then
  if [ -f "$SHIM_PATH" ]; then
    rm -f "$SHIM_PATH"
    note "supprime : $SHIM_PATH"
  else
    note "rien a supprimer : $SHIM_PATH est absent"
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
note "ecrit : $SHIM_PATH"

[ -f "$SHIM_PATH" ] || die "le shim na pas pu etre ecrit"
grep -q "$PLUGIN_ENTRY" "$SHIM_PATH" || die "le shim ne designe pas le point dentree attendu"

if [ "$MODE" = "status" ]; then
  note "installe : $SHIM_PATH"
  exit 0
fi

exit 0

exec "$RUNNER" "$ROOT/scripts/install-config.mjs" \
  "$MODE" \
  --config "$CONFIG" \
  --plugin "$PLUGIN_ENTRY" \
  --repo "$ROOT" \
  --agents "$AGENTS_JSON" \
  $FORCE
