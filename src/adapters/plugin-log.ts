/**
 * The plugin's diagnostic file.
 *
 * Note: **why a file, when the plugin already writes to stderr.** In the TUI the
 * server runs with `--stdio`, and its stderr does not reach the user's terminal:
 * every line the plugin writes - including the one saying why the agent died -
 * is invisible. That turned a diagnosable failure into a mystery. A file the
 * user can `tail -f` is the only channel that survives every host mode.
 *
 * Note: the path follows OpenCode's own data directory, so the log sits next to
 * the server's journal rather than in a place the user would never look.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const DATA_DIR = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share")
export const LOG_PATH = join(DATA_DIR, "opencode", "acp-provider.log")

/**
 * Appends one line, timestamped.
 *
 * Note: **fire and forget, and never fatal.** A log that could throw would put a
 * logging failure in the middle of a turn, which is the one thing a diagnostic
 * must never do. Hence the `catch` that swallows: an unwritable log costs the
 * diagnostic, not the turn.
 *
 * Note: the file is **not** truncated. It grows, and the user is expected to
 * clear it; a log that erases itself would take the evidence with it.
 */
export const appendLog = (line: string): void => {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    // The timestamp is what makes a sequence readable: without it, four
    // removals and four additions look like a burst rather than a loop.
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}`, "utf8")
  } catch {
    // Nothing: the plugin must never fail because its log is unavailable.
  }
}
