import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planProcesses, orphans, processLabels, listWorkerPoolsArgs, listProcessJobsArgs,
  PLANNED_KINDS, PARENT_LABEL, PROCESS_LABEL, isServiceless, type LiveProcess,
} from "../lib/process-plan";
import { resolveProcesses } from "../lib/processes";
import type { ProcessDeploy } from "../lib/process-deploy";

const d: ProcessDeploy = {
  service: "crm",
  lane: "container" as const,
  region: "us-central1",
  project: "supersonic-deploy-prod",
  image: "us-central1-docker.pkg.dev/p/r/crm:latest",
  serviceAccount: "apps@p.iam.gserviceaccount.com",
  labels: ["supersonic-name=crm"],
  env: ["LOG_LEVEL=info"],
  secrets: null,
};
const scheduled = { schedulerServiceAccount: "sched@p.iam.gserviceaccount.com" };

/** The CRM shape: web + release + a worker + a cron. */
const crm = resolveProcesses({
  web: { command: "gunicorn config.wsgi --bind 0.0.0.0:$PORT" },
  release: { command: "python manage.py migrate --noinput" },
  emails: { command: "python -m worker.emails", instances: 2 },
  nightly: { command: "python manage.py digest", schedule: "0 3 * * *" },
});

test("the planner owns workers and crons, and nothing else", () => {
  // `web` goes through deployArgs — there are live services on that path and a
  // step about workers must not smuggle in a migration for them. `release` goes
  // through release-job.ts, which already knows the two things that are easy to
  // get wrong there; a second release path would be one rule with two readers.
  assert.deepEqual([...PLANNED_KINDS].sort(), ["cron", "worker"]);

  const steps = planProcesses(crm, d, scheduled);
  assert.deepEqual(steps.map((s) => [s.kind, s.name]), [
    ["worker", "crm-emails"],
    ["cron", "crm-nightly"],
  ]);
});

test("every managed resource is labelled, because orphan cleanup depends on it", () => {
  // A resource deployed without its labels can never be cleaned up, and the
  // failure is invisible — it deploys fine and lingers forever. So the planner
  // adds them rather than trusting the caller to.
  for (const step of planProcesses(crm, d, scheduled)) {
    const labels = step.deploy.find((a) => a.startsWith("--labels="))!;
    assert.ok(labels.includes(`${PARENT_LABEL}=crm`), step.label);
    assert.ok(labels.includes(`${PROCESS_LABEL}=`), step.label);
    // And the caller's own labels survive.
    assert.ok(labels.includes("supersonic-name=crm"), step.label);
  }
});

test("a cron plans both spellings of its schedule", () => {
  const cron = planProcesses(crm, d, scheduled).find((s) => s.kind === "cron")!;

  // `scheduler jobs create` fails ALREADY_EXISTS on the second deploy of an
  // unchanged app, which would fail every redeploy of a CRM on a cron that was
  // already correct.
  assert.deepEqual(cron.schedule!.update.slice(0, 4), ["scheduler", "jobs", "update", "http"]);
  assert.deepEqual(cron.schedule!.create.slice(0, 4), ["scheduler", "jobs", "create", "http"]);

  const worker = planProcesses(crm, d, scheduled).find((s) => s.kind === "worker")!;
  assert.equal(worker.schedule, undefined);
});

test("a field that will not be emitted is carried as a note, not dropped", () => {
  const withGrace = resolveProcesses({ queue: { command: "python -m q", shutdownGrace: 120 } });
  const [step] = planProcesses(withGrace, d, scheduled);

  assert.equal(step.notes.length, 1);
  assert.match(step.notes[0], /shutdownGrace is not emitted yet/);
  // And a process that asked for nothing unemittable says nothing.
  assert.deepEqual(planProcesses(crm, d, scheduled)[0].notes, []);
});

test("a process removed from the config has its resources deleted", () => {
  // The plan's own principle, one level up: emitting desired state per resource
  // is worth little if the SET is still patched. An app that deletes `emails`
  // and redeploys would otherwise keep a pool running the old command — billed,
  // draining a queue nobody reads, with nothing recording it was meant to be gone.
  const live: LiveProcess[] = [
    { name: "crm-emails", primitive: "worker-pool" },
    { name: "crm-old-sync", primitive: "worker-pool" },
    { name: "crm-nightly", primitive: "job" },
    { name: "crm-weekly", primitive: "job" },
  ];

  const gone = orphans(live, planProcesses(crm, d, scheduled), d);

  assert.deepEqual(gone.map((r) => r.name).sort(), ["crm-old-sync", "crm-weekly"]);
});

test("deleting a cron removes the schedule BEFORE the job it triggers", () => {
  const [removal] = orphans([{ name: "crm-weekly", primitive: "job" }], [], d);

  // Two resources, not one. Deleting only the job leaves a schedule firing every
  // night at a target that is not there — and Scheduler retries a failing target,
  // so the residue is an error every night forever for a deleted feature.
  assert.equal(removal.deletes.length, 2);
  assert.deepEqual(removal.deletes[0].slice(0, 4), ["scheduler", "jobs", "delete", "crm-weekly"]);
  assert.deepEqual(removal.deletes[1].slice(0, 4), ["run", "jobs", "delete", "crm-weekly"]);

  // Scheduler spells the region `--location`; passing --region fails with
  // "unrecognized arguments" on a cleanup step whose failure would look like the
  // deploy's.
  assert.ok(removal.deletes[0].includes("--location"));
  assert.ok(!removal.deletes[0].includes("--region"));
  assert.ok(removal.deletes[1].includes("--region"));
});

test("deleting a worker is one command and does not touch Scheduler", () => {
  const [removal] = orphans([{ name: "crm-old", primitive: "worker-pool" }], [], d);

  assert.equal(removal.deletes.length, 1);
  assert.deepEqual(removal.deletes[0].slice(0, 5), ["beta", "run", "worker-pools", "delete", "crm-old"]);
  assert.ok(removal.deletes[0].includes("--quiet"));
});

test("name and primitive both have to match, so a job and a pool can share a name", () => {
  // Cloud Run namespaces jobs and worker pools separately. Matching on name alone
  // would let a planned worker keep an unrelated job of the same name alive.
  const live: LiveProcess[] = [
    { name: "crm-emails", primitive: "worker-pool" },
    { name: "crm-emails", primitive: "job" },
  ];

  const gone = orphans(live, planProcesses(crm, d, scheduled), d);

  assert.deepEqual(gone.map((r) => r.primitive), ["job"]);
});

test("an app with no processes plans nothing and orphans everything it had", () => {
  assert.deepEqual(planProcesses(resolveProcesses({ web: { command: "npm start" } }), d, scheduled), []);

  const gone = orphans([{ name: "crm-emails", primitive: "worker-pool" }], [], d);
  assert.equal(gone.length, 1);
});

test("nothing live and nothing planned is not a deploy that deletes anything", () => {
  assert.deepEqual(orphans([], planProcesses(crm, d, scheduled), d), []);
});

test("the live set is found by label, not by name prefix", () => {
  // A prefix is what listJobs in lib/gcloud.ts uses and it is the weaker rule: an
  // app called `crm` and an app called `crm-worker` share one, so a redeploy of
  // the first could compute the second's resources as its own orphans and delete
  // a different customer's worker.
  const pools = listWorkerPoolsArgs(d);
  assert.ok(pools.some((a) => a === `--filter=metadata.labels.${PARENT_LABEL}=crm`));
  assert.ok(pools.includes("--format=value(metadata.name)"));

  // The job filter needs the process label too: the app's own release job carries
  // the parent label and must never be seen as an orphan.
  const jobs = listProcessJobsArgs(d);
  assert.ok(jobs.some((a) => a.includes(`${PROCESS_LABEL}:*`)), "release jobs would be deleted as orphans");
});

test("labels are Cloud Run names, so an odd process name cannot break the filter", () => {
  assert.deepEqual(processLabels("My App", "Email_Worker"), [
    `${PARENT_LABEL}=my-app`,
    `${PROCESS_LABEL}=email-worker`,
  ]);
});

test("an app is serviceless only when it SAID what it runs and said no web", () => {
  // A Telegram bot: a worker and nothing else. No HTTP, no port, no URL, no
  // domain mapping, nothing to probe.
  assert.equal(isServiceless(resolveProcesses({ bot: { command: "python bot.py" } })), true);

  // An agent server still needs its service.
  assert.equal(isServiceless(resolveProcesses({ web: { command: "npm start" }, q: { command: "npm run q" } })), false);

  // And the guard that keeps this from breaking every app that exists: declaring
  // NOTHING is not declaring "no web". Those apps' `start` command IS their web
  // process under an older spelling, and they must take yesterday's path exactly.
  assert.equal(isServiceless([]), false);
});
