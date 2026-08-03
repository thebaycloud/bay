import { spawn } from "node:child_process";

/**
 * What the repair agent changed, as a patch the user can actually apply.
 *
 * The agent edits the copy of the repo that the deploy unpacked on the server.
 * That copy is deleted when the deploy ends, so the fix existed only inside a
 * build: the app came up, the user's folder still held the broken code, and
 * their next `supersonic deploy` shipped it again. The dashboard said the app
 * was fixed and the repository disagreed, with nothing to reconcile them.
 *
 * A snapshot before and a `git diff` after is the whole mechanism. Using git
 * rather than a hand-rolled diff is deliberate: producing a correct unified diff
 * is a real algorithm, git is already in this image because the pipeline clones
 * with it, and a patch the user pipes into `git apply` has to be exactly the
 * format git itself would emit.
 *
 * Every function here is best-effort. A deploy that the agent rescued must not
 * fail because we could not describe how.
 */

/** Run a git command in `dir`, returning its stdout, or null if it failed. */
function git(dir: string, args: string[], timeoutMs = 20_000): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const kill = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } resolve(null); }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.on("error", () => { clearTimeout(kill); resolve(null); });
    p.on("close", (code) => { clearTimeout(kill); resolve(code === 0 ? out : null); });
  });
}

/**
 * Record the state of the sources so a later diff has something to diff against.
 *
 * An uploaded folder is not a git repository, so one is created. A cloned repo
 * already is, and committing on top of its history is equally fine — this
 * directory is a scratch copy that is about to be deleted either way.
 *
 * Returns false when no snapshot could be taken, which is the caller's signal
 * not to promise a patch later.
 */
export async function snapshotSources(dir: string): Promise<boolean> {
  // `git init` on an existing repository is a documented no-op, so this needs no
  // check of its own.
  if (await git(dir, ["init", "-q"]) === null) return false;
  // -A honours .gitignore, which is what keeps node_modules and .venv out of the
  // snapshot without a list of exclusions that would need maintaining.
  if (await git(dir, ["add", "-A"], 60_000) === null) return false;
  const commit = await git(dir, [
    "-c", "user.email=deploy@supersonic.cv",
    "-c", "user.name=supersonic",
    "commit", "-q", "--allow-empty", "-m", "before the repair agent",
  ], 60_000);
  return commit !== null;
}

/**
 * Files the PLATFORM writes into the build copy, which are not the author's.
 *
 * The reason this list exists is that the patch was unappliable, always, and
 * looked fine. `snapshotSources` commits the scratch directory AFTER the pipeline
 * has written `Dockerfile`, `.dockerignore` and `cloudbuild.yaml` into it, so an
 * agent that edited the Dockerfile produced a normal `--- a/Dockerfile` hunk. The
 * user's repository has no Dockerfile — dockerfile.ts:157 says so in as many
 * words, "Written into OUR copy of the repo, never the author's" — and `git
 * apply` validates every hunk before applying any. So the whole patch aborted,
 * taking the one-line requirements.txt fix with it, at a command the failure
 * email advertises by name.
 *
 * This was reproducible on the SPA and Next paths already. The collapse made it
 * universal: every app now has a generated Dockerfile in that directory.
 *
 * Both spellings of each name, because a sibling writes its own into its own
 * subdirectory — `glob` magic is what makes `**` mean "at any depth" rather than
 * a literal two asterisks.
 */
const PLATFORM_OWNED = ["Dockerfile", ".dockerignore", "cloudbuild.yaml"];

const excludePlatformFiles = (): string[] =>
  PLATFORM_OWNED.flatMap((f) => [`:(exclude)${f}`, `:(exclude,glob)**/${f}`]);

/**
 * The patch the repair agent produced, or null when there is nothing to show.
 *
 * Capped, because this is going into a log somebody reads in a terminal. An
 * agent that rewrote a lockfile would otherwise bury its own one-line fix under
 * ten thousand lines of noise.
 *
 * Scoped to the author's own files. What the agent changed about the Dockerfile
 * is real and worth keeping — it just cannot travel through `git apply`, because
 * the file it patches does not exist where the patch will be applied.
 */
export async function repairPatch(dir: string, maxBytes = 24_000): Promise<string | null> {
  const out = await git(dir, ["diff", "--", ".", ...excludePlatformFiles()], 60_000);
  if (out === null) return null;
  const patch = out.trim();
  if (!patch) return null;
  if (patch.length <= maxBytes) return patch;
  return patch.slice(0, maxBytes) + `\n… truncated (${patch.length - maxBytes} more bytes)`;
}
