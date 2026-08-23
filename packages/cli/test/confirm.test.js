const { test } = require("node:test");
const assert = require("node:assert/strict");
const { deletionRefusal } = require("../lib/confirm");

test("deleting without saying yes is refused, and the refusal is the command to run", () => {
  // The CLI has no prompts by design — "designed for agents, not humans" — so
  // the refusal has to carry the whole answer. A message that says "confirm
  // first" without saying HOW is a message that gets guessed at.
  const out = deletionRefusal("myapp", {});
  assert.ok(out);
  assert.match(out, /bay delete myapp --yes/);
});

test("the refusal says the data goes too, because that is the part people get wrong", () => {
  // `deleteApp` drops the database (`dropAppDatabase`) and removes the bucket
  // (`storage rm -r gs://supersonicdeploy-<slug>`) along with images, static
  // releases and the build cache. This message said the opposite for a day —
  // "its database and its storage bucket are KEPT" — which is the most dangerous
  // direction for it to be wrong in: it invites someone to delete an app they
  // still want the data from.
  const out = deletionRefusal("myapp", {});
  assert.match(out, /so would its DATA/);
  assert.match(out, /database, the storage/);
});

test("`--yes` proceeds", () => {
  assert.equal(deletionRefusal("myapp", { yes: true }), null);
});

test("`--yes myapp` proceeds too, because the parser turns it into a value", () => {
  // `--yes` followed by anything that is not another flag consumes it. Someone
  // who wrote the name twice meant it at least as much as someone who wrote it
  // once, and refusing them would be the CLI's own parser leaking out.
  assert.equal(deletionRefusal("myapp", { yes: "myapp" }), null);
});

test("confirming a DIFFERENT app is refused, not ignored", () => {
  // The case this branch exists for: editing a previous command and changing
  // one of the two names. Ignoring the mismatch would delete `api` on the
  // strength of a confirmation that says `web` — and the flag would have been
  // worse than no flag, because it would look like a safety.
  const out = deletionRefusal("api", { yes: "web" });
  assert.ok(out);
  assert.match(out, /you named api but confirmed web/);
});
