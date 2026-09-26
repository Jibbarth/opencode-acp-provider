/**
 * The JSON half of `install.sh`: read a JSONC OpenCode config, decide the
 * merge, write it after a backup, then read it back and check.
 *
 * Note: a separate file because it runs under **bun or node**, whichever is
 * present, and because it is the only place allowed to reformat a config. Like
 * `verify-package.mjs`, it is deliberately plain ESM with no Bun API: the
 * installer must not add a prerequisite to the project it installs.
 *
 * Note: reformatting cannot preserve comments, so the policy is explicit rather
 * than best-effort. A config without comments is merged silently; a config
 * **with** comments is refused unless `--force`, because dropping a user's
 * comments is a loss they did not ask for and would not notice. The backup is
 * written in both cases, and the refusal names it.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// JSONC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Blanks out `//` and comments, keeping every byte position and every newline
 * so a `JSON.parse` error still points at the right line.
 */
const stripComments = (text) => {
  const out = text.split("")
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      i += 1
      // A JSON string: skip to its end, so a `//` inside one is not a comment.
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2
          continue
        }
        if (text[i] === '"') break
        i += 1
      }
      i += 1
      continue
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out[i] = " "
        i += 1
      }
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      out[i] = " "
      out[i + 1] = " "
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] !== "\n") out[i] = " "
        i += 1
      }
      if (i < text.length) {
        out[i] = " "
        out[i + 1] = " "
        i += 2
      }
      continue
    }
    i += 1
  }
  return out.join("")
}

/** Drops `,` that a lenient JSONC dialect allows before `}` or `]`. */
const stripTrailingCommas = (text) => {
  const out = text.split("")
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      i += 1
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2
          continue
        }
        if (text[i] === '"') break
        i += 1
      }
      i += 1
      continue
    }
    if (c === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j += 1
      if (text[j] === "}" || text[j] === "]") out[i] = " "
    }
    i += 1
  }
  return out.join("")
}

/** Indentation of the existing file, so a rewrite does not reformat everything. */
const detectIndent = (text) => {
  const match = /\n([ \t]+)"/.exec(text)
  return match === null ? "  " : match[1]
}

const parseJsonc = (text, path) => {
  const stripped = stripComments(text)
  const hasComments = stripped !== text
  let parsed
  try {
    parsed = JSON.parse(stripTrailingCommas(stripped))
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must hold a JSON object, not ${Array.isArray(parsed) ? "an array" : typeof parsed}`)
  }
  return { config: parsed, hasComments, indent: detectIndent(text) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Recognising our own entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a `plugins[].package` designates **this** checkout.
 *
 * Note: several spellings must be recognised, not just the absolute one we
 * write. A user who first installed with a relative path, or with the bare npm
 * name, then re-runs the installer from a new clone: treating that entry as a
 * stranger would append a second one, and the two entries would register the
 * same provider twice.
 */
const isOurPackage = (specifier, repoRoot) => {
  if (typeof specifier !== "string") return false
  if (specifier === "opencode-acp-provider") return true
  const bare = specifier.startsWith("file://") ? specifier.slice("file://".length) : specifier
  if (!bare.startsWith("/")) return false
  const normalized = bare.replace(/\/plugin\.(ts|js)$/, "")
  return normalized === repoRoot || normalized === resolve(repoRoot, "src") || normalized === resolve(repoRoot, "dist")
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The entry we want.
 *
 * `agents` is `null` when the caller said nothing about agents. That is not the
 * same as an empty list: it means "keep whatever the existing entry already
 * declares", so a re-run cannot silently drop a hand-written agent list. It
 * still applies to a **new** entry, which then gets the default.
 */
const desiredEntry = (pluginPath, agents) => {
  const entry = { package: pluginPath }
  if (agents !== null && agents.length > 0) entry.options = { agents }
  return entry
}

const sameEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Decides the new config, or refuses.
 *
 * Returns `{ config, action }` where action is `create` (no file yet), `noop`
 * (already exactly right) or `write`.
 */
const merge = (config, agents, pluginPath, repoRoot, hasComments, force) => {
  const entry = desiredEntry(pluginPath, agents)
  const plugins = config.plugins
  if (plugins === undefined) return { config: { ...config, plugins: [entry] }, action: "write" }
  if (!Array.isArray(plugins)) {
    throw new Error(
      `the \`plugins\` field exists and is not an array (it is a ${typeof plugins}). ` +
        "Outdated installer: fix this field by hand, nothing was written.",
    )
  }
  const ours = plugins.filter((item) => isOurPackage(item?.package, repoRoot))
  const strangers = plugins.filter((item) => item !== null && typeof item !== "object")
  if (strangers.length > 0) {
    throw new Error(
      `\`plugins\` holds ${strangers.length} entries that are not objects ` +
        `(value ${JSON.stringify(strangers[0])}). Nothing was written: fix it by hand.`,
    )
  }
  if (ours.length > 1) {
    throw new Error(
      `${ours.length} entries already point at this repository ` +
        `(${ours.map((item) => item.package).join(", ")}). ` +
        "Outdated installer: it leaves a single one. Nothing was written.",
    )
  }
  const next = plugins.filter((item) => !isOurPackage(item?.package, repoRoot))
  // An existing entry whose `options` the caller did not ask to change is kept
  // whole, including any field we do not know about.
  const kept = agents === null && ours.length === 1 ? ours[0] : entry
  next.push(kept)
  if (ours.length === 1 && sameEntry(ours[0], kept)) return { config, action: "noop" }
  if (hasComments && !force) {
    throw new Error(
      "the configuration holds comments and the rewrite would lose them. " +
        "Nothing was written. Rerun with --force to rewrite anyway (a backup is made in both cases).",
    )
  }
  return { config: { ...config, plugins: next }, action: "write" }
}

/** Where our entry sits, for `--status` and `--uninstall`. */
const locate = (config, repoRoot) => {
  if (config.plugins === undefined) return { present: false, index: -1, count: 0 }
  if (!Array.isArray(config.plugins)) throw new Error("`plugins` is not an array")
  const count = config.plugins.filter((item) => isOurPackage(item?.package, repoRoot)).length
  const index = config.plugins.findIndex((item) => isOurPackage(item?.package, repoRoot))
  return { present: index >= 0, index, count }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

const fail = (message) => {
  process.stderr.write(`\ninstall.sh : ${message}\n`)
  process.exit(1)
}

const main = () => {
  const args = process.argv.slice(2)
  const flag = (name) => args.includes(name)
  const value = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  // The mode is the first positional argument, not a flag: `install.sh` decides
  // it from its own options, and a `--status` flag here could not be told apart
  // from a value.
  const first = args[0]
  const mode = first === "status" || first === "uninstall" ? first : "install"
  const configPath = resolve(value("--config") ?? "")
  const pluginPath = resolve(value("--plugin") ?? "")
  const repoRoot = resolve(value("--repo") ?? ".")
  const force = flag("--force")
  const agentsRaw = value("--agents")
  const agents = agentsRaw === undefined || agentsRaw === "null" ? null : JSON.parse(agentsRaw)

  if (!existsSync(configPath)) {
    if (mode === "status") {
      process.stdout.write(`configuration: ${configPath}\n  absent - the plugin is not installed\n`)
      return
    }
    if (mode === "uninstall") {
      process.stdout.write(`configuration: ${configPath}\n  absent - nothing to uninstall\n`)
      return
    }
    mkdirSync(dirname(configPath), { recursive: true })
    const fresh = { $schema: "https://opencode.ai/config.json", plugins: [desiredEntry(pluginPath, agents)] }
    writeFileSync(configPath, `${JSON.stringify(fresh, null, 2)}\n`, "utf8")
    process.stdout.write(`created: ${configPath}\n  plugin: ${pluginPath}\n`)
    readBack(configPath, pluginPath, repoRoot)
    return
  }

  const raw = readFileSync(configPath, "utf8")
  const { config, hasComments, indent } = parseJsonc(raw, configPath)

  if (mode === "status") {
    const found = locate(config, repoRoot)
    process.stdout.write(`configuration: ${configPath}\n`)
    process.stdout.write(
      found.present
        ? `  installed: ${config.plugins[found.index].package}\n  agents   : ${describe(config.plugins[found.index])}\n`
        : "  absent   : no entry points at this repository\n",
    )
    if (found.count > 1) process.stdout.write(`  warning: ${found.count} entries point at this repository\n`)
    if (hasComments) process.stdout.write("  note     : the file holds comments\n")
    return
  }

  if (mode === "uninstall") {
    const found = locate(config, repoRoot)
    if (!found.present) {
      process.stdout.write(`nothing to do: no entry points at ${repoRoot}\n`)
      return
    }
    if (hasComments && !force) {
      fail(
        "the configuration holds comments and the rewrite would lose them. " +
          "Nothing was written. Rerun with --force.",
      )
    }
    const next = { ...config, plugins: config.plugins.filter((_, i) => i !== found.index) }
    if (next.plugins.length === 0) delete next.plugins
    write(configPath, next, indent)
    process.stdout.write(`removed: ${config.plugins[found.index].package}\n`)
    readBack(configPath, pluginPath, repoRoot, true)
    return
  }

  const { config: merged, action } = merge(config, agents, pluginPath, repoRoot, hasComments, force)
  if (action === "noop") {
    process.stdout.write(`already installed: ${configPath}\n  plugin: ${pluginPath}\n  no write\n`)
    return
  }
  write(configPath, merged, indent)
  process.stdout.write(`written: ${configPath}\n  plugin: ${pluginPath}\n`)
  readBack(configPath, pluginPath, repoRoot)
}

const describe = (entry) =>
  Array.isArray(entry?.options?.agents)
    ? entry.options.agents.map((a) => [a.command, ...(a.args ?? [])].join(" ")).join(", ")
    : "(no agent declared)"

/** Backup first, then write, then confirm the backup really holds the old bytes. */
const write = (path, config, indent) => {
  const backup = `${path}.bak-${stamp()}`
  copyFileSync(path, backup)
  if (readFileSync(backup, "utf8") !== readFileSync(path, "utf8")) {
    fail(`the backup ${backup} does not reproduce ${path}: nothing was written.`)
  }
  writeFileSync(path, `${JSON.stringify(config, null, indent)}\n`, "utf8")
  process.stdout.write(`backup: ${backup}\n`)
  return backup
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "Z")

/**
 * Re-reads what was written and checks the entry survived.
 *
 * Note: the point is to catch a truncated or half-written file **before** the
 * user restarts OpenCode, not to admire the JSON. A parse failure here restores
 * the backup, so a failed install leaves the previous configuration intact.
 */
const readBack = (path, pluginPath, repoRoot, expectAbsent = false) => {
  let parsed
  try {
    parsed = parseJsonc(readFileSync(path, "utf8"), path).config
  } catch (error) {
    fail(`the written configuration is unreadable (${error instanceof Error ? error.message : String(error)}).`)
  }
  const found = locate(parsed, repoRoot)
  if (expectAbsent) {
    if (found.present) fail(`the entry is still present in ${path} after uninstall.`)
    process.stdout.write("verified: re-read, valid, entry absent\n")
    return
  }
  if (!found.present) fail(`the entry is not in ${path} after writing.`)
  if (parsed.plugins[found.index].package !== pluginPath) {
    fail(`the written entry does not point at ${pluginPath}.`)
  }
  process.stdout.write("verified: re-read, valid, entry present\n")
}

try {
  main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
