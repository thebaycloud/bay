import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchSource, type SourceOrigin, type FetchDeps } from "../lib/source";

/**
 * Getting the source onto disk.
 *
 * The interesting assertions are not about tar or git — those are somebody
 * else's programs and testing them proves nothing. They are about the ONE thing
 * the three ways in have to agree about, which is exactly the thing that was
 * learned twice because the code lived in three places: whichever door the bytes
 * came through, broken symlinks are gone before a build sees the directory.
 */

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "source-"));
  for (const [path, body] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

/** Records what was asked of the world instead of doing it. */
function spy() {
  const ran: Array<{ cmd: string; args: string[] }> = [];
  const logs: string[] = [];
  const stages: string[] = [];
  const deps: FetchDeps = {
    run: async (cmd, args) => { ran.push({ cmd, args }); },
    log: (l) => logs.push(l),
    stages: {
      around: (async (name: string, fn: () => Promise<unknown>) => { stages.push(`around:${name}`); return fn(); }) as never,
      skipped: (async (name: string) => { stages.push(`skipped:${name}`); }) as never,
    },
  };
  return { deps, ran, logs, stages };
}

test("a broken symlink is removed whichever way the source arrived", async () => {
  // The claim this module exists to make. It was once true only for uploads,
  // because that is the branch the fix was written in — and a clone of a repo
  // that commits links into an absent `.venv` produces byte-for-byte the same
  // dangling links. `gcloud builds submit` dies on them naming neither the file
  // nor the reason.
  const origins: SourceOrigin[] = [
    { kind: "upload", archive: Buffer.from("") },
    { kind: "cached-clone" },
    { kind: "clone", url: "https://example.invalid/x.git" },
  ];

  for (const origin of origins) {
    const dir = repo({ "app.py": "x = 1" });
    symlinkSync(join(dir, ".venv/gone"), join(dir, "dangling"));
    assert.ok(!existsSync(join(dir, "dangling")), "the link's target is absent — that is the case under test");

    await fetchSource(dir, origin, spy().deps);

    // lstat, not exists: the file must be GONE, not merely unreadable.
    const { lstatSync } = await import("node:fs");
    assert.throws(() => lstatSync(join(dir, "dangling")),
      `${origin.kind}: the dangling link survived and would crash the build`);
    // And a real file beside it is untouched.
    assert.ok(existsSync(join(dir, "app.py")), `${origin.kind}: pruning must not take real files`);
  }
});

test("a link whose target IS present stays", async () => {
  // The prune must not be "delete every symlink". A repo may legitimately ship
  // links inside itself, and removing those breaks builds that work today.
  const dir = repo({ "real.txt": "hello" });
  symlinkSync(join(dir, "real.txt"), join(dir, "alias"));

  await fetchSource(dir, { kind: "cached-clone" }, spy().deps);

  assert.ok(existsSync(join(dir, "alias")), "a resolvable link is not broken and must be left alone");
});

test("a reused clone fetches nothing, and says so in the data", async () => {
  // The saving IS the fetch that does not happen, so it has to be recorded.
  // A skipped stage that goes unwritten is a saving nobody can check later.
  const { deps, ran, stages } = spy();
  await fetchSource(repo({ "a.txt": "x" }), { kind: "cached-clone" }, deps);

  assert.deepEqual(ran, [], "nothing should be cloned or extracted");
  assert.ok(stages.includes("skipped:clone"), "the skip must appear in deploy_stages");
});

test("each way in is timed under the stage that names it", async () => {
  const upload = spy();
  await fetchSource(repo({}), { kind: "upload", archive: Buffer.from("") }, upload.deps);
  assert.ok(upload.stages.includes("around:unpack"));
  assert.equal(upload.ran[0]?.cmd, "tar");

  const clone = spy();
  await fetchSource(repo({}), { kind: "clone", url: "https://example.invalid/x.git" }, clone.deps);
  assert.ok(clone.stages.includes("around:clone"));
  assert.equal(clone.ran[0]?.cmd, "git");
  assert.ok(clone.ran[0]?.args.includes("--depth"), "a deploy needs one commit, not a history");
});

test("the walk does not descend through a link, however it points", async () => {
  // A link to `.` or to the parent makes a naive walk unbounded. Two guards
  // exist — never descending through a link, and a depth cap — and this is the
  // one that matters, because the cap only bounds the damage.
  const dir = repo({ "deep/a.txt": "x" });
  symlinkSync(dir, join(dir, "deep", "loop"));

  await fetchSource(dir, { kind: "cached-clone" }, spy().deps);

  assert.ok(existsSync(join(dir, "deep", "a.txt")), "the walk finished and left real files alone");
});

test("a private clone authenticates git and tells the log nothing", async () => {
  const s = spy();
  await fetchSource(
    repo({}),
    { kind: "clone", url: "https://github.com/thebaycloud/bay.git", token: "ghs_secret" },
    s.deps,
  );
  const clone = s.ran.find((r) => r.cmd === "git");
  assert.ok(clone, "git was never run");
  assert.ok(
    clone.args.includes("https://x-access-token:ghs_secret@github.com/thebaycloud/bay.git"),
    `git was not given the authenticated url: ${clone.args.join(" ")}`,
  );
  // The whole point. Every line the logger saw is stored, replayed on reconnect
  // and shown to the person watching their app get built.
  for (const line of s.logs) {
    assert.ok(!line.includes("ghs_secret"), `the token reached a log line: ${line}`);
  }
  assert.ok(
    s.logs.some((l) => l.includes("https://github.com/thebaycloud/bay.git")),
    "the clean url should still be logged — it is how a person knows what is being pulled",
  );
});

test("a clone without a token is byte-for-byte what it always was", async () => {
  const s = spy();
  const dir = repo({});
  await fetchSource(dir, { kind: "clone", url: "https://github.com/o/r.git" }, s.deps);
  const clone = s.ran.find((r) => r.cmd === "git");
  assert.deepEqual(clone?.args, ["clone", "--depth", "1", "https://github.com/o/r.git", dir]);
});
