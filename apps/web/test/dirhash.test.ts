import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { hashDir, hashEntries, type FileEntry } from "../lib/dirhash";

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dirhash-"));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}
const entry = (path: string, body: string): FileEntry => ({ path, bytes: Buffer.from(body) });

test("the same files in a different order hash the same", () => {
  // Directory listing order is a filesystem detail. If it leaked into the hash the
  // skip would never fire.
  const a = hashEntries([entry("a.js", "1"), entry("b.js", "2"), entry("c.js", "3")]);
  const b = hashEntries([entry("c.js", "3"), entry("a.js", "1"), entry("b.js", "2")]);
  assert.equal(a, b);
});

test("changing a single byte changes the hash", () => {
  assert.notEqual(
    hashEntries([entry("a.js", "hello")]),
    hashEntries([entry("a.js", "hellp")]),
  );
});

test("renaming a file changes the hash even though no content did", () => {
  assert.notEqual(
    hashEntries([entry("a.js", "same")]),
    hashEntries([entry("b.js", "same")]),
  );
});

test("content cannot be shuffled between paths unnoticed", () => {
  // Without a separator between path and bytes, "ab" + "c" and "a" + "bc" collide.
  assert.notEqual(
    hashEntries([entry("ab", "c")]),
    hashEntries([entry("a", "bc")]),
  );
});

test("an empty directory has a stable hash", async () => {
  const dir = tree({});
  try {
    assert.equal(await hashDir(dir), hashEntries([]));
    assert.equal(await hashDir(dir), await hashDir(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("nested files are included, addressed by their relative path", async () => {
  const flat = tree({ "index.html": "x", "app.js": "y" });
  const nested = tree({ "index.html": "x", "assets/app.js": "y" });
  try {
    assert.notEqual(await hashDir(flat), await hashDir(nested));
  } finally {
    rmSync(flat, { recursive: true, force: true });
    rmSync(nested, { recursive: true, force: true });
  }
});

test("two identical trees in different places hash the same", async () => {
  const files = { "index.html": "<h1>hi</h1>", "assets/app-a1b2.js": "console.log(1)" };
  const a = tree(files);
  const b = tree(files);
  try {
    assert.equal(await hashDir(a), await hashDir(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("a real rebuild that changed nothing produces the same hash", async () => {
  const a = tree({ "index.html": "<script src=/assets/i-a1.js></script>", "assets/i-a1.js": "1" });
  const b = tree({ "index.html": "<script src=/assets/i-a1.js></script>", "assets/i-a1.js": "1" });
  try {
    assert.equal(await hashDir(a), await hashDir(b), "this equality is what makes a redeploy 3 seconds");
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
