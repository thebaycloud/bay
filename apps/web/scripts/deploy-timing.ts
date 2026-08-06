/**
 * Where deploy time goes, from `deploy_stages`.
 *
 * Committed rather than run ad hoc so the before and after numbers come from
 * identical SQL. Any error in it is then present on both sides and cancels;
 * a query retyped from memory a fortnight later is a different measurement
 * wearing the same name.
 *
 * Run: npm run timing [days]   (defaults to 14)
 */
import { getPool } from "@/lib/db";
import { ATTEMPT_START_STAGE, ACTIVATION_STAGE, NODE_RESTART_STAGES } from "@/lib/stage-names";

const DB = "supersonic_platform";
const days = Number(process.argv[2] || 14);

/**
 * One deploy's rows.
 *
 * `run_id` is the real answer and 018 added it, but every row written before
 * that has none. The fallback splits a slug's rows at each ATTEMPT_START_STAGE,
 * which is what that stage is for. It does NOT extend an attempt to the start of
 * the next one — the end is the last stage's own end — so idle time between
 * deploys is never counted.
 *
 * Limit: a deploy that wrote no ATTEMPT_START_STAGE — anything predating the
 * job handoff — merges into the attempt before it rather than splitting off.
 * That is why the spec treats this reconstructed per-deploy total as good to
 * about ±15%, while the single-stage numbers above are exact.
 *
 * NODE_RESTART_STAGES are excluded before any of this runs. Both are written
 * with no run_id, off the node's own sync, on every successful process start
 * — a crash-loop restart or a node reboot as much as a deploy — so leaving
 * them in would fold a restart's row into whichever attempt bucket the
 * running window-count last landed on, dragging that deploy's `t1` forward
 * to whenever the restart happened. See lib/stage-names.ts for the fuller
 * account.
 */
const ATTEMPTS = `
  WITH marked AS (
    SELECT *,
      COALESCE(run_id, 'w:' || slug || ':' || sum(CASE WHEN stage = '${ATTEMPT_START_STAGE}' THEN 1 ELSE 0 END)
        OVER (PARTITION BY slug ORDER BY started_at ROWS UNBOUNDED PRECEDING)) AS deploy_key
    FROM deploy_stages
    WHERE started_at > now() - ($1 || ' days')::interval
      AND stage NOT IN (${NODE_RESTART_STAGES.map((s) => `'${s}'`).join(", ")})),
  att AS (
    SELECT deploy_key, min(started_at) AS t0, max(COALESCE(ended_at, started_at)) AS t1,
      bool_or(stage = 'repair-agent') AS had_repair,
      bool_or(outcome = 'failed') AS had_failure,
      bool_or(stage = '${ACTIVATION_STAGE}' AND outcome = 'ok') AS went_live,
      (array_agg(lane ORDER BY started_at DESC) FILTER (WHERE lane <> 'unknown'))[1] AS lane
    FROM marked GROUP BY deploy_key)`;

async function main() {
  const pool = getPool(DB);
  const show = async (label: string, sql: string) => {
    const { rows } = await pool.query(sql, [days]);
    console.log(`\n### ${label}`);
    rows.length ? console.table(rows) : console.log("(no rows)");
  };

  // Every deploy that wrote the stage, happy path or not — this is how the
  // 104.4s baseline in the spec was computed, and the comparison must match it.
  await show("Stage durations, all deploys", `
    SELECT stage, count(*) AS n,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM ended_at-started_at)))::numeric,1) AS p50_s,
      round((percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM ended_at-started_at)))::numeric,1) AS p90_s
    FROM deploy_stages
    WHERE started_at > now() - ($1 || ' days')::interval AND ended_at IS NOT NULL
    GROUP BY stage HAVING count(*) > 1 ORDER BY p50_s DESC`);

  await show("Per-deploy total, happy path only", `${ATTEMPTS}
    SELECT COALESCE(lane,'(none)') AS lane, count(*) AS deploys,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM t1-t0)))::numeric,1) AS p50_s,
      round((percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM t1-t0)))::numeric,1) AS p90_s
    FROM att WHERE went_live AND NOT had_repair AND NOT had_failure
    GROUP BY 1 ORDER BY deploys DESC`);

  await show("How many deploys carry a real run id yet", `
    SELECT count(*) FILTER (WHERE run_id IS NOT NULL) AS with_run_id,
      count(*) FILTER (WHERE run_id IS NULL) AS reconstructed
    FROM deploy_stages WHERE started_at > now() - ($1 || ' days')::interval`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
