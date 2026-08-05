import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAppSpec, type AppSpec } from "../lib/fleet-spec";
import { resolveProcess, type ResolvedProcess } from "../lib/processes";
import type { ProcessFault, ProcessState } from "../lib/fleet";

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
  // A web process carries NO port of its own, and that is the fix rather than a
  // regression: the agent's `effectivePort` prefers the process value over the
  // app's, so a hardcoded 8080 here outranked whatever the deploy resolved and
  // stock nginx — serving 80 — was probed on 8080 and rolled back as unhealthy.
  // One answer for the app, on the app.
  assert.equal(by("web")?.port, undefined);
  assert.equal(spec.port, 8080);
  assert.equal(by("bot")?.kind, "worker");
  // A worker has no port either, and for a different reason that still holds:
  // sending one would put it in the routing table.
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

/** The json tags of `ProcessState`, read from the agent itself. */
function agentProcessStateFields(): string[] {
  const src = readFileSync(resolve(process.cwd(), "../../services/fleet/agent/desired.go"), "utf8");
  const block = src.match(/type ProcessState struct \{([\s\S]*?)\n\}/);
  assert.ok(block, "could not find `type ProcessState struct` in the agent");
  return [...block[1].matchAll(/json:"([^"]+)"/g)].map((m) => m[1].split(",")[0]);
}

test("what the node says it is RUNNING is what the control plane reads", () => {
  // The same drift risk as ProcessFault, failing in a sharper direction. A field
  // renamed on one side does not throw — it arrives as undefined, `runVerdict`
  // finds no matching row or no matching image, and every worker-only fleet
  // deploy rolls back with a reason nobody can act on. And this pair carries the
  // comparison itself: drop `command` from the Go struct and the verdict
  // silently weakens to an image check, which passes a redeploy on the process
  // still running the old argv.
  const full: Required<ProcessState> = {
    slug: "a8ebb",
    process: "bot",
    image: "us-central1-docker.pkg.dev/p/r/a8ebb@sha256:abc",
    command: ["/bin/sh", "-c", "python bot.py"],
    // Added when "the node is running your image" turned out not to mean the app
    // works. Drop it from either side and a redeploy verifies against a process
    // that is crash looping, which is how a broken deploy was announced live.
    healthy: true,
  };

  assert.deepEqual(Object.keys(full).sort(), agentProcessStateFields().sort());
});

test("the wire field the control plane keys absent-vs-empty on is a pointer for `running` too", () => {
  // Absent means "this agent does not report" and must leave the stored rows
  // alone, so a rolling agent upgrade does not read as the fleet having stopped
  // running things; `[]` means "I am running nothing confirmed" and must clear
  // them. `null` is neither — the reader tests for an array — and a plain slice
  // with omitempty cannot express the distinction at all.
  const src = readFileSync(resolve(process.cwd(), "../../services/fleet/agent/desired.go"), "utf8");
  const block = src.match(/type syncBody struct \{([\s\S]*?)\n\}/);
  assert.ok(block, "could not find `type syncBody struct` in the agent");
  assert.match(
    block[1],
    /Running\s+\*\[\]ProcessState\s+`json:"running,omitempty"`/,
    "the sync body's running field is no longer a pointer-to-slice with omitempty",
  );
});

test("a release does not delete the web process it was appended next to", () => {
  // The pipeline appends the release to the process list BEFORE calling this,
  // so the realistic input is a list that already contains it — which is why
  // the guard cannot be "was the list empty".
  // Found on the fleet's first real placement with a release, p6mx8/goapi.
  //
  // An app whose web process comes from `start` rather than from a Procfile has
  // an EMPTY process list, and an empty list is not "nothing" — `processesOf`
  // reads it as one implicit web process. Appending the release makes the list
  // non-empty, at which point the agent runs exactly what is in it: the
  // release, and nothing else. The app migrates its database and serves no
  // traffic.
  //
  // The spec that actually reached fleet_placements was [release] alone, and
  // the placement was refused with "this placement declares no long-running
  // process". This asserts the shape that refusal was pointing at.
  const spec = buildAppSpec({
    slug: "p6mx8",
    image: "img@sha256:abc",
    env: [],
    secrets: [],
    processes: [],
    releaseCommand: "/app/migrate",
    serviceless: false,
  });

  const kinds = (spec.processes ?? []).map((p) => p.kind);
  assert.ok(kinds.includes("web"), `the web process was lost: ${JSON.stringify(spec.processes)}`);
  assert.ok(kinds.includes("release"), "the release was not added");

  // No command on the synthesised web: the image's own entrypoint is the app's
  // `start`, and inventing a command here would override it with a guess.
  const web = (spec.processes ?? []).find((p) => p.kind === "web");
  assert.equal(web?.command, undefined);
});

test("an app that really declares no web keeps declaring none", () => {
  // The other direction, and the one that must not regress: a bot declares its
  // processes explicitly, so the list is already non-empty and nothing implicit
  // is owed. Synthesising a web process here would put a Telegram bot back to
  // pretending to be a web server, which is the defect the process model exists
  // to remove.
  const spec = buildAppSpec({
    slug: "botapp",
    image: "img@sha256:abc",
    env: [],
    secrets: [],
    processes: [resolveProcess("bot", { command: "python bot.py" }) as never],
    releaseCommand: "python migrate.py",
  });

  const kinds = (spec.processes ?? []).map((p) => p.kind);
  assert.ok(!kinds.includes("web"), `a web process was invented: ${JSON.stringify(spec.processes)}`);
  assert.ok(kinds.includes("release"));
});

test("an app with a Procfile web and a config release gets exactly one web", () => {
  const spec = buildAppSpec({
    slug: "webapp",
    image: "img@sha256:abc",
    env: [],
    secrets: [],
    processes: [resolveProcess("web", { command: "npm start" }) as never],
    releaseCommand: "npm run migrate",
  });
  assert.equal((spec.processes ?? []).filter((p) => p.kind === "web").length, 1);
});

test("the release the PIPELINE already appended still does not delete the web process", () => {
  // The shape that actually reached production. deploy-pipeline appends the
  // release to `processes` itself, so buildAppSpec is handed `[release]` and
  // its own releaseCommand branch never fires — which is why the first attempt
  // at this fix, guarding on "was the list empty", did nothing at all.
  const spec = buildAppSpec({
    slug: "p6mx8",
    image: "img@sha256:abc",
    env: [],
    secrets: [],
    processes: [resolveProcess("release", { command: "/app/migrate" }) as never],
    releaseCommand: "/app/migrate",
    serviceless: false,
  });

  const kinds = (spec.processes ?? []).map((p) => p.kind);
  assert.ok(kinds.includes("web"), `the web process was lost: ${JSON.stringify(spec.processes)}`);
  assert.equal(kinds.filter((k) => k === "release").length, 1, "the release was doubled");
});

test("a cron-only app is not given a web process it never asked for", () => {
  // serviceless is true for this one, and that is the whole distinction: a list
  // with no web and no worker is correct here, and inventing one would place an
  // app that runs a web server nobody wrote.
  const spec = buildAppSpec({
    slug: "cronly",
    image: "img@sha256:abc",
    env: [],
    secrets: [],
    processes: [resolveProcess("nightly", { command: "python digest.py", schedule: "0 3 * * *" }) as never],
    serviceless: true,
  });
  assert.ok(!(spec.processes ?? []).some((p) => p.kind === "web"));
});

test("a caller that does not say makes this function decide nothing", () => {
  // serviceless absent means "unknown". Guessing a web process into existence
  // on a caller's silence is how a bot ends up pretending to be a web server.
  const spec = buildAppSpec({
    slug: "unknown",
    image: "img@sha256:abc",
    env: [],
    secrets: [],
    processes: [resolveProcess("release", { command: "/app/migrate" }) as never],
  });
  assert.ok(!(spec.processes ?? []).some((p) => p.kind === "web"));
});
