const { test } = require("node:test");
const assert = require("node:assert/strict");
const { joinExecArgs, shellQuote } = require("../lib/exec-args");

// The server base64s this string and pipes it to `sh`. Every case below is
// something a person actually types.

test("an argv command keeps the quoting the local shell removed", () => {
  // The bug, verbatim. Typed as:
  //   supersonic exec app -- python -c 'import os; print(os.environ["X"])'
  // the local shell hands us three words with the quotes already gone, and a
  // plain join sent `print(os.environ[...])` to sh, which answered
  // `Syntax error: "(" unexpected`.
  const words = ["python", "-c", 'import os; print(os.environ["X"])'];
  assert.equal(joinExecArgs(words), `python -c 'import os; print(os.environ["X"])'`);
});

test("a single argument is left exactly as written", () => {
  // Someone who quotes the whole thing means the shell operators in it. Quoting
  // this would run a command literally named "ls | wc -l".
  assert.equal(joinExecArgs(["ls | wc -l"]), "ls | wc -l");
});

test("ordinary words are not dressed up", () => {
  // `node -v` must stay `node -v`; needless quoting makes every log and every
  // error message harder to read for no gain.
  assert.equal(joinExecArgs(["node", "-v"]), "node -v");
  assert.equal(joinExecArgs(["ls", "-la", "/srv/apps"]), "ls -la /srv/apps");
});

test("a single quote inside a word survives", () => {
  // The case that breaks naive quoting: you cannot escape ' inside '…', so it
  // has to close, escape, and reopen.
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(joinExecArgs(["echo", "it's"]), `echo 'it'\\''s'`);
});

test("a word that would otherwise be split by the remote shell is kept whole", () => {
  assert.equal(joinExecArgs(["echo", "two words"]), `echo 'two words'`);
});

test("a word the remote shell would expand is not expanded", () => {
  // $HOME, backticks and ; are the remote shell's, not the caller's, once the
  // caller has already split them into their own argument.
  assert.equal(joinExecArgs(["echo", "$HOME"]), `echo '$HOME'`);
  assert.equal(joinExecArgs(["echo", "a;rm -rf /"]), `echo 'a;rm -rf /'`);
});

test("nothing at all is an empty command, not a crash", () => {
  assert.equal(joinExecArgs([]), "");
  assert.equal(joinExecArgs(undefined), "");
});
