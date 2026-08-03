import { test } from "node:test";
import assert from "node:assert/strict";
import { aptPackagesIn } from "../lib/build-hints";

/**
 * Reading back what a repair added.
 *
 * The parse is the risky half: whatever comes out of here goes onto a real
 * `apt-get install` command line on the next deploy, so a stray `&&` or a flag
 * is not untidy, it is a build that fails for a new reason nobody asked for.
 */

test("our own generated apt line reads back exactly", () => {
  const df = "RUN apt-get update && apt-get install -y --no-install-recommends default-libmysqlclient-dev pkg-config && rm -rf /var/lib/apt/lists/*";
  assert.deepEqual(aptPackagesIn(df), ["default-libmysqlclient-dev", "pkg-config"]);
});

test("shell operators and flags are never mistaken for packages", () => {
  // `&&` on an apt command line is the failure this guards: it would be passed to
  // apt as a package name next deploy, and the build would fail for a reason the
  // app had nothing to do with.
  const df = "RUN apt-get install -y libpq-dev && echo done && ls";
  assert.deepEqual(aptPackagesIn(df), ["libpq-dev"]);

  assert.deepEqual(aptPackagesIn("RUN apt-get -qq install --no-install-recommends -y curl"), ["curl"]);
});

test("apt-get quoted inside another command is not an install", () => {
  // `apt-get` has to be in command position. Matching it anywhere harvests words
  // out of an echo — and those words would be handed to a real apt-get on the
  // next deploy, failing the build for a reason the app had nothing to do with.
  assert.deepEqual(aptPackagesIn(`RUN echo "apt-get install libfoo" > /tmp/note`), []);
  assert.deepEqual(aptPackagesIn(`RUN grep -q 'apt-get install bar' README || true`), []);
  // …while the real thing after an operator still counts.
  assert.deepEqual(aptPackagesIn("RUN set -e; apt-get install -y libpq-dev"), ["libpq-dev"]);
});

test("a package list wrapped across lines is one list", () => {
  // What a person writes, and therefore what an agent writes.
  const df = [
    "RUN apt-get update \\",
    " && apt-get install -y --no-install-recommends \\",
    "      libcairo2-dev \\",
    "      libpango1.0-dev \\",
    " && rm -rf /var/lib/apt/lists/*",
  ].join("\n");
  assert.deepEqual(aptPackagesIn(df), ["libcairo2-dev", "libpango1.0-dev"]);
});

test("a Dockerfile with no apt layer teaches nothing", () => {
  const df = "FROM python:3.12\nWORKDIR /app\nCOPY . .\nRUN pip install -r requirements.txt\n";
  assert.deepEqual(aptPackagesIn(df), []);
});

test("several apt layers all count", () => {
  // An agent that appends its own RUN rather than editing ours — the likelier
  // shape, since ours has a `rm -rf` tail it would have to preserve.
  const df = [
    "RUN apt-get update && apt-get install -y --no-install-recommends libpq-dev && rm -rf /var/lib/apt/lists/*",
    "RUN apt-get install -y gcc",
  ].join("\n");
  assert.deepEqual(aptPackagesIn(df), ["gcc", "libpq-dev"]);
});
