import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * `recordNodeRunning`'s new half: turning a node's one-shot pull/boot
 * timing (services/fleet/agent/desired.go's ProcessState.PullMs/BootMs) into
 * deploy_stages rows, against a recorded pool.
 *
 * The three properties this ticket's acceptance criteria and the "never fail
 * or slow a deploy" constraint actually require:
 *   1. A row with pullMs/bootMs produces two deploy_stages inserts, split
 *      into their own stage names — never one row covering both.
 *   2. A node may only write timing for a slug it is actually placed on —
 *      the same fleet_placements authorization recordNodeRunning already
 *      gives the running-report itself, so a stray or forged node cannot
 *      pollute another node's numbers.
 *   3. A write failure here (a broken sink) is swallowed, never thrown out
 *      of recordNodeRunning — because a telemetry problem must not read as
 *      the running-report itself having failed, and must not stop a
 *      SIBLING row (a different stage, or a different process) from being
 *      attempted.
 */

interface Recorded { sql: string; params: unknown[] }
let queries: Recorded[] = [];
let placedSlugs: string[] = [];
let failDeployStagesInsert = false;

mock.module("../lib/db", {
  namedExports: {
    getPool: () => ({
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (/SELECT slug FROM fleet_placements/.test(sql)) {
          return { rows: placedSlugs.map((slug) => ({ slug })), rowCount: placedSlugs.length };
        }
        if (failDeployStagesInsert && /INSERT INTO deploy_stages/.test(sql)) {
          throw new Error("deploy_stages is down");
        }
        return { rows: [], rowCount: 0 };
      },
    }),
    dbNameForSlug: (s: string) => s,
  },
});

let loaded: Promise<typeof import("../lib/fleet")> | null = null;
const recordNodeRunning = async (...a: Parameters<typeof import("../lib/fleet")["recordNodeRunning"]>) =>
  (await (loaded ??= import("../lib/fleet"))).recordNodeRunning(...a);

function reset() {
  queries = [];
  placedSlugs = [];
  failDeployStagesInsert = false;
}

function deployStagesInserts(): Recorded[] {
  return queries.filter((q) => /INSERT INTO deploy_stages/.test(q.sql));
}

test("a placed process's pull and boot timing become two deploy_stages rows", async () => {
  reset();
  placedSlugs = ["demo"];

  await recordNodeRunning("fleet-lab-1", [
    { slug: "demo", process: "web", image: "img", pullMs: 2500, bootMs: 900 },
  ]);

  const inserts = deployStagesInserts();
  assert.equal(inserts.length, 2, `want one insert per stage, got ${inserts.length}`);

  const byStage = new Map(inserts.map((q) => [q.params[2] as string, q]));
  assert.ok(byStage.has("fleet-pull"), "no fleet-pull row was written");
  assert.ok(byStage.has("fleet-boot"), "no fleet-boot row was written");

  const pull = byStage.get("fleet-pull")!;
  // params: [slug, lane, stage, startedAt, endedAt, outcome, runtime, cold, runId]
  assert.equal(pull.params[0], "demo");
  assert.equal(pull.params[1], "unknown", "lane must be the honest 'unknown', not guessed");
  assert.equal(pull.params[5], "ok");
  assert.equal(pull.params[8], null, "runId must be null — the node has no notion of a deploy attempt");
  const startedAt = pull.params[3] as Date;
  const endedAt = pull.params[4] as Date;
  assert.equal(endedAt.getTime() - startedAt.getTime(), 2500, "the row's own span must equal pullMs");

  const boot = byStage.get("fleet-boot")!;
  const bStarted = boot.params[3] as Date;
  const bEnded = boot.params[4] as Date;
  assert.equal(bEnded.getTime() - bStarted.getTime(), 900, "the row's own span must equal bootMs");
});

test("a report with no timing writes no deploy_stages rows", async () => {
  reset();
  placedSlugs = ["demo"];

  await recordNodeRunning("fleet-lab-1", [{ slug: "demo", process: "web", image: "img" }]);

  assert.equal(deployStagesInserts().length, 0, "an ordinary re-confirmation must not write timing rows");
});

test("a node cannot write timing for a slug it is not placed on", async () => {
  reset();
  placedSlugs = []; // "demo" is not placed on this node

  await recordNodeRunning("fleet-lab-1", [
    { slug: "demo", process: "web", image: "img", pullMs: 1000, bootMs: 1000 },
  ]);

  assert.equal(deployStagesInserts().length, 0, "an unplaced slug's timing must be rejected, same as recordNodeRunning's own rows");
});

test("only pullMs present still writes only the pull row", async () => {
  reset();
  placedSlugs = ["demo"];

  await recordNodeRunning("fleet-lab-1", [{ slug: "demo", process: "web", image: "img", pullMs: 4200 }]);

  const inserts = deployStagesInserts();
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].params[2], "fleet-pull");
});

test("a broken deploy_stages sink does not fail recordNodeRunning or block a sibling row", async () => {
  reset();
  placedSlugs = ["demo", "other"];
  failDeployStagesInsert = true;

  // Must not throw — telemetry may never fail a deploy, and recordNodeRunning's
  // own job (the running-report upsert, asserted below) must still happen.
  await recordNodeRunning("fleet-lab-1", [
    { slug: "demo", process: "web", image: "img", pullMs: 1000, bootMs: 1000 },
    { slug: "other", process: "web", image: "img", pullMs: 1000, bootMs: 1000 },
  ]);

  const upserts = queries.filter((q) => /INSERT INTO fleet_process_running/.test(q.sql));
  assert.equal(upserts.length, 1, "the running-report upsert must still run even though every stage write failed");
});
