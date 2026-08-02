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
import { StageRecorder } from "@/lib/stages";

const runId = (process.argv[2] || process.env.SUPERSONIC_RUN_ID || "").trim();

/**
 * When this process started running its own code.
 *
 * Taken at module load, before anything is awaited, so that the difference
 * between it and the run row's created_at is everything that happened outside
 * this process: scheduling, image pull, container start.
 */
const enteredAt = new Date();

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

  const { request, archive, createdAt } = claimed;
  const sink = eventSink(runId, request.slug);
  console.error(`deploy-job: run ${runId} for ${request.slug}`);

  // The dark half of the handoff, finally on a clock.
  //
  // 227 seconds passed on 1 Aug between the CLI's upload finishing and the
  // pipeline's first line, for a repository of a few megabytes. The API records
  // its two stages; everything after that — Cloud Run scheduling the execution,
  // pulling the image, starting the container, and this process fetching and
  // decrypting the source — happened inside one unattributed lump. Recorded as
  // two stages here, it becomes four in total, and the next person to look at
  // this number will know which part to attack.
  if (createdAt) {
    const cold = new StageRecorder(request.slug, "unknown");
    // From the row being written to this process reaching this line: scheduling,
    // image pull, container start, and the archive round-trip inside claimRun.
    await cold.end({ stage: "job-cold-start", startedAt: createdAt }, "ok");
    // The part of that which was ours: fetching and decrypting the bundle.
    await cold.end({ stage: "run-fetch", startedAt: enteredAt }, "ok");
  }

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
