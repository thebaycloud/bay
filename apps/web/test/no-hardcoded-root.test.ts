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

/**
 * The build cannot bake the old name in either.
 *
 * This test scanned `lib`, `app` and `components` and would have gone on passing
 * forever while production said "Supersonic" in its own header — because the
 * value that won was not in any of them. `NEXT_PUBLIC_*` is inlined into the
 * client bundle when `next build` runs, so the Dockerfile's ARG and cloudbuild's
 * substitution are the values a browser actually gets, and `NEXT_PUBLIC_` is
 * checked FIRST by design. A runtime `PRODUCT_NAME=Bay` on the service reached
 * every server-rendered link while the header above it did not, and the more
 * correct the fallback chain became, the more thoroughly the stale build arg won.
 *
 * Found by reading the shipped bundle, which contained
 * `(e="Supersonic","Supersonic").trim()||"Bay"` — the default was right and
 * unreachable. A test over source files could not have caught it, so this one is
 * over the build.
 */
test("the build does not bake the retiring name into the client bundle", () => {
  const repo = join(__dirname, "..", "..", "..");
  const checks: [string, RegExp][] = [
    ["Dockerfile", /ARG NEXT_PUBLIC_PRODUCT_NAME=(\S+)/],
    ["Dockerfile", /ARG NEXT_PUBLIC_ROOT_DOMAINS=(\S+)/],
    ["cloudbuild.yaml", /_PRODUCT_NAME:\s*(\S+)/],
    ["cloudbuild.yaml", /_ROOT_DOMAINS:\s*(\S+)/],
  ];
  for (const [file, re] of checks) {
    const text = readFileSync(join(repo, file), "utf8");
    const value = re.exec(text)?.[1];
    assert.ok(value, `${file}: ${re} matched nothing — the build arg was renamed or removed`);
    assert.doesNotMatch(
      value!,
      /Supersonic|^supersonic\.cv$/,
      `${file} bakes ${value} into the client bundle, where it beats any runtime value`,
    );
  }
});

test("the canonical root is FIRST in what the build bakes", () => {
  // Order is meaning: `rootDomain()` returns the first, and it is the name new
  // addresses are minted under. Baking them the other way round would put every
  // hosted app back on the retiring domain, silently, in the browser only.
  const repo = join(__dirname, "..", "..", "..");
  for (const [file, re] of [
    ["Dockerfile", /ARG NEXT_PUBLIC_ROOT_DOMAINS=(\S+)/],
    ["cloudbuild.yaml", /_ROOT_DOMAINS:\s*(\S+)/],
  ] as [string, RegExp][]) {
    const value = re.exec(readFileSync(join(repo, file), "utf8"))![1];
    assert.equal(value.split(",")[0], "thebay.cloud", `${file} does not put the canonical root first`);
  }
});

/**
 * The old name cannot be a STRING LITERAL either.
 *
 * The two tests above cover the seam (`productName()`) and the build args that
 * feed it, and both passed while a Pro plan card offered to "Remove the
 * Supersonic badge" — a hand-typed literal in a features array, sitting a few
 * lines from the price. The badge it described had said "Runs on Bay" since
 * PRODUCT_NAME was set on the edge, so the sentence selling the feature named a
 * product that no longer exists, on the one screen where somebody is deciding
 * whether to pay us.
 *
 * A seam is only worth having if nothing goes around it. This scans for the name
 * inside quotes and backticks, which is where a user-visible one lives; the name
 * in a comment is prose about our own history and is left alone (this block is
 * full of it).
 */
test("no user-visible string literal says the retiring product name", () => {
  const dirs = ["app", "components", "lib"];
  /**
   * `app/design` and `app/landing` are in-repo MOCKS of the marketing site, kept
   * in the control plane as a design scratchpad, and `components/landing` is what
   * they render. The shipped landing page is `apps/landing`, which has its own
   * brand module and its own owner; duplicating the rename into a mock of it
   * would be churn with no reader. Everything else in these trees is a real
   * screen and is held to the seam.
   */
  const MOCKS = /^(app\/design|app\/landing|components\/landing)\//;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      const text = readFileSync(p, "utf8");
      text.split("\n").forEach((line, i) => {
        // Strip line comments before looking, so prose about the rename is fine.
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        // The name inside a quote or a backtick, which is how it reaches a screen.
        if (/["'`][^"'`]*Supersonic/.test(code)) {
          const rel = relative(join(__dirname, ".."), p);
          if (!MOCKS.test(rel)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  };
  for (const d of dirs) walk(join(__dirname, "..", d));
  assert.deepEqual(
    offenders,
    [],
    `these are read by users and name the retiring product — use productName():\n${offenders.join("\n")}`,
  );
});
