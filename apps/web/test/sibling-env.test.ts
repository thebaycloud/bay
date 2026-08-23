import { test } from "node:test";
import assert from "node:assert/strict";
import { siblingEnv } from "../lib/sibling-env";

const names = (pairs: string[]) => pairs.map((p) => p.slice(0, p.indexOf("=")));
const valueOf = (pairs: string[], key: string) =>
  pairs.filter((p) => p.startsWith(`${key}=`)).map((p) => p.slice(key.length + 1));

/**
 * Three subtractions, one test each.
 *
 * Every one of them fails QUIETLY when it stops working — no throw, no failed
 * build, just a service running with somebody else's idea of where it is.
 */

test("the app's shared environment is inherited, because it is the same app", () => {
  const got = siblingEnv({
    inherited: ["DATABASE_URL=postgres://x", "STORAGE_BUCKET=b", "STRIPE_KEY=sk"],
    own: [], deployment: {}, primaryDeclared: [],
  });
  assert.deepEqual(got, ["DATABASE_URL=postgres://x", "STORAGE_BUCKET=b", "STRIPE_KEY=sk"]);
});

test("the primary's code pointers do not travel", () => {
  // They name the primary's bundle and the primary's start command. A sibling
  // has its own image and its own command; being handed these means being told
  // to fetch and run somebody else's code.
  const got = siblingEnv({
    inherited: ["SUPERSONIC_CODE_OBJECT=gs://x", "SUPERSONIC_CODE_KEY=abc", "SUPERSONIC_RUN=node a.js", "PORT=8080"],
    own: [], deployment: {}, primaryDeclared: [],
  });
  assert.deepEqual(got, ["PORT=8080"]);
});

test("a stale path prefix is removed and restated from this service's own facts", () => {
  // The sharpest of the three. A missing prefix makes an app build root-relative
  // URLs, which is visibly wrong at once. A WRONG prefix is trusted: the app
  // builds every link for a path it is not mounted at, and each one 404s in a
  // way that reads as its own bug.
  const got = siblingEnv({
    inherited: ["SUPERSONIC_PATH_PREFIX=/", "FORCE_SCRIPT_NAME=/"],
    own: [],
    deployment: { SUPERSONIC_PATH_PREFIX: "/api", FORCE_SCRIPT_NAME: "/api" },
    primaryDeclared: [],
  });
  assert.deepEqual(valueOf(got, "SUPERSONIC_PATH_PREFIX"), ["/api"], "exactly one value, and it is this service's");
  assert.deepEqual(valueOf(got, "FORCE_SCRIPT_NAME"), ["/api"]);
});

test("the primary's declared literals stay with the primary", () => {
  // `env` is per SERVICE in the schema. The frontend's NODE_ENV has no business
  // on the API, and inheriting it silently is how an API ends up in a mode
  // nobody chose for it.
  const got = siblingEnv({
    inherited: ["NODE_ENV=production", "LOG_LEVEL=debug", "DATABASE_URL=x"],
    own: [],
    deployment: {},
    primaryDeclared: ["NODE_ENV=production", "LOG_LEVEL=debug"],
  });
  assert.deepEqual(got, ["DATABASE_URL=x"]);
});

test("a service's own env wins over what it inherited under the same name", () => {
  // Later pairs win in the `--update-env-vars` shape the pipeline passes these
  // in, so the order is the behaviour and not an accident of construction.
  const got = siblingEnv({
    inherited: ["LOG_LEVEL=info"],
    own: ["LOG_LEVEL=debug"],
    deployment: {},
    primaryDeclared: [],
  });
  assert.equal(got[got.length - 1], "LOG_LEVEL=debug", "the service's own value must be last");
});

test("a pair with no '=' is not silently treated as a name", () => {
  // Defensive, and cheap: name extraction that returns the whole string for a
  // malformed pair would make one bad entry filter out everything.
  const got = siblingEnv({
    inherited: ["MALFORMED", "KEEP=1"],
    own: [], deployment: {}, primaryDeclared: ["MALFORMED"],
  });
  assert.deepEqual(names(got.filter((p) => p.includes("="))), ["KEEP"]);
});

test("a code pointer is stripped under either spelling", () => {
  // CODE_KEY decrypts the primary's source bundle. Matching only the old prefix
  // while the platform emits BAY_CODE_KEY would hand a sibling the key to
  // another service's code — the isolation this filter exists to keep.
  const got = siblingEnv({
    inherited: [
      "BAY_CODE_KEY=secret-new", "SUPERSONIC_CODE_KEY=secret-old",
      "BAY_CODE_OBJECT=gs://new", "SUPERSONIC_CODE_OBJECT=gs://old",
      "BAY_RUN=cmd-new", "SUPERSONIC_RUN=cmd-old",
      "DATABASE_URL=keep-me",
    ],
    own: [], deployment: {}, primaryDeclared: [],
  });
  const joined = got.join("\n");
  for (const leak of ["secret-new", "secret-old", "cmd-new", "cmd-old", "gs://new", "gs://old"]) {
    assert.ok(!joined.includes(leak), `leaked ${leak}: ${joined}`);
  }
  assert.deepEqual(got, ["DATABASE_URL=keep-me"], "an app's own variable must survive");
});
