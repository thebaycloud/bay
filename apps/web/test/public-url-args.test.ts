import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredArgs, isPublicUrlArg, publicUrlBuildArgs } from "../lib/public-url-args";

/**
 * A browser bundle is not configured at runtime. Vite, Next and CRA read their
 * env at BUILD time and write the literal into the JavaScript they ship, so
 * whatever the API URL was when the image was built is what the user's browser
 * calls forever.
 *
 * The full-stack FastAPI template ships `VITE_API_URL=http://localhost:8000` and
 * declares `ARG VITE_API_URL=` for exactly this. Nobody passed it: the backend
 * answered 200 on the node and the signup form posted to localhost.
 */

const FASTAPI = `
FROM oven/bun:1 AS build-frontend
ARG VITE_API_URL=
COPY ./frontend /app/frontend
RUN bun run build
FROM python:3.14
CMD ["fastapi", "run"]
`;

test("the template's own hook is found and filled", () => {
  const args = publicUrlBuildArgs(FASTAPI, "https://lgk2b.supersonic.cv");
  assert.deepEqual(args, [{ key: "VITE_API_URL", value: "https://lgk2b.supersonic.cv" }]);
});

test("nothing is passed that the image did not declare", () => {
  // A build arg no ARG declares is a warning from docker, an error from some
  // builders, and noise in image history from all of them.
  assert.deepEqual(publicUrlBuildArgs("FROM node:22\nCMD [\"node\"]", "https://x.supersonic.cv"), []);
});

test("declaredArgs reads every legal spelling", () => {
  const names = declaredArgs(`
ARG ONE
ARG TWO=default
ARG THREE=a  FOUR=b
arg five
ARG ONE
`);
  assert.deepEqual(names, ["ONE", "TWO", "THREE", "FOUR", "five"]);
});

test("a name has to mean an address", () => {
  for (const yes of [
    "VITE_API_URL", "VITE_APP_API_URL", "NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_SITE_URL",
    "REACT_APP_BACKEND_URL", "PUBLIC_API_URL", "NUXT_PUBLIC_BASE_URL", "VITE_APP_ORIGIN",
  ]) {
    assert.equal(isPublicUrlArg(yes), true, `${yes} should be an address`);
  }
  for (const no of [
    // Public, but not an address. Writing a URL into any of these would be found
    // in a browser, by the author, later.
    "VITE_SENTRY_DSN", "NEXT_PUBLIC_ANALYTICS_ID", "REACT_APP_API_KEY", "VITE_APP_TITLE",
    // An address, but not public — no prefix means the tool never exposes it to
    // the client, so the author did not mean it for the browser.
    "API_URL", "DATABASE_URL", "BACKEND_URL", "URL",
  ]) {
    assert.equal(isPublicUrlArg(no), false, `${no} should not be`);
  }
});

test("a value the author set wins", () => {
  // Somebody pointing their frontend at a different API meant it, and the
  // platform's guess must not overwrite a declaration.
  const args = publicUrlBuildArgs(FASTAPI, "https://lgk2b.supersonic.cv", [
    { key: "VITE_API_URL", value: "https://api.theirdomain.com" },
  ]);
  assert.deepEqual(args, []);
});

test("no url means nothing is passed", () => {
  // A deploy that does not know the app's address yet must not write an empty
  // string into the bundle: `?? \"\"` in the app's own code is a WORKING relative
  // base, and an empty literal would replace it with the same thing by accident
  // — which is fine — but an empty ARG on a builder that treats it as set is not.
  assert.deepEqual(publicUrlBuildArgs(FASTAPI, ""), []);
});

test("several declared addresses all get told", () => {
  const df = `
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_ANALYTICS_ID
`;
  const args = publicUrlBuildArgs(df, "https://app.supersonic.cv");
  assert.deepEqual(args.map((a) => a.key), ["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_SITE_URL"]);
});
