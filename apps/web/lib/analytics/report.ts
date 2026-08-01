import {
  sessionizeAttempts,
  stageDurationMs,
  NESTED_STAGES,
  type Attempt,
  type RawStage,
} from "./attempts";
import {
  bucketKey,
  denseSeries,
  funnel,
  groupBy,
  percentile,
  rate,
  retentionSummary,
  summarize,
  classifyFailure,
  type Bucket,
  type FunnelStep,
  type Granularity,
  type RetentionSummary,
  type Summary,
} from "./metrics";
import type { AppRow, DeployStateRow, ErrorEventRow, FirstDeployRow, UserRow, Window } from "./queries";

/**
 * Everything the page shows, computed from rows and nothing else.
 *
 * Pure so that the awkward cases can be written down as tests rather than
 * waited for: a user who never deployed, a lane nobody used this week, a deploy
 * still running, a database where `deploy_stages` is empty because nobody has
 * ever looked at it. The page then only has to render.
 */

export interface ReportInput {
  users: UserRow[];
  apps: AppRow[];
  stages: RawStage[];
  stagesTruncated: boolean;
  firstDeploys: FirstDeployRow[];
  deployStates: DeployStateRow[];
  errorEvents: ErrorEventRow[];
  oldestEventAt: Date | null;
  slugOwners: Map<string, string>;
  window: Window;
  now: Date;
}

// ─── acquisition ──────────────────────────────────────────────────────────────

export interface Acquisition {
  totalUsers: number;
  newInWindow: number;
  signups: Bucket[];
  granularity: Granularity;
  steps: FunnelStep[];
  /** Users who signed up and never created an app. */
  stalledBeforeApp: number;
  /** Users who created an app that has no recorded deploy stage at all. */
  stalledBeforeDeploy: number;
  /** Users whose deploys all failed. */
  stalledBeforeSuccess: number;
}

/** Day buckets read as noise past about six weeks; weeks read as nothing under two. */
export function granularityFor(days: number): Granularity {
  return days > 45 ? "week" : "day";
}

export function acquisition(input: ReportInput): Acquisition {
  const { users, apps, window, firstDeploys, slugOwners } = input;
  const granularity = granularityFor(window.days);

  const inWindow = users.filter((u) => u.createdAt >= window.from && u.createdAt <= window.to);
  const signups = denseSeries(inWindow.map((u) => u.createdAt), granularity, window.from, window.to);

  const appsByOwner = groupBy(apps, (a) => a.ownerId);
  const firstBySlug = new Map(firstDeploys.map((f) => [f.slug, f]));

  // A user counts as having deployed if any slug attributed to them left a stage
  // row; as having succeeded if any of them recorded a successful `deploy` stage.
  const ownersWithApp = new Set(apps.map((a) => a.ownerId));
  const ownersWithDeploy = new Set<string>();
  const ownersWithSuccess = new Set<string>();
  for (const f of firstDeploys) {
    const owner = slugOwners.get(f.slug);
    if (!owner) continue;
    ownersWithDeploy.add(owner);
    if (f.firstSuccessAt) ownersWithSuccess.add(owner);
  }

  const steps = funnel([
    { label: "signed up", count: users.length },
    { label: "created an app", count: ownersWithApp.size },
    { label: "started a deploy", count: ownersWithDeploy.size },
    { label: "reached a first success", count: ownersWithSuccess.size },
  ]);

  let stalledBeforeApp = 0;
  let stalledBeforeDeploy = 0;
  let stalledBeforeSuccess = 0;
  for (const u of users) {
    const owned = appsByOwner.get(u.id) ?? [];
    if (!owned.length) { stalledBeforeApp++; continue; }
    if (!owned.some((a) => firstBySlug.has(a.slug))) { stalledBeforeDeploy++; continue; }
    if (!ownersWithSuccess.has(u.id)) stalledBeforeSuccess++;
  }

  return {
    totalUsers: users.length,
    newInWindow: inWindow.length,
    signups,
    granularity,
    steps,
    stalledBeforeApp,
    stalledBeforeDeploy,
    stalledBeforeSuccess,
  };
}

// ─── activation ───────────────────────────────────────────────────────────────

export interface Activation {
  activated: number;
  eligible: number;
  rate: number | null;
  /** Signup to first successful deploy, in ms, over the users who got there. */
  lag: Summary | null;
  /** Users whose first success predates the stage table and cannot be timed. */
  untimeable: number;
}

/**
 * How many people reach a first working deploy, and how long it takes them.
 *
 * Measured from signup rather than from first attempt on purpose: the gap
 * between deciding to try this product and having something live is the number
 * that describes the experience. It is also the one that includes the time
 * somebody spent stuck.
 */
export function activation(input: ReportInput): Activation {
  const { users, firstDeploys, slugOwners } = input;

  // The earliest success per owner across all their apps.
  const firstSuccessByOwner = new Map<string, Date>();
  for (const f of firstDeploys) {
    if (!f.firstSuccessAt) continue;
    const owner = slugOwners.get(f.slug);
    if (!owner) continue;
    const known = firstSuccessByOwner.get(owner);
    if (!known || f.firstSuccessAt < known) firstSuccessByOwner.set(owner, f.firstSuccessAt);
  }

  const lags: number[] = [];
  let untimeable = 0;
  for (const u of users) {
    const at = firstSuccessByOwner.get(u.id);
    if (!at) continue;
    const ms = at.getTime() - u.createdAt.getTime();
    // A success recorded before the account existed means the stage rows and the
    // signup date disagree — an app reassigned, or a row from before the table.
    // Counted as activated, excluded from the timing rather than folded in as a
    // negative that would drag the median below anything real.
    if (ms < 0) { untimeable++; continue; }
    lags.push(ms);
  }

  return {
    activated: firstSuccessByOwner.size,
    eligible: users.length,
    rate: rate(firstSuccessByOwner.size, users.length),
    lag: summarize(lags),
    untimeable,
  };
}

// ─── reliability ──────────────────────────────────────────────────────────────

export interface LaneReliability {
  lane: string;
  total: number;
  ok: number;
  failed: number;
  unknown: number;
  rate: number | null;
}

export interface FailureReason {
  reason: string;
  count: number;
}

export interface Reliability {
  attempts: number;
  ok: number;
  failed: number;
  /** Deploys that left no verdict: still running, or died without writing one. */
  unknown: number;
  rate: number | null;
  byLane: LaneReliability[];
  /** Success rate per bucket. `rate` is null in a bucket with no finished deploys. */
  overTime: Array<{ key: string; total: number; ok: number; rate: number | null }>;
  reasonsFromEvents: FailureReason[];
  reasonsFromAppState: FailureReason[];
  repairRuns: number;
  repairHelped: number;
  repairRate: number | null;
  /** Deploys that never chose a lane — refusals and early breakage. */
  neverChoseLane: number;
  truncated: boolean;
}

export function reliability(input: ReportInput, attempts: Attempt[]): Reliability {
  const ok = attempts.filter((a) => a.outcome === "ok").length;
  const failed = attempts.filter((a) => a.outcome === "failed").length;
  const unknown = attempts.filter((a) => a.outcome === "unknown").length;

  // Lanes are listed in the order the product thinks about them, and a lane with
  // no deploys this window is still listed — "nobody used the fast lane" is a
  // finding, and a row that vanishes cannot say it.
  const KNOWN_LANES = ["static", "fast", "runner", "generic"];
  const byLaneMap = groupBy(attempts.filter((a) => a.lane), (a) => a.lane as string);
  const lanes = [...KNOWN_LANES, ...[...byLaneMap.keys()].filter((l) => !KNOWN_LANES.includes(l))];
  const byLane: LaneReliability[] = lanes.map((lane) => {
    const list = byLaneMap.get(lane) ?? [];
    const laneOk = list.filter((a) => a.outcome === "ok").length;
    const laneFailed = list.filter((a) => a.outcome === "failed").length;
    return {
      lane,
      total: list.length,
      ok: laneOk,
      failed: laneFailed,
      unknown: list.length - laneOk - laneFailed,
      rate: rate(laneOk, laneOk + laneFailed),
    };
  });

  const granularity = granularityFor(input.window.days);
  const finished = attempts.filter((a) => a.outcome !== "unknown");
  const perBucket = groupBy(finished, (a) => bucketKey(a.startedAt, granularity));
  const overTime = denseSeries([], granularity, input.window.from, input.window.to).map((b) => {
    const list = perBucket.get(b.key) ?? [];
    const bOk = list.filter((a) => a.outcome === "ok").length;
    return { key: b.key, total: list.length, ok: bOk, rate: rate(bOk, list.length) };
  });

  const repairRuns = attempts.filter((a) => a.repair !== "none").length;
  const repairHelped = attempts.filter((a) => a.repair === "helped").length;

  return {
    attempts: attempts.length,
    ok,
    failed,
    unknown,
    rate: rate(ok, ok + failed),
    byLane,
    overTime,
    reasonsFromEvents: countReasons(input.errorEvents.map((e) => e.message)),
    reasonsFromAppState: countReasons(
      input.deployStates.filter((d) => d.status === "failed").map((d) => d.error),
    ),
    repairRuns,
    repairHelped,
    repairRate: rate(repairHelped, repairRuns),
    neverChoseLane: attempts.filter((a) => a.lane === null).length,
    truncated: input.stagesTruncated,
  };
}

function countReasons(messages: Array<string | null>): FailureReason[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    const reason = classifyFailure(m);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

// ─── speed ────────────────────────────────────────────────────────────────────

export interface StageTiming {
  stage: string;
  n: number;
  p50: number;
  p90: number;
  max: number;
  /** Contained inside another stage, so it must not be added to the rest. */
  nestedIn: string | null;
}

export interface Speed {
  /** Per stage, slowest median first — where the time actually goes. */
  stages: StageTiming[];
  /** Whole deploys, by lane. */
  byLane: Array<{ lane: string; n: number; p50: number; p90: number; max: number }>;
  /** Whole deploys, all lanes. */
  overall: Summary | null;
  /** Medians of the stages that do not nest, added up. */
  medianAccountedMs: number;
}

const NESTED_IN = new Map(NESTED_STAGES.map(([inner, outer]) => [inner, outer]));

export function speed(attempts: Attempt[]): Speed {
  const rows = attempts.flatMap((a) => a.stages);
  const byStage = groupBy(rows, (r) => r.stage);

  const stages: StageTiming[] = [...byStage.entries()]
    .map(([stage, list]) => {
      const durations = list.map(stageDurationMs).filter((d): d is number => d !== null);
      const s = summarize(durations);
      if (!s) return null;
      return { stage, n: s.n, p50: s.p50, p90: s.p90, max: s.max, nestedIn: NESTED_IN.get(stage) ?? null };
    })
    .filter((x): x is StageTiming => x !== null)
    .sort((a, b) => b.p50 - a.p50);

  const laneDurations = groupBy(
    attempts.filter((a) => a.lane && a.durationMs !== null),
    (a) => a.lane as string,
  );
  const byLane = [...laneDurations.entries()]
    .map(([lane, list]) => {
      const s = summarize(list.map((a) => a.durationMs as number))!;
      return { lane, n: s.n, p50: s.p50, p90: s.p90, max: s.max };
    })
    .sort((a, b) => b.p50 - a.p50);

  return {
    stages,
    byLane,
    overall: summarize(attempts.map((a) => a.durationMs).filter((d): d is number => d !== null)),
    // Nested stages are excluded: run-fetch is measured inside job-cold-start, so
    // adding both counts the same seconds twice and produces a total longer than
    // the deploys it describes.
    medianAccountedMs: stages.filter((s) => !s.nestedIn).reduce((sum, s) => sum + s.p50, 0),
  };
}

// ─── retention and depth ──────────────────────────────────────────────────────

export interface Depth {
  retention: RetentionSummary;
  /** Apps owned, per user who owns at least one. */
  appsPerUser: Summary | null;
  appsPerUserHistogram: Array<{ apps: number; users: number }>;
  plans: Array<{ plan: string; count: number }>;
  statuses: Array<{ status: string; count: number }>;
  liveApps: number;
  failedApps: number;
  deployingApps: number;
}

/**
 * Depth, and the honest limit on it.
 *
 * `deploys` keeps one row per app and overwrites it, so the only per-app
 * timestamps that survive are "when the app was created" and "when it last did
 * anything". A user who deployed six times in week three is visible as having
 * returned; the six is not. Retention here therefore means "did anything happen
 * after day seven", which is the question those two columns can answer.
 */
export function depth(input: ReportInput): Depth {
  const { users, apps, deployStates, now } = input;

  const lastActivityBySlug = new Map<string, Date>();
  for (const d of deployStates) {
    const at = d.finishedAt ?? d.updatedAt;
    if (at) lastActivityBySlug.set(d.slug, at);
  }

  const appsByOwner = groupBy(apps, (a) => a.ownerId);
  const retention = retentionSummary(
    users.map((u) => {
      const owned = appsByOwner.get(u.id) ?? [];
      const activity: Date[] = [];
      for (const a of owned) {
        activity.push(a.createdAt);
        const last = lastActivityBySlug.get(a.slug);
        if (last) activity.push(last);
      }
      return { signupAt: u.createdAt, activity };
    }),
    now,
  );

  const counts = [...appsByOwner.values()].map((list) => list.length);
  const histogram = new Map<number, number>();
  for (const c of counts) histogram.set(c, (histogram.get(c) ?? 0) + 1);

  const tally = (values: Array<string | null>, fallback: string) => {
    const m = new Map<string, number>();
    for (const v of values) {
      const k = v ?? fallback;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([k, count]) => ({ k, count })).sort((a, b) => b.count - a.count);
  };

  return {
    retention,
    appsPerUser: summarize(counts),
    appsPerUserHistogram: [...histogram.entries()]
      .map(([appsOwned, userCount]) => ({ apps: appsOwned, users: userCount }))
      .sort((a, b) => a.apps - b.apps),
    plans: tally(users.map((u) => u.plan), "unrecorded").map(({ k, count }) => ({ plan: k, count })),
    statuses: tally(users.map((u) => u.status), "unrecorded").map(({ k, count }) => ({ status: k, count })),
    liveApps: apps.filter((a) => a.status === "live").length,
    failedApps: apps.filter((a) => a.status === "failed").length,
    deployingApps: apps.filter((a) => a.status === "deploying").length,
  };
}

// ─── the whole thing ──────────────────────────────────────────────────────────

export interface Report {
  window: Window;
  now: Date;
  attempts: Attempt[];
  acquisition: Acquisition;
  activation: Activation;
  reliability: Reliability;
  speed: Speed;
  depth: Depth;
  /** How far back the per-deploy error log actually reaches. */
  oldestEventAt: Date | null;
  /** True when the stage read hit its cap and the numbers cover part of the window. */
  truncated: boolean;
  /** Set when the stage table held nothing for the window. */
  noStageData: boolean;
}

export function buildReport(input: ReportInput): Report {
  const attempts = sessionizeAttempts(input.stages);
  return {
    window: input.window,
    now: input.now,
    attempts,
    acquisition: acquisition(input),
    activation: activation(input),
    reliability: reliability(input, attempts),
    speed: speed(attempts),
    depth: depth(input),
    oldestEventAt: input.oldestEventAt,
    truncated: input.stagesTruncated,
    noStageData: input.stages.length === 0,
  };
}

/** Percentile helper re-exported so the page never reaches past this module. */
export { percentile };
