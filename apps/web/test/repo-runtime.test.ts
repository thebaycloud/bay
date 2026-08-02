import { test } from "node:test";
import assert from "node:assert/strict";
import { repoRuntime, runnerServes, runtimeRouting } from "../lib/repo-runtime";
import { RUNTIME_VERSIONS } from "../lib/plan-deps";

const serves = (spec: string, language: "python" | "node" = "python") =>
  runnerServes({ language, spec, from: "test" });

test("the runtime comes from the repo's own file, and is carried verbatim", () => {
  // The platform never picks a version, never stores one, and never rewrites one.
  // It reads what the repo said so it can ask one yes/no question, and the string
  // it passes on is the string the author wrote — a normalisation here would be
  // the platform having an opinion about versions again, one lossy step later.
  assert.deepEqual(repoRuntime({ pythonVersion: "3.12\n" }), { language: "python", spec: "3.12", from: ".python-version" });
  assert.deepEqual(repoRuntime({ runtimeTxt: "python-3.11.9" }), { language: "python", spec: "3.11.9", from: "runtime.txt" });
  assert.deepEqual(repoRuntime({ nvmrc: "v20.11.0" }), { language: "node", spec: "20.11.0", from: ".nvmrc" });
  assert.deepEqual(repoRuntime({ pyproject: 'requires-python = ">=3.10"' }), { language: "python", spec: ">=3.10", from: "pyproject.toml" });
  assert.deepEqual(repoRuntime({ packageJson: { engines: { node: ">=20" } } }), { language: "node", spec: ">=20", from: "package.json" });

  assert.equal(repoRuntime({}), null);
  assert.equal(repoRuntime({ pyproject: "[project]\nname = 'x'" }), null);
});

test("a file whose only job is pinning the runtime outranks a compatibility range", () => {
  // Someone who wrote `.python-version` meant that number. `requires-python` is
  // usually a compatibility range and often far wider than what they actually run.
  const both = repoRuntime({ pythonVersion: "3.12", pyproject: 'requires-python = ">=3.8"' });
  assert.equal(both!.from, ".python-version");
  assert.equal(both!.spec, "3.12");
});

test("an exact pin is served only when it IS the version the runner has", () => {
  assert.equal(RUNTIME_VERSIONS.python, "3.14", "this test is written against the pinned runner");

  assert.equal(serves("3.14"), true);
  assert.equal(serves("3.12"), false);   // tonight's bot
  assert.equal(serves("3.11.9"), false);
  assert.equal(serves("3.14.1"), true);  // patch is below the runner's granularity
  assert.equal(serves("24", "node"), true);
  assert.equal(serves("20", "node"), false);
});

test("an UPPER bound is honoured — the case the old check could not see", () => {
  // `runtimeMismatch` only ever read a lower bound, so "not the newest one" —
  // which is how a real app says it depends on a library that has not caught up —
  // sailed through, installed, and died at start inside the customer's own code.
  // That is exactly what happened to python-telegram-bot on 3.14 tonight.
  assert.equal(serves("<3.13"), false);
  assert.equal(serves("<=3.12"), false);
  assert.equal(serves(">=3.10,<3.13"), false);

  // And a range the runner genuinely satisfies still takes the fast path.
  assert.equal(serves(">=3.10"), true);
  assert.equal(serves(">=3.10,<4.0"), true);
  assert.equal(serves(">=18", "node"), true);
});

test("a caret or tilde pin means that minor, so the runner only serves its own", () => {
  assert.equal(serves("~=3.14"), true);
  assert.equal(serves("~=3.11"), false);
  assert.equal(serves("^3.14"), true);
  assert.equal(serves("^20", "node"), false);
});

test("anything unrecognised is a NO, and that direction is the whole design", () => {
  // Being wrong toward the builder costs a slower build. Being wrong toward the
  // runner puts an app on an interpreter its author did not choose, which is a
  // traceback in the customer's own code with nothing in our logs to explain it.
  // No attempt is made to be a full PEP 440 implementation — the builder has a
  // real one, and is the right place for it.
  for (const weird of ["*", "latest", "pypy3.10", ">=3.10 || <4", "3.x", "", "  ", "lts/hydrogen"]) {
    assert.equal(serves(weird), false, `"${weird}" was optimistically served`);
  }
});

test("the log line says what was asked, where, and what happens next", () => {
  // The visible consequence is a build that takes minutes instead of seconds. An
  // owner who is not told why reads that as the platform being slow.
  const msg = runtimeRouting({ language: "python", spec: "3.12", from: ".python-version" });

  assert.match(msg, /\.python-version/);
  assert.match(msg, /python 3\.12/);
  assert.match(msg, new RegExp(RUNTIME_VERSIONS.python.replace(".", "\\.")));
  assert.match(msg, /building this one from source/);
});
