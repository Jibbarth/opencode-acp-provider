/**
 * `acp-run` — la CLI de debug de la phase P0.
 *
 * Elle ne fait rien de plus que le cœur : elle lance un agent ACP, affiche son
 * inventaire, et envoie un prompt en imprimant le flux `AcpEvent` en JSONL
 * sur stdout. C'est l'outil qui permet de qualifier un agent inconnu (« est-ce
 * qu'il obéit au contrat JSON ? » §13.3) avant d'investir dans l'adaptateur
 * OpenCode.
 *
 *   acp-run --command copilot --arg --acp --list-models
 *   acp-run --command copilot --arg --acp --prompt "PING"
 *
 * Convention : **stdout = JSONL** (donc exploitable par `jq`), **stderr = humain**.
 */

import { createAcpAgent } from "../acp/agent.js"
import type { AcpAgent, Inventory, NormalizedRequest } from "../core/types.js"
import { allowAllPermissions, denyAllPermissions } from "../core/types.js"

/** Ce que `--list-models` affiche. */
interface InventoryReport {
  agentName: string
  agentVersion: string
  protocolVersion: number
  inventory: Inventory
}

interface CliOptions {
  command: string
  args: string[]
  cwd: string
  model?: string
  effort?: string
  prompt?: string
  listModels: boolean
  allowTools: boolean
}

/** Usage affiché sur stderr. */
const usage = (): string => `acp-run — lance un agent ACP et montre ce qu'il produit

  --command <cmd>     commande de l'agent (obligatoire, ex. "copilot")
  --arg <value>       argument de la commande, répétable (ex. --acp)
  --cwd <dir>         répertoire de travail (défaut: cwd courant)
  --model <id>        valeur d'option appliquée avant le prompt (catégorie "model")
  --effort <value>    valeur d'option appliquée avant le prompt (catégorie "thought_level")
  --prompt <text>     texte envoyé à l'agent ; la réponse est affichée en JSONL
  --list-models       affiche l'inventaire (modèles, efforts, modes, permissions)
  --allow-tools       autorise les outils natifs de l'agent au lieu de tout refuser
  -h, --help          cette aide

Exemples :
  acp-run --command copilot --arg --acp --list-models
  acp-run --command copilot --arg --acp --model claude-sonnet-5 --list-models
  acp-run --command copilot --arg --acp --prompt '{"type":"text","text":"pong"}'

Codes de sortie :
  0  succès   1  le flux a émis un événement "error"
  2  arguments invalides   3  l'agent n'a pas pu démarrer
  4  l'agent a refusé une option (--model / --effort)
`

/** Parseur d'arguments minimal : pas de dépendance externe. */
const parseArgs = (argv: readonly string[]): CliOptions | { help: true } => {
  const options: CliOptions = {
    command: "",
    args: [],
    cwd: process.cwd(),
    listModels: false,
    allowTools: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // `--flag` et `--flag value` sont tous deux acceptés.
    const [flag, inlineValue] = splitFlag(arg ?? "")
    const value = (): string => {
      if (inlineValue !== undefined) return inlineValue
      const next = argv[i + 1]
      if (next === undefined) throw new Error(`option ${flag} attend une valeur`)
      i++
      return next
    }

    switch (flag) {
      case "-h":
      case "--help":
        return { help: true }
      case "--command":
        options.command = value()
        break
      case "--arg":
        options.args.push(value())
        break
      case "--cwd":
        options.cwd = value()
        break
      case "--model":
        options.model = value()
        break
      case "--effort":
        options.effort = value()
        break
      case "--prompt":
        options.prompt = value()
        break
      case "--list-models":
        options.listModels = true
        break
      case "--allow-tools":
        options.allowTools = true
        break
      default:
        throw new Error(`option inconnue : ${arg ?? ""}`)
    }
  }

  if (options.command === "") throw new Error("--command est obligatoire")
  return options
}

const splitFlag = (arg: string): [string, string | undefined] => {
  const index = arg.indexOf("=")
  if (index < 0) return [arg, undefined]
  return [arg.slice(0, index), arg.slice(index + 1)]
}

/** Requête minimale : pour l'instant on n'envoie que le texte brut (P2b fera mieux). */
const toRequest = (text: string): NormalizedRequest => ({
  system: [],
  tools: [],
  messages: [{ role: "user", text }],
})

/** Affichage humain de l'inventaire, sur stderr. */
const printInventory = (report: InventoryReport): void => {
  const line = (label: string, value: string): void => {
    process.stderr.write(`${label.padEnd(16)}${value}\n`)
  }
  const { inventory } = report
  const version = `protocole v${report.protocolVersion}`
  line("agent", `${report.agentName} ${report.agentVersion} (${version})`)
  line("modèles", inventory.models.map((m) => m.id).join(", ") || "(aucun)")
  line("modèle actif", inventory.currentModel ?? "(aucun)")
  line("efforts", inventory.thoughtLevels.join(", ") || "(aucun)")
  line("modes", inventory.modes.map((m) => m.id).join(", ") || "(aucun)")
  const perms = inventory.permissions
  line(
    "permissions",
    perms ? `${perms.id}=${perms.currentValue} [${perms.values.join(", ")}]` : "(aucune)",
  )
}

/** Point d'entrée du binaire `acp-run` (voir `bin/acp-run.ts`). */
export const main = async (argv: readonly string[]): Promise<number> => {
  let options: CliOptions | { help: true }
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`)
    return 2
  }
  if ("help" in options) {
    process.stderr.write(usage())
    return 0
  }

  if (!options.listModels && options.prompt === undefined) {
    process.stderr.write("rien à faire : passe --list-models et/ou --prompt\n")
    return 2
  }

  let agent: AcpAgent
  try {
    agent = await createAcpAgent({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      policy: options.allowTools ? allowAllPermissions : denyAllPermissions,
      // Seule la CLI veut voir les logs de l'agent : elle **est** le terminal
      // de l'utilisateur. Un hébergeur garderait le défaut `"pipe"` (§2.3).
      stderr: "inherit",
    })
  } catch (error) {
    // `AcpAgentError` porte déjà un message qui nomme la commande : inutile
    // d'y ajouter une stack de SDK illisible.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 3
  }

  let failed = false
  try {
    process.stderr.write(
      `→ ${options.command} ${options.args.join(" ")}` +
        ` (${agent.info.name} ${agent.info.version})\n`,
    )

    // Une seule session pour les deux opérations : quand `--list-models` est
    // combiné à `--model`/`--effort`, l'inventaire affiché reflète l'état réel
    // après application des bascules.
    const session = await agent.open({ cwd: options.cwd })

    try {
      // ⚠️ « Modèle inconnu » est le diagnostic le plus probable face à un agent
      // exotique. Sans ce `try/catch`, une valeur refusée remonte en rejection
      // non rattrapée avec une stack de SDK illisible, et l'utilisateur ne voit
      // ni la liste des valeurs acceptées ni la commande qui a échoué.
      try {
        if (options.model !== undefined) await session.setModel(options.model)
        if (options.effort !== undefined) {
          const effort = session.inventory().options.find((o) => o.category === "thought_level")
          if (effort !== undefined) await session.setOption(effort.id, options.effort)
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const known = session
          .inventory()
          .models.map((m) => m.id)
          .join(", ")
        process.stderr.write(
          `option refusée par l'agent : ${detail}\n` +
            (known === "" ? "" : `modèles connus : ${known}\n`),
        )
        return 4
      }

      if (options.listModels) {
        printInventory({
          agentName: agent.info.name,
          agentVersion: agent.info.version,
          protocolVersion: agent.protocolVersion,
          inventory: session.inventory(),
        })
      }

      if (options.prompt !== undefined) {
        // Un événement par ligne : lisible à l'œil *et* pipeable dans `jq`.
        for await (const event of session.prompt(toRequest(options.prompt))) {
          process.stdout.write(`${JSON.stringify(event)}\n`)
          // ⚠️ Un `error` dans le flux doit rendre un code **non nul** : avec 0,
          // la CI ne voit rien et l'échec passe inaperçu.
          if (event.type === "error") failed = true
        }
      }
      return failed ? 1 : 0
    } finally {
      await session.close()
    }
  } finally {
    await agent.close()
  }
}

// Exécution directe (`bun run src/adapters/cli.ts`) — ignorée quand le module
// est importé (par `bin/acp-run.ts`).
if (import.meta.main === true) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      process.stderr.write(`${detail}\n`)
      process.exit(1)
    },
  )
}
