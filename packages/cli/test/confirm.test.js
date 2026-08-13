const { test } = require("node:test");
const assert = require("node:assert/strict");
const { deletionRefusal } = require("../lib/confirm");

test("deleting without saying yes is refused, and the refusal is the command to run", () => {
  // The CLI has no prompts by design — "designed for agents, not humans" — so
  // the refusal has to carry the whole answer. A message that says "confirm
  // first" without saying HOW is a message that gets guessed at.
  const out = deletionRefusal("myapp", {});
  assert.ok(out);
  assert.match(out, /supersonic delete myapp --yes/);
});

test("the refusal says what survives, because that is the part people get wrong", () => {
  // Delete tears down the app record, its deploy history and its placement. It
  // does NOT drop the database or the bucket. Someone deleting an app to free
  // its data would be misled by silence here, and someone deleting an app they
  // want the data from would be terrified by it.
  const out = deletionRefusal("myapp", {});
  assert.match(out, /database and its storage bucket are KEPT/);
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
