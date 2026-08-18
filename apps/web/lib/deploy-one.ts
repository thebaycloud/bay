import { runDeploy, type DeployInput } from "@/lib/deploy-pipeline";
import { eventSink } from "@/lib/deploy-events";
import { claimRun, finishRun } from "@/lib/deploy-runs";
import { finishBuild, watchOutcome } from "@/lib/builds";
import { setDeploy } from "@/lib/deploys";

/**
 * One deploy, from a claimed run row to a finished build.
 *
 * EXTRACTED SO THERE IS ONE OF IT. Two things run deploys now — the Cloud Run
 * Job, one execution per deploy, and the warm worker, which is already up and
 * answers in milliseconds. They differ in how they are STARTED and in nothing
 * else, and the difference that matters is worth naming precisely: the job pays
 * ~118 s of Cloud Run scheduling and image pull before its first line, and the
 * worker pays one HTTP hop.
 *
 * Everything after "this process has the run" is identical, and a second copy
 * of it would be a second place for the outcome, the event drain and the build
 * record to be got wrong. The job's own cold-start stages stay in the job,
 * because `job-launch` and `job-import` are facts about a container that the
 * worker does not start.
 */

/** `missing` is not a failure: a retried execution must not deploy twice. */
export type DeployOneResult = "deployed" | "missing";

export interface DeployOneHooks {
  /**
   * Called once the run is claimed, before the pipeline starts, with the moment
   * the row was written and the app it is for. The Job uses it to record what
   * its own cold start cost; the slug is passed because stage rows are keyed by
   * it and the caller cannot know it before the claim.
   *
   * `emit` is the deploy's own event stream, handed over so the stages recorded
   * here are ANNOUNCED as well as written: the handoff is the first half of the
   * wait, and a watcher that only hears from the pipeline has nothing to show
   * for it.
   */
  onClaimed?: (createdAt: Date | null | undefined, slug: string, emit: (e: unknown) => void) => Promise<void>;
}

export async function deployOne(runId: string, hooks: DeployOneHooks = {}): Promise<DeployOneResult> {
  const claimed = await claimRun(runId);
  if (!claimed) return "missing";

  const { request, archive, createdAt } = claimed;
  const sink = eventSink(runId, request.slug);

  const input: DeployInput = {
    runId,
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

  // Every event the deploy emits passes through here on its way to the sink, so
  // the row written below says the same thing the log does. Wrapped rather than
  // read back afterwards: the outcome is a fact this process already has, and a
  // second reader of it would be a second answer to drift from the first.
  const watch = watchOutcome();
  const emit = (e: unknown) => { watch.saw(e); sink.emit(e); };

  // After `emit` exists, because the hook records stages and those are events
  // now — before it, the job's own cold start would be written to the table and
  // said to nobody.
  if (hooks.onClaimed) await hooks.onClaimed(createdAt, request.slug, emit);

  try {
    await runDeploy(input, emit);
  } catch (e) {
    // runDeploy handles its own failures; reaching here means it threw on the
    // way out. Say so in the log the client is reading, or the deploy stops
    // mid-sentence and the reader waits for an event that never comes.
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "error", message: msg });
    setDeploy(request.slug, { status: "failed", error: msg });
  } finally {
    // Order matters: the events must be durable before the row that let anyone
    // find this run is deleted.
    await sink.drain();
    await finishRun(runId);
    // The build's own ending. Without this the row stays `ended_at: null,
    // outcome: null` forever — the app's timeline claims every build it ever ran
    // is still in flight, and a failure is indistinguishable from a success.
    await finishBuild(runId, watch.outcome);
  }
  return "deployed";
}
