import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectRelease, releaseFromCompose, releaseFromFlyToml,
  releaseFromRenderYaml, releaseFromJsonManifest, releaseFromPackageJson,
} from "../lib/release-detect";

/**
 * An app whose migrations never ran serves its homepage and 500s everything
 * else. The full-stack FastAPI template did exactly that here — every form
 * answered `relation "user" does not exist` while the deploy was reported live —
 * because its migrations are declared in compose, a spelling the pipeline did
 * not read.
 */

// The template's compose, trimmed to the shape that matters.
const FASTAPI_COMPOSE = `
services:
  db:
    image: postgres:17
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
  prestart:
    image: '\${DOCKER_IMAGE_BACKEND?Variable not set}:\${TAG-latest}'
    build:
      context: .
      dockerfile: backend/Dockerfile
    depends_on:
      db:
        condition: service_healthy
        restart: true
    command: bash scripts/prestart.sh
  backend:
    build:
      context: .
      dockerfile: backend/Dockerfile
    depends_on:
      db:
        condition: service_healthy
      prestart:
        condition: service_completed_successfully
`;

test("compose: the service others wait to FINISH is the release", () => {
  const r = releaseFromCompose(FASTAPI_COMPOSE);
  assert.equal(r?.command, "bash scripts/prestart.sh");
  assert.match(r?.from ?? "", /prestart/);
});

test("compose: a dependency merely waited on to be HEALTHY is not a release", () => {
  // `db` is waited for with service_healthy and runs forever. Reading that as a
  // release would run postgres as this app's migration step.
  const r = releaseFromCompose(`
services:
  db:
    image: postgres:17
    command: postgres -c fsync=off
  api:
    build: .
    depends_on:
      db:
        condition: service_healthy
`);
  assert.equal(r, null);
});

test("compose: a pulled image is never our release, even if awaited", () => {
  // Someone else's container with someone else's entrypoint. Running it as this
  // app's release is the mistake the build check exists to prevent.
  const r = releaseFromCompose(`
services:
  seed:
    image: someone/seeder:1
    command: /seed.sh
  api:
    build: .
    depends_on:
      seed:
        condition: service_completed_successfully
`);
  assert.equal(r, null);
});

test("compose: no command means nothing to run", () => {
  const r = releaseFromCompose(`
services:
  prestart:
    build: .
  api:
    build: .
    depends_on:
      prestart:
        condition: service_completed_successfully
`);
  assert.equal(r, null);
});

test("compose: a file with no services is not understood, and says so by saying nothing", () => {
  assert.equal(releaseFromCompose("version: '3'\n"), null);
  assert.equal(releaseFromCompose("just: text\n"), null);
  assert.equal(releaseFromCompose(""), null);
});

test("fly.toml: release_command, only under [deploy]", () => {
  assert.equal(
    releaseFromFlyToml('[deploy]\n  release_command = "npx prisma migrate deploy"\n')?.command,
    "npx prisma migrate deploy",
  );
  // The same key under another section is a different setting.
  assert.equal(releaseFromFlyToml('[build]\n  release_command = "nope"\n'), null);
});

test("render.yaml: preDeployCommand", () => {
  assert.equal(
    releaseFromRenderYaml("services:\n  - type: web\n    preDeployCommand: ./migrate.sh\n")?.command,
    "./migrate.sh",
  );
  assert.equal(releaseFromRenderYaml("services:\n  - type: web\n"), null);
});

test("json manifests: railway and heroku spellings", () => {
  assert.equal(
    releaseFromJsonManifest('{"deploy":{"preDeployCommand":"rails db:migrate"}}', "railway.json")?.command,
    "rails db:migrate",
  );
  assert.equal(
    releaseFromJsonManifest('{"scripts":{"postdeploy":"bundle exec rake db:migrate"}}', "app.json")?.command,
    "bundle exec rake db:migrate",
  );
  assert.equal(releaseFromJsonManifest("not json", "app.json"), null);
  assert.equal(releaseFromJsonManifest("{}", "app.json"), null);
});

test("package.json: prestart and release, and nothing else", () => {
  assert.equal(releaseFromPackageJson('{"scripts":{"prestart":"node migrate.js"}}')?.command, "npm run prestart");
  assert.equal(releaseFromPackageJson('{"scripts":{"release":"npm run db:deploy"}}')?.command, "npm run release");
  // `migrate` is a thing a PERSON runs. Promoting it to a blocking deploy step
  // would fail repositories that have always worked.
  assert.equal(releaseFromPackageJson('{"scripts":{"migrate":"knex migrate:latest"}}'), null);
  assert.equal(releaseFromPackageJson('{"scripts":{"db:migrate":"x"}}'), null);
});

test("order is authority: a platform manifest beats compose", () => {
  // compose describes a local dev stack; fly.toml describes a deploy. When both
  // are present the one written about deploying wins.
  const r = detectRelease({
    "fly.toml": '[deploy]\nrelease_command = "alembic upgrade head"\n',
    "compose.yml": FASTAPI_COMPOSE,
  });
  assert.equal(r?.command, "alembic upgrade head");
  assert.equal(r?.from, "fly.toml");
});

test("compose beats package.json prestart", () => {
  const r = detectRelease({
    "compose.yml": FASTAPI_COMPOSE,
    "package.json": '{"scripts":{"prestart":"echo hi"}}',
  });
  assert.match(r?.from ?? "", /compose/);
});

test("a repository that declares nothing gets nothing", () => {
  assert.equal(detectRelease({}), null);
  assert.equal(detectRelease({ "package.json": '{"scripts":{"start":"node ."}}' }), null);
});
