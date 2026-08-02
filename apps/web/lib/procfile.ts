import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The `Procfile` an app already ships.
 *
 * This is the one convention every app of the shape we are trying to serve
 * already writes down. `last/api` carries a Procfile AND a `railway.json`, both
 * declaring the same Django start command, and the platform reads neither: the
 * only two references to "Procfile" in the tree are a cache-key file list
 * (lib/plan-cache.ts) and a sentence inside the LLM planner's prompt
 * (lib/opencode-deploy.ts). So today we pay 40–180s for a model to rediscover a
 * fact sitting in a two-line file at the repo root.
 *
 * Reading it is also the only way `worker` becomes expressible without inventing
 * a syntax. `worker: python bot.py` is what a Telegram bot already has; the
 * schema's job is to not lose it.
 *
 * Format, as Heroku defined it and everyone else copied: `<name>: <command>`,
 * one per line, `#` comments, blank lines ignored. Deliberately NOT extended —
 * a Procfile with our own dialect in it stops being the file the app already
 * had, which is the entire reason to read it.
 */

export const PROCFILE = "Procfile";

/**
 * `web: gunicorn app:app` — the name and everything after the FIRST colon.
 *
 * The command is `(.*)` rather than `(.+)` so that a bare `web:` still matches
 * here and is refused below as "has no command". Told apart on purpose: a line
 * with a name and nothing to run is a different mistake from a line that is not
 * a process at all, and one message for both sends someone looking at the wrong
 * half of it.
 */
const ENTRY = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

export interface ProcfileEntry {
  name: string;
  command: string;
  /** 1-indexed, for error messages that can be clicked. */
  line: number;
}

export class ProcfileError extends Error {}

/**
 * Parse a Procfile's text.
 *
 * A line that is not blank, not a comment and not `name: command` is REFUSED
 * rather than skipped. Skipping is what a lenient reader does, and it means an
 * app whose worker line has a typo deploys as a web-only app and looks like the
 * worker silently never ran — which is indistinguishable from the worker being
 * broken, and is the failure mode this whole plan is about.
 */
export function parseProcfile(text: string): ProcfileEntry[] {
  const out: ProcfileEntry[] = [];
  const seen = new Map<string, number>();

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const m = ENTRY.exec(trimmed);
    if (!m) {
      throw new ProcfileError(
        `${PROCFILE} line ${line}: expected "name: command", got ${JSON.stringify(trimmed)}`,
      );
    }

    const name = m[1].toLowerCase();
    const command = m[2].trim();
    if (!command) throw new ProcfileError(`${PROCFILE} line ${line}: "${name}" has no command`);

    // Two lines naming one process is a file where one of them does nothing, and
    // which one depends on whether the reader keeps the first or the last. Both
    // answers are defensible, so neither is chosen.
    const first = seen.get(name);
    if (first !== undefined) {
      throw new ProcfileError(`${PROCFILE}: "${name}" is declared twice, on lines ${first} and ${line}`);
    }
    seen.set(name, line);

    out.push({ name, command, line });
  });

  return out;
}

/** The repo's Procfile, or null when it has none. Throws ProcfileError if unusable. */
export function readProcfile(dir: string): ProcfileEntry[] | null {
  const path = join(dir, PROCFILE);
  if (!existsSync(path)) return null;
  return parseProcfile(readFileSync(path, "utf8"));
}
