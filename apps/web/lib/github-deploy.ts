import { randomUUID } from "node:crypto";
import { cloudRunName } from "@/lib/slug";
import { fullNameFromUrl } from "@/lib/github-repos";
import { entitlement } from "@/lib/entitlements";
import { countIfUnder } from "@/lib/usage";
import { createRun, startDeployRun, finishRun } from "@/lib/deploy-runs";
import { startBuild, finishBuild, type Commit } from "@/lib/builds";
import { appForPush, refreshRepoName, type PushTarget } from "@/lib/app-repos";
import { postCommitStatus, type StatusPost } from "@/lib/github-status";
import type { Push } from "@/lib/github-webhook";

/**
 * What a push means, and how it becomes a build.
 *
 * The last step here is the same `createRun` → `startDeployRun` pair that
 * `app/api/deploy/route.ts` uses in its `DEPLOY_JOB` branch, and that is the
 * point of the module. A second dispatch path would be a second place for the
 * quota, the supersede, the build record and the outcome to be got wrong, and
 * the two would drift the first time either was touched.
 *
 * What is genuinely different is everything BEFORE the dispatch: there is no
 * session, no request body to trust and nobody to return an error to. So every
 * refusal is a value, named, that the route puts in a 200 body — see
 * lib/github-webhook.ts on why a delivery that did nothing must still say why.
 */

const REGION = "us-central1";
const DEPLOY_JOB = process.env.DEPLOY_JOB === "1";
const DEPLOY_JOB_NAME = process.env.DEPLOY_JOB_NAME || "supersonic-deploy-job";

export type ShipResult =
  | { shipped: true; slug: string; runId: string }
  | { shipped: false; reason: string; slug?: string };

/**
 * Who caused this build, in the only terms that can be known.
 *
 * CONTEXT.md is explicit: *"When nobody said, the answer is `someone` — never a
 * guess, because a wrong name here is worse than no name."* What is known is
 * the login that connected the account and the login that pushed. When they
 * match, `you` is a fact. When they do not — a colleague, a bot, a merge queue
 * — the answer is `someone`, and `builds.commit_author` still carries the name
 * so a page can show WHO without the platform claiming it was the owner.
 *
 * An organisation installation names nobody, so `connectedLogin` is null for
 * one and every org push answers `someone`. That is the honest reading, not a
 * gap to be filled later.
 */
export function whoPushed(senderLogin: string, connectedLogin: string | null): "you" | "someone" {
  if (!connectedLogin || !senderLogin) return "someone";
  return senderLogin.toLowerCase() === connectedLogin.toLowerCase() ? "you" : "someone";
}

/**
 * The URL the clone is made from.
 *
 * Built from the name in THIS push rather than read from `apps.repo_url`,
 * because a rename is invisible until a push arrives carrying the new name
 * beside the unchanged id — so the payload is the freshest thing we will ever
 * have, and the stored column is by definition one rename behind.
 */
export function cloneUrlForPush(fullName: string): string {
  return `https://github.com/${fullName}.git`;
}

/**
 * Everything `shipPush` reaches outside itself.
 *
 * Six seams rather than a mockable module, following `ReposDeps`, `MintDeps`
 * and `ImportDeps` in the modules beside this one. The function they serve is
 * the one that decides whether a `git push` becomes a build, it runs with no
 * session and nobody watching, and every branch in it should be assertable
 * without a database, a GitHub and a Cloud Run job.
 */
export interface ShipDeps {
  target: (repoId: number, branch: string) => Promise<PushTarget | null>;
  refreshName: (repoId: number, fullName: string) => Promise<void>;
  /** The plan, or a refusal. `locked` is an account that cannot build at all. */
  plan: (ownerId: string) => Promise<{ locked: boolean; monthlyBuilds: number }>;
  /** Charge one build against the meter. False means the ceiling was reached. */
  charge: (ownerId: string, limit: number) => Promise<boolean>;
  record: (runId: string, slug: string, who: string, commit: Commit) => Promise<void>;
  dispatch: (runId: string, target: PushTarget, push: Push, limits: unknown) => Promise<void>;
  status: (o: StatusPost) => Promise<boolean>;
  /** Whether deploys execute in a job at all. False refuses rather than hangs. */
  jobEnabled: boolean;
}

const liveShip: ShipDeps = {
  target: appForPush,
  refreshName: (id, name) => refreshRepoName(id, name),
  plan: async (ownerId) => {
    const ent = await entitlement(ownerId);
    return { locked: ent.locked, monthlyBuilds: ent.limits.monthlyBuilds };
  },
  charge: (ownerId, limit) => countIfUnder(ownerId, "builds", limit),
  record: (runId, slug, who, commit) => startBuild(runId, slug, who, commit),
  dispatch: liveDispatch,
  status: (o) => postCommitStatus(o),
  jobEnabled: DEPLOY_JOB,
};

/**
 * Ship a push, or say why not.
 *
 * The order below is not arbitrary. The link is resolved first, because most
 * deliveries are for repositories nobody connected and those must cost one
 * indexed query and nothing else. The meter is charged before the dispatch,
 * because we pay for a build that fails exactly as much as for one that works
 * — a meter that only counted successes is one a broken repository can evade.
 * The pending status goes out last, after the build is real, so a tick never
 * appears for a build that was refused.
 */
export async function shipPush(push: Push, over: Partial<ShipDeps> = {}): Promise<ShipResult> {
  const d: ShipDeps = { ...liveShip, ...over };

  const target = await d.target(push.repoId, push.branch);
  if (!target) return { shipped: false, reason: "no-app-follows-this-branch" };
  if (!target.autoDeploy) return { shipped: false, reason: "auto-deploy-off", slug: target.slug };

  // The stored name, in step with GitHub's. A rename produces no event we
  // subscribe to, so the first we hear of it is a push carrying the new name
  // beside the unchanged id. Swallowed: a stale display name must never stop a
  // build.
  await d.refreshName(push.repoId, push.repoFullName).catch(() => {});

  // Refused here rather than let through and failed later: a build that cannot
  // be dispatched must not leave a `pending` status on a commit that nothing
  // will ever come back to resolve.
  if (!d.jobEnabled) return { shipped: false, reason: "deploy-job-disabled", slug: target.slug };

  const plan = await d.plan(target.ownerId);
  if (plan.locked) return { shipped: false, reason: "no-account", slug: target.slug };
  if (!(await d.charge(target.ownerId, plan.monthlyBuilds))) {
    return { shipped: false, reason: "build-limit-reached", slug: target.slug };
  }

  const runId = randomUUID();

  // The durable record of this attempt, written before anything can fail, so a
  // build that dies in its first second still appears on the app's timeline —
  // the same reason and the same placement as the route's.
  await d.record(runId, target.slug, whoPushed(push.senderLogin, target.connectedLogin), {
    sha: push.sha,
    branch: push.branch,
    message: push.message,
    author: push.author,
  });

  try {
    await d.dispatch(runId, target, push, { monthlyBuilds: plan.monthlyBuilds });
  } catch (e) {
    // The run record holds the app's secrets and exists only so a job can pick
    // it up. If no job ever will, it is deleted now rather than left for the
    // six-hour sweep.
    await finishRun(runId).catch(() => {});
    await finishBuild(runId, "failed").catch(() => {});
    await d.status({
      installationId: target.installationId,
      fullName: push.repoFullName,
      sha: push.sha,
      // `error`, not `failure`: the build never ran, so there is no verdict on
      // the code. See `reportOutcome`, which owns the other word.
      state: "error",
      slug: target.slug,
      description: `Could not start the build: ${e instanceof Error ? e.message : String(e)}`,
    });
    return { shipped: false, reason: "dispatch-failed", slug: target.slug };
  }

  await d.status({
    installationId: target.installationId,
    fullName: push.repoFullName,
    sha: push.sha,
    state: "pending",
    slug: target.slug,
    // The Room: the app's own address, which is where a person watches the
    // build happen and which becomes the app itself the moment it opens.
    targetUrl: `https://${target.slug}.supersonic.cv`,
    description: "Building…",
  });

  return { shipped: true, slug: target.slug, runId };
}

/** The real dispatch, kept behind a seam so `shipPush` is testable without GCP. */
async function liveDispatch(runId: string, target: PushTarget, push: Push, limits: unknown): Promise<void> {
  const url = cloneUrlForPush(push.repoFullName);
  await createRun(
    {
      ownerId: target.ownerId,
      ownerWorkspace: target.workspaceId,
      slug: target.slug,
      friendlyName: cloudRunName(url),
      repoUrl: url,
      ghInstallationId: target.installationId,
      // Pinned, which is the whole reason the column exists. See
      // `commitSha` in lib/deploy-runs.ts.
      commitSha: push.sha,
      // Already connected — that is what made this push a build. The link is
      // written by the deploy that CONNECTS and read by every one after it.
      connect: null,
      isUpload: false,
      isPrebuilt: false,
      prebuiltHash: "",
      secrets: {},
      cloneToken: null,
      runCmd: "",
      limits,
    },
    null,
    null,
    runId,
  );
  await startDeployRun(runId, REGION, DEPLOY_JOB_NAME);
}

/**
 * Tell the commit how its build ended.
 *
 * Called from the `finally` in lib/deploy-one.ts, beside `finishBuild`, and for
 * the same reason it is there: that block is the one place every ending passes
 * through — success, failure, and a pipeline that threw on its way out.
 *
 * Everything it needs is already in the run row, so it asks the database
 * nothing. A build with no installation or no commit is every deploy that was
 * not caused by a push, and those return without a request.
 *
 * Never throws. `postCommitStatus` is best-effort by contract and this adds no
 * new way to fail — a deploy that worked must not be reported as failed because
 * GitHub would not take a status.
 */
export async function reportOutcome(o: {
  installationId: number | null;
  repoUrl: string;
  commitSha: string | null;
  slug: string;
  outcome: "ok" | "failed";
}): Promise<void> {
  if (o.installationId == null || !o.commitSha) return;
  const fullName = fullNameFromUrl(o.repoUrl);
  if (!fullName) return;
  const url = `https://${o.slug}.supersonic.cv`;
  await postCommitStatus({
    installationId: o.installationId,
    fullName,
    sha: o.commitSha,
    // `failure`, not `error`: the build ran and produced a verdict. `error` is
    // reserved for the case where it never got to run at all, which is what
    // `shipPush` reports when the dispatch itself fails.
    state: o.outcome === "ok" ? "success" : "failure",
    slug: o.slug,
    targetUrl: url,
    description: o.outcome === "ok" ? `Live at ${o.slug}.supersonic.cv` : "The build failed",
  });
}
