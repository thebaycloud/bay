import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeDatabaseEnv } from "../lib/env-merge";

test("a name the platform sets is not also stored as a secret", () => {
  // Cloud Run refuses a variable that is both: "Cannot update environment
  // variable [POSTGRES_DB] to the given type because it has already been set
  // with a different type." That is not a warning — the deploy dies on it, and
  // it is what stopped the FastAPI template's backend from ever being served.
  const merged = mergeDatabaseEnv(
    { POSTGRES_DB: "app", SECRET_KEY: "hunter2" },
    ["POSTGRES_SERVER=127.0.0.1", "POSTGRES_DB=um2b6", "DATABASE_URL=postgresql://…"],
  );

  const plainNames = merged.plainEnv.map((e) => e.split("=")[0]);
  const overlap = plainNames.filter((n) => n in merged.secretEnv);
  assert.deepEqual(overlap, []);
});

test("the platform's database settings win over the ones the app shipped", () => {
  // A repo's .env describes the database on its author's laptop. Deployed, the
  // app must talk to the one the platform just provisioned — keeping the
  // author's value points a live app at a database that does not exist.
  const merged = mergeDatabaseEnv({ POSTGRES_DB: "app" }, ["POSTGRES_DB=um2b6"]);

  assert.ok(merged.plainEnv.includes("POSTGRES_DB=um2b6"));
  assert.equal("POSTGRES_DB" in merged.secretEnv, false);
});

test("a password stays a secret, and the platform's is the one kept", () => {
  const merged = mergeDatabaseEnv({ POSTGRES_PASSWORD: "changethis" }, ["POSTGRES_PASSWORD=real-one"]);

  assert.equal(merged.secretEnv.POSTGRES_PASSWORD, "real-one");
  assert.equal(merged.plainEnv.some((e) => e.startsWith("POSTGRES_PASSWORD=")), false);
});

test("DATABASE_URL is a credential, never a plain variable", () => {
  const merged = mergeDatabaseEnv({}, ["DATABASE_URL=postgresql://u:p@h/db", "POSTGRES_PORT=5432"]);

  assert.equal(merged.secretEnv.DATABASE_URL, "postgresql://u:p@h/db");
  assert.deepEqual(merged.plainEnv, ["POSTGRES_PORT=5432"]);
});

test("an app variable the platform says nothing about is untouched", () => {
  const merged = mergeDatabaseEnv({ SECRET_KEY: "hunter2", SMTP_PORT: "587" }, ["POSTGRES_DB=um2b6"]);

  assert.equal(merged.secretEnv.SECRET_KEY, "hunter2");
  assert.equal(merged.secretEnv.SMTP_PORT, "587");
});
