import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * A content hash of a built directory, used to answer "is this exact output already
 * live?" without uploading it.
 *
 * The path is hashed alongside the bytes, so renaming a file changes the result even
 * though no byte of content did — a rename is a different site.
 *
 * Entries are sorted, because directory listing order is a filesystem detail: the same
 * files written in a different order must produce the same hash or the skip is useless.
 */

export interface FileEntry {
  /** Path relative to the root, always with forward slashes. */
  path: string;
  bytes: Buffer;
}

export function hashEntries(entries: FileEntry[]): string {
  const h = createHash("sha256");
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(e.path);
    h.update("\0");
    h.update(e.bytes);
    h.update("\0");
  }
  return h.digest("hex");
}

async function collect(root: string, dir: string, out: FileEntry[]): Promise<void> {
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      await collect(root, full, out);
    } else if (item.isFile()) {
      out.push({ path: relative(root, full).split(sep).join("/"), bytes: await readFile(full) });
    }
    // Symlinks and sockets are skipped: a build output containing one is not something
    // we can meaningfully upload, and following them could walk out of the directory.
  }
}

export async function hashDir(root: string): Promise<string> {
  const entries: FileEntry[] = [];
  await collect(root, root, entries);
  return hashEntries(entries);
}
