import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `describeService` must never be called where it can throw unhandled.
 *
 * It shells out to `gcloud run services describe`, which fails for an app on a
 * fleet node — because such an app has no Cloud Run service — and every new app
 * is a fleet app. So an unguarded call is not an edge case, it is the normal
 * path, and it fails in the worst available way: the route throws before its own
 * error handling, Next answers an HTML 500, and the caller reports something else
 * entirely.
 *
 * FIVE separate occurrences before this test existed:
 *
 *   1. the agent's `keys` tool — answered "no environment keys configured"
 *      about an app with five, which is why `lib/env-keys.ts` exists
 *   2. `/api/apps/[slug]/fix` — the screen said "Couldn't reach the server"
 *      about a server that had answered and had said why
 *   3. `/api/apps/[slug]/env` — printed
 *      `ERROR: (gcloud.run.services.describe) Cannot find service [x]` at the end
 *      of every SUCCESSFUL ship
 *   4. the same, reported from outside by a deploy report
 *   5. `/api/apps/[slug]/diagnose` — 500ed, so `bay diagnose` printed nothing
 *      through twelve minutes of a stalled build
 *
 * A comment on the function did not stop the fifth. A test can.
 */

const ROOTS = ["app", "lib"];
const EXT = /\.(ts|tsx)$/;

/** Where the call is legitimately bare, each for a reason. */
const ALLOWED = new Map<string, string>([
  // The definition.
  ["lib/gcloud.ts", "declares it"],
  // The one function whose whole job is to branch on runtime and catch this. Its
  // callers guard `envKeysFor`, not this.
  ["lib/env-keys.ts", "the Cloud Run arm of the branch that exists for this"],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

/**
 * Whether this line hands its own failure somewhere.
 *
 * `.catch(` on the call, or an enclosing `try` within a dozen lines above. Not a
 * parser — a heuristic that errs toward FLAGGING, because the cost of a false
 * positive is one comment and the cost of a false negative is a 500 in
 * production.
 */
function handled(lines: string[], i: number): boolean {
  if (lines[i].includes(".catch(")) return true;
  for (let j = i; j >= Math.max(0, i - 12); j--) {
    if (/^\s*try\s*\{/.test(lines[j])) return true;
    // A function boundary means the try above belonged to something else.
    if (j < i && /^(export )?(async )?function |^\s*\}\s*$/.test(lines[j]) && j < i - 1) break;
  }
  return false;
}

test("describeService is never called where it can throw unhandled", () => {
  const web = join(__dirname, "..");
  const bare: string[] = [];

  for (const root of ROOTS) {
    for (const file of walk(join(web, root))) {
      const rel = relative(web, file).split("\\").join("/");
      if (ALLOWED.has(rel) || /\.test\.tsx?$/.test(rel)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // The call, not the import and not a mention in prose.
        if (!/describeService\s*\(/.test(line)) return;
        if (/^\s*(\/\/|\*)/.test(line) || /^import /.test(line)) return;
        if (!handled(lines, i)) bare.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
    }
  }

  assert.deepEqual(
    bare,
    [],
    "describeService throws for every app on a fleet node, which is every new app. " +
      "Wrap it in a try or add `.catch(() => null)` and read the runtime from " +
      "`envKeysFor`/`deployTargetForApp` instead — or add the file to ALLOWED with a reason.\n\n" +
      bare.join("\n"),
  );
});

test("the allow list still describes files that exist", () => {
  const web = join(__dirname, "..");
  for (const [rel, why] of ALLOWED) {
    assert.doesNotThrow(() => statSync(join(web, rel)), `${rel} is allowed (${why}) but is gone`);
  }
});
