import { writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { StageRecorder } from "./stages";
import { authenticatedCloneUrl } from "./github-repos";

/**
 * Getting the app's source onto disk, whichever way it arrived.
 *
 * Three ways in, and the point of this module is that only ONE of them is
 * interesting to a caller: the deploy needs a populated directory, and which
 * door the bytes came through changes nothing after this returns.
 *
 * That was not true while this lived inline in `runDeploy`. The three branches
 * sat two hundred lines apart from the work that depends on them, and the fact
 * they had to agree about — that every one of them can produce dangling symlinks
 * — was learned twice, separately, because the first fix was written inside the
 * upload branch and read as a property of uploads. It is not. See `prune` below.
 */

/** How the source arrives. The deploy has already decided; this carries it. */
export type SourceOrigin =
  /** Bytes from the user's computer: a gzipped tar of the project folder. */
  | { kind: "upload"; archive: Buffer }
  /**
   * A clone `/api/detect` made moments ago and left behind, already populated.
   *
   * There is nothing to fetch — the value is the fetch that does NOT happen —
   * so this records `clone` as skipped rather than staying silent. A saving that
   * appears nowhere in the data is a saving nobody can check.
   */
  | { kind: "cached-clone" }
  /**
   * A fresh shallow clone.
   *
   * `url` is always the CLEAN url — it is what gets logged, and a log line here
   * is stored, replayed on reconnect and read by the person watching. When the
   * repository is private, `token` carries the installation token BESIDE it,
   * and the two are joined exactly once, at the call to `git`.
   *
   * Two fields rather than one pre-authenticated string, because an
   * authenticated string is a credential: the moment it arrives as `url`, every
   * line that already logs `origin.url` starts leaking it, and nothing about
   * those lines looks wrong.
   */
  | { kind: "clone"; url: string; token?: string };

export type Log = (line: string) => void;

/** What `fetchSource` needs to run and to time itself. */
export interface FetchDeps {
  /** Runs a command to completion, rejecting on a non-zero exit. */
  run: (cmd: string, args: string[]) => Promise<unknown>;
  log: Log;
  stages: Pick<StageRecorder, "around" | "skipped">;
}

/**
 * Put the app's source in `dir`, and leave it in a state a build can use.
 *
 * Resolves when the directory is populated and pruned. Rejects only when the
 * fetch itself failed — a clone that 404s, a tarball that will not extract —
 * because a deploy with no source cannot continue and saying so here is clearer
 * than failing later on a directory that is merely empty.
 */
export async function fetchSource(dir: string, origin: SourceOrigin, deps: FetchDeps): Promise<void> {
  const { run, log, stages } = deps;

  if (origin.kind === "upload") {
    await stages.around("unpack", async () => {
      log("Unpacking your project…");
      const tgz = `${dir}.tgz`;
      writeFileSync(tgz, origin.archive);
      await run("tar", ["-xzf", tgz, "-C", dir]);
    });
  } else if (origin.kind === "cached-clone") {
    log("Using the copy we already fetched");
    await stages.skipped("clone");
  } else {
    await stages.around("clone", async () => {
      // The clean url is logged; the authenticated one is built here, handed to
      // git, and never bound to anything a later line could reach for.
      log(`Pulling ${origin.url}`);
      const target = origin.token ? authenticatedCloneUrl(origin.url, origin.token) : origin.url;
      await run("git", ["clone", "--depth", "1", target, dir]);
    });
  }

  // AFTER all three, deliberately, and this placement is the module's one real
  // claim.
  //
  // The reasoning first written down for this was about the CLI excluding
  // `.venv` from an upload and thereby stranding the links that point into it.
  // True — and it made the fix look like a property of uploads, so it was
  // written inside that branch. It is not a property of uploads: a `git clone`
  // of a repo that COMMITTED those symlinks produces exactly the same dangling
  // links, because `.venv` is not in the repository either.
  // `fastapi/full-stack-fastapi-template` — the very repo that prompted the
  // original fix — commits `.agents/skills/fastapi` and `.agents/skills/sqlmodel`
  // as symlinks into `.venv`. Deploying it from a URL crashed
  // `gcloud builds submit` on 10 Aug with the same unattributable
  // `gcloud crashed (FileNotFoundError)` the fix existed to prevent, twice,
  // while the fix sat three branches away.
  pruneBrokenSymlinks(dir, log);
}

/**
 * Delete symlinks whose targets are not here.
 *
 * `gcloud builds submit` walks the context and dies on a link it cannot follow,
 * with an error naming neither the file nor the reason. Removing them is safe in
 * a way keeping them is not: a link whose target is absent cannot be read by the
 * build either, so nothing that works today stops working.
 *
 * Never descends THROUGH a link — a self-referential or parent-pointing link
 * makes that walk unbounded — and skips `.git`, which is full of them by design.
 * The depth cap is the second guard on the same hazard.
 */
export function pruneBrokenSymlinks(root: string, log: Log): void {
  const removed: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 12) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isSymbolicLink()) {
        if (!existsSync(full)) {                 // existsSync follows the link
          try { unlinkSync(full); removed.push(full.slice(root.length + 1)); } catch { /* nothing to do */ }
        }
        continue;                                 // never descend through a link
      }
      if (e.isDirectory() && e.name !== ".git") walk(full, depth + 1);
    }
  };
  walk(root, 0);
  if (removed.length) {
    log(`Ignoring ${removed.length} broken symlink${removed.length > 1 ? "s" : ""} (${removed.slice(0, 3).join(", ")}${removed.length > 3 ? "…" : ""}) — their targets are not part of a deploy`);
  }
}
