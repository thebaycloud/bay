import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The retiring domain, typed out, must not come back.
 *
 * This exists because the cutover happened twice and stuck neither time. The
 * configuration was changed — `ROOT_DOMAINS=thebay.cloud,supersonic.cv` in
 * production, read by `lib/roots.ts` — and then SEVENTY-FOUR places in shipping
 * code kept the old name as a string literal, which no environment variable can
 * reach. Among them:
 *
 *   deploy-pipeline.ts  `hostname: ${slug}.supersonic.cv` — baked into every
 *                       app's BAY_URL, ALLOWED_HOSTS and CSRF_TRUSTED_ORIGINS,
 *                       so every app we deployed was TOLD it lived on the
 *                       domain we were leaving.
 *   apps.ts             the URL on every row of the app list.
 *   github-deploy.ts    the commit-status link, on every push, in public.
 *   email.ts            the invitation, which also still said "Supersonic".
 *
 * A grep is not a test. Somebody adds one more literal, it works — both roots
 * answer — and nothing says otherwise until a rename is announced and turns out
 * to be half done. So the rule is enforced instead: read it from `lib/roots.ts`,
 * or add the file here and say why.
 *
 * This is the same failure mode as the protected-name list in `env-owner.ts`,
 * which knew `SUPERSONIC_` and never learned `BAY_`, and as
 * `config.rootDomain` in the edge, which the refactor left pointing at a field
 * that does not exist — `https://undefined` on every hosted app's badge. Neither
 * had a test either.
 */

/** Files that may name the old root, each for a reason that is not laziness. */
const ALLOWED = new Map<string, string>([
  // The definition itself, and the accepted-root list it feeds.
  ["lib/roots.ts", "declares LEGACY_ROOT"],
  // A JWT `aud` claim: an opaque identifier, not an address. Every node in the
  // fleet validates against this exact string, so changing it invalidates every
  // node token at once — a rename that takes the fleet down.
  ["lib/node-identity.ts", "NODE_AUDIENCE is a JWT audience, not a URL"],
  // A real mailbox. Pointing Team-plan enquiries at an address that may not
  // receive is worse than an old-looking one.
  ["components/Paywall.tsx", "founders@ is a live mailbox"],
  ["app/api/billing/checkout/route.ts", "founders@ is a live mailbox"],
]);

const ROOTS = ["lib", "app", "components"];
const EXT = /\.(ts|tsx|js|jsx)$/;
const OLD = "supersonic.cv";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

/** A line that only TALKS about the old root is fine; one that uses it is not. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

test("no shipping file hardcodes the retiring root", () => {
  const web = join(__dirname, "..");
  const offenders: string[] = [];

  for (const root of ROOTS) {
    for (const file of walk(join(web, root))) {
      const rel = relative(web, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;
      // Tests may name it: several assert the behaviour of the old root itself.
      if (/\.test\.(ts|tsx)$/.test(rel)) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (line.includes(OLD) && !isComment(line)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Read the root from lib/roots.ts — appHost/appUrl/controlPlaneUrl in lib/brand.ts — ` +
      `or add the file to ALLOWED in this test with the reason.\n\n${offenders.join("\n")}`,
  );
});

test("every file allowed to name the old root still exists", () => {
  // An allow-list that outlives its files stops being a record of decisions and
  // starts being a hole. `components/Sidebar.tsx` was on a list like this once,
  // as dead code nobody deleted.
  const web = join(__dirname, "..");
  for (const [rel, why] of ALLOWED) {
    assert.doesNotThrow(() => statSync(join(web, rel)), `${rel} is allowed (${why}) but is gone`);
  }
});
