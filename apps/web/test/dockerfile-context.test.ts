import { test } from "node:test";
import assert from "node:assert/strict";
import { copySources, wantsRepoRootContext, buildOwner } from "../lib/dockerfile-context";

/**
 * The full-stack FastAPI template, trimmed to the lines that matter. Its
 * backend/Dockerfile builds the FRONTEND and copies it into the API image, and
 * its own compose file states `context: .` with `dockerfile: backend/Dockerfile`.
 *
 * Deployed as two services from two directories, the backend image had no
 * frontend in it and the app died on import — after a build that passed.
 */
const FASTAPI_BACKEND = `
FROM oven/bun:1 AS build-frontend
WORKDIR /app
COPY package.json bun.lock /app/
COPY frontend/package.json /app/frontend/
RUN bun install
COPY ./frontend /app/frontend
RUN bun run build

FROM python:3.14
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /uvx /bin/
WORKDIR /app/
COPY --from=build-frontend /app/frontend/dist /app/app/frontend
COPY ./backend/scripts /app/backend/scripts
CMD ["fastapi", "run", "--workers", "4"]
`;

/** A Dockerfile that only ever reads its own directory. */
const SELF_CONTAINED = `
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["node", "server.js"]
`;

test("copySources reads context paths and ignores stage copies", () => {
  const paths = copySources(FASTAPI_BACKEND).map((c) => c.path);

  assert.ok(paths.includes("frontend/package.json"));
  assert.ok(paths.includes("./frontend"));
  assert.ok(paths.includes("./backend/scripts"));
  // `--from=` reads another stage, not the context. Counting those would make
  // nearly every multi-stage build look like it reaches outside its directory.
  assert.ok(!paths.some((p) => p.includes("/uv")));
  assert.ok(!paths.some((p) => p.includes("dist")));
});

test("copySources drops the destination, never a source", () => {
  const paths = copySources("COPY a.txt b.txt /dest/").map((c) => c.path);
  assert.deepEqual(paths, ["a.txt", "b.txt"]);
});

test("copySources handles the JSON form and continuations", () => {
  assert.deepEqual(copySources(`COPY ["src/app", "/opt/app"]`).map((c) => c.path), ["src/app"]);
  assert.deepEqual(
    copySources("COPY one.txt \\\n     two.txt \\\n     /dest/").map((c) => c.path),
    ["one.txt", "two.txt"],
  );
});

test("copySources does not guess at a path built from a variable", () => {
  assert.deepEqual(copySources("ARG SRC\nCOPY ${SRC}/app /app").map((c) => c.path), []);
});

test("the FastAPI backend is recognised as wanting the repository root", () => {
  const wants = wantsRepoRootContext(
    FASTAPI_BACKEND,
    ["Dockerfile", "app", "scripts", "pyproject.toml"],       // backend/
    ["backend", "frontend", "package.json", "bun.lock"],      // repo root
  );
  assert.equal(wants, true);
});

test("a self-contained Dockerfile keeps its own directory", () => {
  const wants = wantsRepoRootContext(
    SELF_CONTAINED,
    ["Dockerfile", "package.json", "package-lock.json", "server.js"],
    ["api", "web", "README.md"],
  );
  assert.equal(wants, false);
});

test("a path that climbs out says so without needing a listing", () => {
  assert.equal(wantsRepoRootContext("COPY ../shared /shared", [], []), true);
});

test("a name present in BOTH places is not evidence", () => {
  // `package.json` beside the Dockerfile and also at the root is the ordinary
  // shape of a monorepo. Reading that as "build me from the root" would move
  // every service's context and break the ones that were right.
  const wants = wantsRepoRootContext(
    "FROM node:22\nCOPY package.json ./\n",
    ["Dockerfile", "package.json"],
    ["package.json", "api", "web"],
  );
  assert.equal(wants, false);
});

test("a wildcard is a shape, not a file, and is not looked up", () => {
  assert.equal(wantsRepoRootContext("COPY *.json ./", ["Dockerfile"], ["package.json"]), false);
});

test("buildOwner names the directory whose Dockerfile assembles the others", () => {
  const owner = buildOwner([
    { dir: "frontend" },
    { dir: "backend", dockerfile: FASTAPI_BACKEND },
  ]);
  assert.equal(owner, "backend");
});

test("buildOwner leaves genuinely separate services alone", () => {
  // Two services that each build only themselves must still be two services —
  // this rule exists to stop a wrong split, not to stop every split.
  const owner = buildOwner([
    { dir: "frontend", dockerfile: SELF_CONTAINED },
    { dir: "backend", dockerfile: SELF_CONTAINED },
  ]);
  assert.equal(owner, null);
});

test("buildOwner ignores a directory that is not a candidate", () => {
  // `COPY ./shared` where `shared` is not one of the services says nothing about
  // whether these are one deployment or two.
  const owner = buildOwner([
    { dir: "frontend" },
    { dir: "backend", dockerfile: "FROM x\nCOPY ./shared /shared\n" },
  ]);
  assert.equal(owner, null);
});
