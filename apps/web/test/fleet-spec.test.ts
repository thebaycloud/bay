import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAppSpec, type AppSpec } from "../lib/fleet-spec";
import { resolveProcess, type ResolvedProcess } from "../lib/processes";
import type { ProcessFault } from "../lib/fleet";

/**
 * The json tags of the agent's `App` struct, read from the agent itself.
 *
 * `lib/fleet.ts` has always claimed its AppSpec was "the agent's App, verbatim".
 * It was not: the agent grew `secrets` and `processes` and the control plane's
 * copy did not, so the placement spec could not express a secret or a worker —
 * which is most of why 9 of 47 apps could not be moved. A comment is not a
 * check. This is the check.
 */
function agentAppFields(): string[] {
  const src = readFileSync(resolve(process.cwd(), "../../services/fleet/agent/main.go"), "utf8");
  const block = src.match(/type App struct \{([\s\S]*?)\n\}/);
  assert.ok(block, "could not find `type App struct` in the agent");
  const tags = [...block[1].matchAll(/json:"([^"]+)"/g)].map((m) => m[1].split(",")[0]);
  // `json:"-"` is a field the agent fills in itself on the node (DataDir,
  // LogPath). The control plane does not send those and must not.
  return tags.filter((t) => t !== "-");
}

const base = {
  slug: "myapp",
  image: "us-central1-docker.pkg.dev/p/r/myapp:latest",
  env: [] as string[],
  secrets: [] as { key: string; name: string }[],
  processes: [] as ResolvedProcess[],
};

test("the placement spec is the agent's App, and this is what keeps it so", () => {
  // Every field populated, so the key set is the whole shape rather than
  // whatever this particular app happened to need.
  const full: Required<AppSpec> = {
    slug: "myapp",
    image: "img",
    command: ["node", "server.js"],
    env: { LOG_LEVEL: "info" },
    secrets: { DATABASE_URL: "app-myapp-DATABASE_URL" },
    port: 8080,
    memoryBytes: 2147483648,
    cpuShares: 1024,
    healthPath: "/",
    processes: [{ name: "web", kind: "web", command: ["npm", "start"], port: 8080 }],
  };

  assert.deepEqual(Object.keys(full).sort(), agentAppFields().sort());
});

test("the pipeline's K=V env becomes the map the agent reads", () => {
  const spec = buildAppSpec({
    ...base,
    // A connection string is the case that matters: split on the first `=` only,
    // or every DATABASE_URL with a query string arrives truncated.
    env: ["LOG_LEVEL=info", "DATABASE_URL=postgres://u:p@h/db?sslmode=require"],
  });

  assert.deepEqual(spec.env, {
    LOG_LEVEL: "info",
    DATABASE_URL: "postgres://u:p@h/db?sslmode=require",
  });
});

test("secrets travel as references, never as values", () => {
  const spec = buildAppSpec({
    ...base,
    secrets: [{ key: "DATABASE_URL", name: "app-myapp-DATABASE_URL" }],
  });

  // A bare secret id, exactly what resolveSecret in the agent expects — no
  // ":latest" suffix, which is Cloud Run's `--set-secrets` vocabulary and not
  // Secret Manager's, and no project path, so the spec survives a project move.
  assert.deepEqual(spec.secrets, { DATABASE_URL: "app-myapp-DATABASE_URL" });

  // The whole point: the placement row is in Postgres, and a value here would
  // put every app's database password in a table the platform reads constantly.
  assert.ok(!JSON.stringify(spec).includes("postgres://"));
});

test("an app that declares nothing gets the agent's implicit web, not an invented one", () => {
  const spec = buildAppSpec(base);

  // Absent, not an empty array: `processesOf` treats a zero-length Processes as
  // "one web process built from the app's own port and health path", and sending
  // [] would take the other branch and place an app that runs nothing at all.
  assert.equal(spec.processes, undefined);
  assert.equal(spec.port, 8080);
  assert.equal(spec.healthPath, "/");
});

test("a command is handed to a shell, because that is what it was written for", () => {
  const spec = buildAppSpec({
    ...base,
    processes: [resolveProcess("bot", { command: "python bot.py 2>&1 | tee /data/bot.log" })] as ResolvedProcess[],
  });

  // The agent execs argv directly — no shell — while the Cloud Run path wraps
  // every command in `/bin/sh -c` (see shellCommand). Splitting on whitespace
  // here would make one Procfile line mean two different things depending on
  // which runtime the app landed on, which is the entire class of bug this
  // migration exists to stop creating.
  assert.deepEqual(spec.processes?.[0].command, ["/bin/sh", "-c", "python bot.py 2>&1 | tee /data/bot.log"]);
});

test("a process that asked for its own memory gets it, in the unit the agent speaks", () => {
  const spec = buildAppSpec({
    ...base,
    processes: [resolveProcess("bot", { command: "python bot.py", memory: "512Mi" })] as ResolvedProcess[],
  });

  // The schema says "512Mi" because that is Cloud Run's spelling; the agent's
  // cgroup limit is a byte count. Left untranslated the process silently falls
  // back to the app-wide limit, which is four times too much and hides the
  // author's answer to "how big is this thing".
  assert.equal(spec.processes?.[0].memoryBytes, 512 * 1024 * 1024);
});

test("a release command reaches the node as a release process", () => {
  // The agent runs KindRelease to completion BEFORE web and worker start, and
  // keys it by image so a slow start does not run a customer's migration twice
  // concurrently. All of that is wasted if the command never arrives.
  const spec = buildAppSpec({
    ...base,
    processes: [
      resolveProcess("release", { command: "python manage.py migrate" }),
      resolveProcess("web", { command: "gunicorn app:wsgi" }),
    ] as ResolvedProcess[],
  });

  const release = spec.processes?.find((p) => p.name === "release");
  assert.equal(release?.kind, "release");
  assert.deepEqual(release?.command, ["/bin/sh", "-c", "python manage.py migrate"]);
});

test("a release declared in config, not a Procfile, still reaches the node", () => {
  // deploy-pipeline.ts:483 treats a release PROCESS and a release COMMAND as
  // separate things, because on Cloud Run they were: one is a Procfile line and
  // the other is a job. On a node there is one primitive, so the command has to
  // arrive as a process or the app's migrations simply never run.
  const spec = buildAppSpec({
    ...base,
    processes: [resolveProcess("web", { command: "gunicorn app:wsgi" })] as ResolvedProcess[],
    releaseCommand: "python manage.py migrate",
  });

  const release = spec.processes?.find((p) => p.name === "release");
  assert.equal(release?.kind, "release");
  assert.deepEqual(release?.command, ["/bin/sh", "-c", "python manage.py migrate"]);
});

test("declared processes cross over with the fields their kind uses", () => {
  const processes = [
    resolveProcess("web", { command: "npm start" }),
    resolveProcess("bot", { command: "python bot.py" }),
    resolveProcess("nightly", { command: "python digest.py", schedule: "0 3 * * *", timezone: "Asia/Almaty" }),
  ] as ResolvedProcess[];

  const spec = buildAppSpec({ ...base, processes });
  const by = (n: string) => spec.processes?.find((p) => p.name === n);

  assert.equal(by("web")?.kind, "web");
  assert.equal(by("web")?.port, 8080);
  assert.equal(by("bot")?.kind, "worker");
  // A worker has no port, and sending one would put it in the routing table.
  assert.equal(by("bot")?.port, undefined);
  assert.equal(by("nightly")?.kind, "cron");
  assert.equal(by("nightly")?.schedule, "0 3 * * *");
  assert.equal(by("nightly")?.timezone, "Asia/Almaty");
});

/**
 * The json tags of the agent's `ProcessFault` struct, read from the agent.
 *
 * The same check as above, for the pair phase 1C-1's self-review flagged and
 * deferred: `ProcessFault` is declared in Go (services/fleet/agent/desired.go)
 * and mirrored in TypeScript (lib/fleet.ts), the node writes one and the
 * control plane reads it, and nothing held the two together.
 *
 * The failure it prevents is silent in the worst direction. A field renamed on
 * one side does not throw — it arrives as undefined, `fault` reads as neither
 * "node" nor "app", nodeFaultFor finds nothing, and a fault the node correctly
 * blamed on itself goes back to being blamed on the app. Which is the one
 * outcome that whole slice exists to prevent, restored by a typo.
 */
function agentProcessFaultFields(): string[] {
  const src = readFileSync(resolve(process.cwd(), "../../services/fleet/agent/desired.go"), "utf8");
  const block = src.match(/type ProcessFault struct \{([\s\S]*?)\n\}/);
  assert.ok(block, "could not find `type ProcessFault struct` in the agent");
  return [...block[1].matchAll(/json:"([^"]+)"/g)].map((m) => m[1].split(",")[0]);
}

test("what the node says about a process is what the control plane reads", () => {
  // Every field present, so this is the whole shape and not whatever one
  // instance happened to carry.
  const full: Required<ProcessFault> = {
    slug: "a8ebb",
    process: "web",
    fault: "node",
    detail: "this node's database path (10.200.0.1:5432) is not answering",
  };

  assert.deepEqual(Object.keys(full).sort(), agentProcessFaultFields().sort());
});

test("the wire field the control plane keys absent-vs-empty on is still optional in Go", () => {
  // `processes` is a POINTER to a slice with omitempty, and that is the whole
  // absent/empty distinction: absent means "this agent does not report" and
  // must leave the stored faults alone; `[]` means "I hold nothing failing" and
  // must clear them. A plain slice with omitempty cannot express it — it drops
  // nil and empty alike — and dropping the pointer would silently leave every
  // repaired app marked as a node fault forever.
  const src = readFileSync(resolve(process.cwd(), "../../services/fleet/agent/desired.go"), "utf8");
  const block = src.match(/type syncBody struct \{([\s\S]*?)\n\}/);
  assert.ok(block, "could not find `type syncBody struct` in the agent");
  assert.match(
    block[1],
    /Processes\s+\*\[\]ProcessFault\s+`json:"processes,omitempty"`/,
    "the sync body's processes field is no longer a pointer-to-slice with omitempty",
  );
});
