import { test } from "node:test";
import assert from "node:assert/strict";
import { resilientInstall } from "../lib/install";

test("npm ci falls back to npm install, keeping its flags", () => {
  // npm ci refuses to run when package.json and package-lock.json disagree, and
  // they disagree constantly in the projects we host. Measured on a real
  // repository: build failed at 37s, repair agent worked out `npm install`, and
  // the deploy finished at 119s instead of about 50s.
  assert.equal(
    resilientInstall("npm ci --prefer-offline --no-audit --no-fund"),
    "npm ci --prefer-offline --no-audit --no-fund || npm install --prefer-offline --no-audit --no-fund",
  );
});

test("a bare npm ci gets a bare fallback", () => {
  assert.equal(resilientInstall("npm ci"), "npm ci || npm install");
});

test("yarn and pnpm are left exactly as they are", () => {
  // Their frozen-lockfile modes fail loudly for reasons worth surfacing, and
  // neither has npm's habit of drifting out of sync.
  assert.equal(resilientInstall("yarn --frozen-lockfile"), "yarn --frozen-lockfile");
  assert.equal(resilientInstall("pnpm i --frozen-lockfile"), "pnpm i --frozen-lockfile");
  assert.equal(resilientInstall("bun install"), "bun install");
});

test("npm install needs no fallback", () => {
  assert.equal(resilientInstall("npm install"), "npm install");
  assert.equal(resilientInstall("npm install --no-audit"), "npm install --no-audit");
});

test("nothing to install stays nothing", () => {
  assert.equal(resilientInstall(null), null);
});

test("a command merely starting with the letters of npm ci is untouched", () => {
  // Guard against matching "npm cimode" or similar with a loose prefix test.
  assert.equal(resilientInstall("npm cimport"), "npm cimport");
});
