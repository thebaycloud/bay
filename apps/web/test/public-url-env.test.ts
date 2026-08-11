import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredEnvNames, publicUrlEnvArgs } from "@/lib/public-url-args";

// THE MOTIVATING CASE, which the module's own header records: the full-stack
// FastAPI template ships `frontend/.env` containing
//
//   VITE_API_URL=http://localhost:8000
//
// Its backend answered 200 on the node while the signup form posted to
// localhost and showed "Something went wrong". The Dockerfile route caught this
// through `ARG VITE_API_URL=`; a Railpack plan declares no ARGs, so on that lane
// the .env file is where the name is still visible — and it was visible all along.
test("an app's own .env is where a bundler's names actually live", () => {
  assert.deepEqual(declaredEnvNames("VITE_API_URL=http://localhost:8000\n"), ["VITE_API_URL"]);
});

test("comments, blanks, quotes and `export` are all ordinary in a .env", () => {
  const env = [
    "# where the api lives",
    "",
    "export VITE_API_URL='http://localhost:8000'",
    'NEXT_PUBLIC_SITE_URL="http://localhost:3000"',
    "  # trailing comment line",
    "MALFORMED",
  ].join("\n");
  assert.deepEqual(declaredEnvNames(env), ["VITE_API_URL", "NEXT_PUBLIC_SITE_URL"]);
});

// The same narrowness the Dockerfile route has, for the same reason: guessing
// wrong writes a URL into somebody's bundle where they wanted something else,
// and they find out in a browser.
test("only names that mean an address, and only public ones", () => {
  const env = "VITE_SENTRY_DSN=x\nDATABASE_URL=y\nVITE_API_URL=z\nSECRET_API_URL=w\n";
  assert.deepEqual(publicUrlEnvArgs([env], "https://app.supersonic.cv"), [
    { key: "VITE_API_URL", value: "https://app.supersonic.cv" },
  ]);
});

// The value in the .env is not merely ignored — it is REPLACED, and that is the
// entire point. A committed .env holds a development default; localhost is what
// it says because localhost is where the author was. Deploying it unchanged is
// the failure this exists to prevent.
test("the development default is overridden, because that is the bug", () => {
  const args = publicUrlEnvArgs(["VITE_API_URL=http://localhost:8000"], "https://x.supersonic.cv");
  assert.deepEqual(args, [{ key: "VITE_API_URL", value: "https://x.supersonic.cv" }]);
});

// But `supersonic.json` still wins, exactly as it does on the Dockerfile route.
// A .env is where the author developed; buildEnv is what they said about
// deploying. Someone pointing their frontend at a different API meant it.
test("what supersonic.json declared is never overwritten", () => {
  const args = publicUrlEnvArgs(["VITE_API_URL=http://localhost:8000"], "https://x.supersonic.cv",
    [{ key: "VITE_API_URL", value: "https://api.example.com" }]);
  assert.deepEqual(args, []);
});

test("several env files are read together, and a name is answered once", () => {
  const args = publicUrlEnvArgs(["VITE_API_URL=a", "VITE_API_URL=b\nVITE_BASE_URL=c"], "https://x.supersonic.cv");
  assert.deepEqual(args.map((a) => a.key), ["VITE_API_URL", "VITE_BASE_URL"]);
});
