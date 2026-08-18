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
import { deployOne } from "@/lib/deploy-one";
import { StageRecorder } from "@/lib/stages";

const runId = (process.argv[2] || process.env.SUPERSONIC_RUN_ID || "").trim();

/**
 * When this process began, versus when its own code did.
 *
 * `performance.timeOrigin` is process start — BEFORE the import tree at the top
 * of this file was resolved and transpiled by tsx. `enteredAt` is after it. The
 * gap between them is what boot and transpilation cost, and until now it was
 * invisible: `enteredAt` is taken at module load, which in ESM runs after the
 * imports, so that cost sat inside `job-cold-start` indistinguishable from the
 * image pull.
 */
const startedAt = new Date(performance.timeOrigin);
const enteredAt = new Date();

async function main() {
  if (!runId) {
    console.error("deploy-job: no run id — expected it as the first argument");
    process.exit(2);
  }

  // The pipeline itself lives in lib/deploy-one.ts, because the warm worker runs
  // exactly the same thing and only starts differently. What stays here is what
  // is true of a JOB and of nothing else: what its own cold start cost.
  const result = await deployOne(runId, {
    onClaimed: async (createdAt, slug, emit) => {
      if (!createdAt) return;

      // The dark half of the handoff, finally on a clock.
      //
      // 227 seconds passed on 1 Aug between the CLI's upload finishing and the
      // pipeline's first line, for a repository of a few megabytes. The API
      // records its two stages; everything after that — Cloud Run scheduling the
      // execution, pulling the image, starting the container, and this process
      // fetching and decrypting the source — happened inside one unattributed
      // lump. Recorded as two stages here, it becomes four in total, and the
      // next person to look at this number will know which part to attack.
      const cold = new StageRecorder(slug, "unknown", undefined, undefined, undefined, { runId }, emit);
      // From the row being written to this process reaching this line:
      // scheduling, image pull, container start, and the archive round-trip
      // inside claimRun.
      await cold.end({ stage: "job-cold-start", startedAt: createdAt }, "ok");
      // The part of that which was ours: fetching and decrypting the bundle.
      await cold.end({ stage: "run-fetch", startedAt: enteredAt }, "ok");

      // Cloud Run's half: scheduling, image pull, container start. It ended the
      // instant this process existed, which is before the line reporting it runs
      // — so it is written by a recorder whose clock is frozen there, rather
      // than by `cold`, whose `end` stamps the current time.
      const atStart = new StageRecorder(slug, "unknown", undefined, () => startedAt, undefined, { runId }, emit);
      await atStart.end({ stage: "job-launch", startedAt: createdAt }, "ok");

      // Our half: Node booting and tsx transpiling the import tree above.
      const atEntry = new StageRecorder(slug, "unknown", undefined, () => enteredAt, undefined, { runId }, emit);
      await atEntry.end({ stage: "job-import", startedAt }, "ok");
    },
  });

  if (result === "missing") {
    // Already run, or swept. Exiting 0 is correct: a retried execution must not
    // deploy a second time, and there is nothing here to report as a failure.
    console.error(`deploy-job: run ${runId} is not on file — nothing to do`);
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error("deploy-job: fatal", e); process.exit(1); },
);
