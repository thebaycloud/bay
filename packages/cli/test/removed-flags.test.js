const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "index.js");

function deployWith(...flags) {
  try {
    const out = execFileSync(process.execPath, [CLI, "deploy", ...flags], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out: String(out ?? "") };
  } catch (e) {
    return { code: e.status, out: String(e.stderr ?? "") + String(e.stdout ?? "") };
  }
}

// `parse()` accepts any --flag it is handed, so a removed one is swallowed in
// silence unless something goes looking for it. Silence is the wrong answer to
// "I asked for a thing you no longer do" — the caller would go on believing a
// preview was being served from their machine.
test("a removed preview flag fails loudly instead of being ignored", () => {
  for (const flag of [["--dev-cmd", "npm run dev"], ["--dev-port", "3000"], ["--no-preview"]]) {
    const { code, out } = deployWith(...flag);
    assert.equal(code, 1, `${flag[0]} should exit 1`);
    assert.match(out, /removed in 0\.11\.0/);
    assert.match(out, new RegExp(flag[0].replace(/-/g, "\\-")));
  }
});

test("the failure happens before anything reaches the network", () => {
  // No token, no account, no folder that could deploy — and still the flag error,
  // which is the only way an agent gets a usable message rather than an auth wall.
  const { out } = deployWith("--dev-cmd", "x");
  assert.equal(/sign in|login|unauthor/i.test(out), false);
});

test("a flag ship does not understand stops it, rather than being ignored", () => {
  // Found the hard way: `parse()` takes anything starting with `--`, so a typo
  // was dropped and the deploy went ahead — reserving a slug, uploading a folder
  // and creating an app nobody asked for. An agent reads "deploying — your app
  // will be live at" and reports success for the thing it did not request.
  const { code, out } = deployWith("--drt-run");
  assert.equal(code, 1);
  assert.match(out, /--drt-run is not a flag/);
  assert.match(out, /Nothing was shipped/);
});

test("the flags ship does understand still work", () => {
  // The guard must not become the reason a real flag stops working.
  //
  // Built from the CLI's own name rather than written out. Pinned to a literal
  // this asserted "the command is called supersonic", which is a fact about the
  // brand and not about the flag guard it is testing.
  const { CLI } = require("../lib/brand");
  const { out } = deployWith("--help");
  assert.match(out, new RegExp(`${CLI} ship`));
  assert.equal(/is not a flag/.test(out), false);
});
