import {
  workerPoolArgs, cronJobArgs, cronScheduleArgs, cronScheduleUpdateArgs,
  processResourceName, type ProcessDeploy, type Scheduled,
} from "./process-deploy";
import { PRIMITIVE, unemittable, type Primitive, type ProcessKind, type ResolvedProcess, type TaskProcess, type WorkerProcess } from "./processes";
import { cloudRunName } from "./slug";

/**
 * What a deploy has to DO about an app's processes — as data, before anything runs.
 *
 * The emitters in lib/process-deploy.ts each answer "what argv creates this one
 * thing". This answers the two questions a deploy actually has: what is the whole
 * set, and what is on the cloud that the set no longer contains.
 *
 * That second half is the plan's own principle applied one level up. Emitting
 * desired state for a resource is worth little if the SET of resources is still
 * patched — an app that deletes its `emails` worker from `supersonic.json` and
 * redeploys would otherwise keep a worker pool running the old command, billed,
 * draining a queue nobody is reading, with nothing anywhere recording that it was
 * meant to be gone. That is the same class of defect as the stale cloudsql
 * annotation, reproduced in the feature built to end it.
 *
 * Pure, like the emitters: this returns a list of commands and touches nothing.
 * The imperative part of wiring processes into a deploy is then a loop over this,
 * which is the whole reason for the split — the risk stays in about thirty lines
 * and the decisions stay under test.
 */

/** The label that makes a process's resources findable again. */
export const PARENT_LABEL = "supersonic-parent";
export const PROCESS_LABEL = "supersonic-process";

export interface ProcessStep {
  /** The Cloud Run resource name. */
  name: string;
  kind: ProcessKind;
  primitive: Primitive;
  /** For the deploy log: `worker "emails"`. */
  label: string;
  /** The gcloud argv that creates or updates it. */
  deploy: string[];
  /**
   * A cron's schedule, as both spellings.
   *
   * `gcloud scheduler jobs create` is not create-or-update — it fails
   * ALREADY_EXISTS on the second deploy of an unchanged app, which would fail
   * every redeploy of a CRM on a cron that was already correct. The caller tries
   * `update` and falls back to `create`, which is the shape `run jobs deploy`
   * gives for free and Scheduler does not.
   */
  schedule?: { update: string[]; create: string[] };
  /** Declared fields this deploy will not emit yet. Logged, never silently dropped. */
  notes: string[];
}

/**
 * Processes this planner is responsible for.
 *
 * `web` goes through `deployArgs` in lib/lanes.ts, unchanged, because there are
 * live services on that path and a step about workers must not smuggle in a
 * migration for them.
 *
 * `release` goes through lib/release-job.ts, which already exists, already runs
 * it once before traffic, and already knows the two things that are easy to get
 * wrong — that the app container must be declared first so the task ends when the
 * migration exits rather than waiting on a proxy that never does, and that
 * configuring a job and running one are separate failures. Emitting a second
 * release path from here would be one rule with two readers, which is the defect
 * this whole plan is named after.
 */
export const PLANNED_KINDS: ReadonlySet<ProcessKind> = new Set<ProcessKind>(["worker", "cron"]);

/** The labels every managed process carries, so `orphans` can find them again. */
export function processLabels(service: string, processName: string): string[] {
  return [`${PARENT_LABEL}=${cloudRunName(service)}`, `${PROCESS_LABEL}=${cloudRunName(processName)}`];
}

/**
 * Every command this deploy should run for this app's processes.
 *
 * Order within the returned list is declaration order, which `resolveProcesses`
 * has already put `web` at the front of — so the workers and crons come out in
 * the order their author wrote them, and a deploy log reads the way the config
 * does.
 */
export function planProcesses(
  processes: ResolvedProcess[],
  d: ProcessDeploy,
  scheduled: Scheduled,
): ProcessStep[] {
  return processes
    .filter((p) => PLANNED_KINDS.has(p.kind))
    .map((p) => {
      // Labels are added HERE rather than left to the caller, because `orphans`
      // below depends on every managed resource carrying them. A resource
      // deployed without its labels is a resource that can never be cleaned up,
      // and the failure would be invisible: it deploys fine and lingers forever.
      const withLabels: ProcessDeploy = {
        ...d,
        labels: [...(d.labels ?? []), ...processLabels(d.service, p.name)],
      };
      const name = processResourceName(d.service, p);
      const base = { name, kind: p.kind, label: `${p.kind} "${p.name}"`, notes: unemittable(p) };

      if (p.kind === "worker") {
        return { ...base, primitive: PRIMITIVE.worker, deploy: workerPoolArgs(withLabels, p as WorkerProcess) };
      }
      const task = p as TaskProcess;
      return {
        ...base,
        primitive: PRIMITIVE.cron,
        deploy: cronJobArgs(withLabels, task),
        schedule: {
          update: cronScheduleUpdateArgs(d, task, scheduled),
          create: cronScheduleArgs(d, task, scheduled),
        },
      };
    });
}

/** A resource that exists on the cloud and carries this app's labels. */
export interface LiveProcess {
  name: string;
  primitive: Primitive;
}

export interface Removal {
  name: string;
  primitive: Primitive;
  label: string;
  /**
   * Every command needed to remove it, in order.
   *
   * A cron is TWO resources — a Cloud Run job and a Cloud Scheduler entry — and
   * deleting only the job leaves a schedule that fires every night against a job
   * that is not there. Scheduler retries a failing target, so the residue is not
   * inert: it is an error every night, forever, for an app whose owner deleted
   * the feature.
   */
  deletes: string[][];
}

/**
 * Resources this app has that its config no longer describes.
 *
 * Computed by NAME, against the live set, rather than by diffing configs. A
 * config-to-config diff needs the previous config, which nothing stores and which
 * would be wrong the moment someone changed something outside a deploy — the
 * assumption that made `--update-env-vars` a trap. The cloud is the state; the
 * config is the intent; this is the difference.
 *
 * `web` and the release job are never candidates: they are not in `planned`
 * because this planner does not own them, so listing them would delete the app.
 * Callers must pass only resources carrying `PROCESS_LABEL`, which is exactly the
 * set this module creates.
 */
export function orphans(
  live: LiveProcess[],
  planned: ProcessStep[],
  d: Pick<ProcessDeploy, "service" | "region" | "project">,
): Removal[] {
  const keep = new Set(planned.map((s) => `${s.primitive}:${s.name}`));

  return live
    .filter((l) => !keep.has(`${l.primitive}:${l.name}`))
    .map((l) => ({
      name: l.name,
      primitive: l.primitive,
      label: `${l.primitive} "${l.name}"`,
      deletes: deleteArgs(l, d),
    }));
}

function deleteArgs(l: LiveProcess, d: Pick<ProcessDeploy, "region" | "project">): string[][] {
  const where = ["--region", d.region, "--project", d.project, "--quiet"];

  if (l.primitive === "worker-pool") {
    return [["beta", "run", "worker-pools", "delete", l.name, ...where]];
  }
  return [
    // The schedule first. Deleting the job first leaves a window — however short
    // — in which Scheduler fires at a target that has just stopped existing, and
    // that window is a real alert on a real morning. Removing the trigger before
    // the thing it triggers is the only order with no such window.
    //
    // `--location`, not `--region`: Cloud Scheduler spells it differently, and
    // passing the wrong one fails with "unrecognized arguments" on a cleanup step
    // whose failure would otherwise look like the deploy's.
    ["scheduler", "jobs", "delete", l.name, "--location", d.region, "--project", d.project, "--quiet"],
    ["run", "jobs", "delete", l.name, ...where],
  ];
}

/**
 * The gcloud argv that lists this app's managed processes.
 *
 * Filtered on the label rather than on a name prefix. A prefix is what
 * `listJobs` in lib/gcloud.ts uses and it is the weaker rule: an app called
 * `crm` and an app called `crm-worker` share one, so a redeploy of the first
 * could compute the second's resources as its own orphans and delete a different
 * customer's worker. The label is written by this module and by nothing else.
 */
export function listWorkerPoolsArgs(d: Pick<ProcessDeploy, "service" | "region" | "project">): string[] {
  return [
    "beta", "run", "worker-pools", "list",
    "--region", d.region, "--project", d.project,
    `--filter=metadata.labels.${PARENT_LABEL}=${cloudRunName(d.service)}`,
    "--format=value(metadata.name)",
  ];
}

export function listProcessJobsArgs(d: Pick<ProcessDeploy, "service" | "region" | "project">): string[] {
  return [
    "run", "jobs", "list",
    "--region", d.region, "--project", d.project,
    `--filter=metadata.labels.${PARENT_LABEL}=${cloudRunName(d.service)} AND metadata.labels.${PROCESS_LABEL}:*`,
    "--format=value(metadata.name)",
  ];
}

/**
 * Whether this app has a `web` process — and therefore a Cloud Run service.
 *
 * The distinction a worker-only app turns on. A Telegram bot is a worker and
 * nothing else: no HTTP, no port, no URL, no domain mapping, nothing to probe. If
 * the pipeline deploys a service for it anyway, the bot is back to pretending to
 * be a web server, which is the defect this whole plan exists to remove.
 *
 * The `declared.length` guard is what keeps this from breaking every app that
 * exists. An app that declares NO processes is not a worker-only app — it is an
 * ordinary app whose `start` command is its web process under an older spelling,
 * and it must take exactly the path it took yesterday. Only an app that said what
 * its processes are, and did not say `web`, is serviceless.
 */
export function isServiceless(declared: ResolvedProcess[]): boolean {
  return declared.length > 0 && !declared.some((p) => p.kind === "web");
}
