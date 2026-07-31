/**
 * The deploy worker: one Cloud Run Job execution per deploy.
 *
 * Run as `node --import tsx scripts/deploy-job.ts <runId>` inside the
 * control-plane image, which already carries this code, gcloud, git and
 * opencode — the job and the API are the same image, so they can never drift.
 *
 * What this buys, versus running the same pipeline inside the HTTP handler:
 *   - the deploy owns its own memory, so one heavy build cannot OOM another's,
 *   - it is not subject to the route's 600s maxDuration cap,
 *   - a scale-down SIGTERM on the API kills no build,
 *   - and the client's connection becomes irrelevant to whether the work
 *     finishes, which is what the CLI's fire-and-forget default has been
 *     promising all along.
 *
 * Progress goes to the deploy_events table, never to a socket. Whoever wants to
 * watch reads from there.
 */
import { runDeploy, type DeployInput } from "@/lib/deploy-pipeline";
import { eventSink } from "@/lib/deploy-events";
import { claimRun, finishRun, type DeployRunRequest } from "@/lib/deploy-runs";
import { setDeploy } from "@/lib/deploys";

const runId = (process.argv[2] || process.env.SUPERSONIC_RUN_ID || "").trim();

async function main() {
  if (!runId) {
    console.error("deploy-job: no run id — expected it as the first argument");
    process.exit(2);
  }

  const claimed = await claimRun(runId);
  if (!claimed) {
    // Already run, or swept. Exiting 0 is correct: a retried execution must not
    // deploy a second time, and there is nothing here to report as a failure.
    console.error(`deploy-job: run ${runId} is not on file — nothing to do`);
    return;
  }

  const { request, archive } = claimed;
  const sink = eventSink(runId, request.slug);
  console.error(`deploy-job: run ${runId} for ${request.slug}`);

  const input: DeployInput = {
    ownerId: request.ownerId,
    ownerWorkspace: request.ownerWorkspace,
    slug: request.slug,
    friendlyName: request.friendlyName,
    repoUrl: request.repoUrl,
    isUpload: request.isUpload,
    isPrebuilt: request.isPrebuilt,
    prebuiltHash: request.prebuiltHash,
    secrets: request.secrets,
    archive,
    cloneToken: request.cloneToken,
    runCmd: request.runCmd,
    limits: request.limits as DeployInput["limits"],
  };

  try {
    await runDeploy(input, sink.emit);
  } catch (e) {
    // runDeploy handles its own failures; reaching here means it threw on the way
    // out. Say so in the log the client is reading, or the deploy just stops
    // mid-sentence and the reader waits for an event that will never come.
    const msg = e instanceof Error ? e.message : String(e);
    sink.emit({ type: "error", message: msg });
    setDeploy(request.slug, { status: "failed", error: msg });
  } finally {
    // Order matters: the events must be durable before the row that let anyone
    // find this run is deleted.
    await sink.drain();
    await finishRun(runId);
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error("deploy-job: fatal", e); process.exit(1); },
);
