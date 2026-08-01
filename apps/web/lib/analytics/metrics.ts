/**
 * The arithmetic behind the analytics page.
 *
 * Pure and separate from the queries on purpose: these are the parts that can be
 * quietly wrong in a way no amount of staring at a chart reveals. A rate with a
 * zero denominator rendered as "0%", a bar chart that closes up the days nothing
 * happened, a median taken over an array that was never sorted — each of those
 * produces a plausible-looking number, which is worse than an obviously broken
 * one.
 *
 * Everything is UTC. The product deploys from everywhere and its own timestamps
 * are timestamptz; picking a viewer's local midnight would make the same deploy
 * land in different days for different operators.
 */

export type Granularity = "day" | "week";

const DAY_MS = 86_400_000;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The UTC calendar day a moment falls in, as `YYYY-MM-DD`. */
export function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * The Monday of the UTC week a moment falls in, as `YYYY-MM-DD`.
 *
 * Monday rather than Sunday because the weekend is the quiet part of this
 * product's week, and a boundary that cuts through it makes every week look like
 * two half-weeks.
 */
export function weekKey(d: Date): string {
  const day = d.getUTCDay(); // 0 = Sunday
  const backToMonday = (day + 6) % 7;
  return dayKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - backToMonday * DAY_MS));
}

export function bucketKey(d: Date, g: Granularity): string {
  return g === "week" ? weekKey(d) : dayKey(d);
}

export interface Bucket {
  key: string;
  count: number;
}

/**
 * Counts per bucket across a range, including the buckets with nothing in them.
 *
 * The empty ones are the point. A chart drawn only from the days something
 * happened puts a bar next to a bar and reads as steady activity, when what
 * actually happened was two deploys a fortnight apart.
 */
export function denseSeries(dates: Date[], g: Granularity, from: Date, to: Date): Bucket[] {
  const counts = new Map<string, number>();
  for (const d of dates) {
    const k = bucketKey(d, g);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const out: Bucket[] = [];
  const step = g === "week" ? 7 * DAY_MS : DAY_MS;
  // Walk from the start of the bucket `from` lands in, so a range beginning
  // mid-week still produces whole buckets.
  let cursor = Date.parse(`${bucketKey(from, g)}T00:00:00Z`);
  const end = Date.parse(`${bucketKey(to, g)}T00:00:00Z`);
  // A guard, not a limit: a bad range must not spin forever inside a page render.
  for (let i = 0; cursor <= end && i < 5000; i++, cursor += step) {
    const k = dayKey(new Date(cursor));
    out.push({ key: k, count: counts.get(k) ?? 0 });
  }
  return out;
}

/**
 * A proportion, or null when there is nothing to take a proportion of.
 *
 * Null rather than 0 because "0% of users activated" and "no users yet" are
 * different statements, and the first one is a bug report about the product
 * while the second is a bug report about the chart.
 */
export function rate(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return part / whole;
}

/** A rate as a percentage string, or an em dash when there is no rate. */
export function formatRate(r: number | null, digits = 0): string {
  if (r === null) return "—";
  return `${(r * 100).toFixed(digits)}%`;
}

/**
 * The p-th percentile by nearest rank, over values in any order.
 *
 * Nearest rank rather than interpolation: at the handful of deploys a day this
 * product currently sees, an interpolated p90 is a number halfway between two
 * real deploys and belongs to neither. Every value it reports is a duration that
 * actually happened.
 */
export function percentile(values: number[], p: number): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const rank = Math.ceil((p / 100) * clean.length);
  return clean[Math.min(clean.length - 1, Math.max(0, rank - 1))];
}

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
  /** Everything added up. Meaningful only for values that do not overlap. */
  total: number;
}

export function summarize(values: number[]): Summary | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return null;
  return {
    n: clean.length,
    min: Math.min(...clean),
    p50: percentile(clean, 50)!,
    p90: percentile(clean, 90)!,
    max: Math.max(...clean),
    total: clean.reduce((a, b) => a + b, 0),
  };
}

/**
 * Whether a user came back after their first week — and whether it is even
 * possible to say yet.
 *
 * `too-early` is the whole reason this is a function rather than a comparison.
 * A user who signed up on Tuesday cannot have returned in week two, and counting
 * them as "did not return" drags the retention number down by however many
 * people signed up recently — which is to say, it looks worst exactly when
 * acquisition is going best.
 */
export type RetentionVerdict = "returned" | "did-not-return" | "too-early";

export function weekOneVerdict(
  signupAt: Date,
  activity: Date[],
  now: Date,
  windowDays = 7,
): RetentionVerdict {
  const boundary = signupAt.getTime() + windowDays * DAY_MS;
  if (activity.some((a) => a.getTime() > boundary)) return "returned";
  if (now.getTime() <= boundary) return "too-early";
  return "did-not-return";
}

export interface RetentionSummary {
  returned: number;
  didNotReturn: number;
  /** Users who have not been signed up long enough to answer the question. */
  tooEarly: number;
  /** Over those who could have returned. Null when nobody could have yet. */
  rate: number | null;
}

export function retentionSummary(
  users: Array<{ signupAt: Date; activity: Date[] }>,
  now: Date,
  windowDays = 7,
): RetentionSummary {
  let returned = 0;
  let didNotReturn = 0;
  let tooEarly = 0;
  for (const u of users) {
    const v = weekOneVerdict(u.signupAt, u.activity, now, windowDays);
    if (v === "returned") returned++;
    else if (v === "did-not-return") didNotReturn++;
    else tooEarly++;
  }
  return { returned, didNotReturn, tooEarly, rate: rate(returned, returned + didNotReturn) };
}

export interface FunnelStep {
  label: string;
  count: number;
  /** Share of the step above. Null for the first step and for a zero above. */
  ofPrevious: number | null;
  /** Share of the first step. Null for a zero top. */
  ofTop: number | null;
  /** How many were lost between the step above and this one. */
  lost: number;
}

/**
 * A funnel from counts that are already nested — each step a subset of the one
 * above it.
 *
 * It does not enforce that nesting, because the queries feeding it cannot always
 * guarantee it (a user can own an app with no recorded deploy stages, which is
 * how a step can exceed the one above). Where that happens the drop is reported
 * as zero rather than as a negative loss, and the page says so.
 */
export function funnel(steps: Array<{ label: string; count: number }>): FunnelStep[] {
  const top = steps[0]?.count ?? 0;
  return steps.map((s, i) => {
    const prev = i === 0 ? null : steps[i - 1].count;
    return {
      label: s.label,
      count: s.count,
      ofPrevious: prev === null ? null : rate(s.count, prev),
      ofTop: i === 0 ? (top > 0 ? 1 : null) : rate(s.count, top),
      lost: prev === null ? 0 : Math.max(0, prev - s.count),
    };
  });
}

/** A duration for a human. Null reads as an em dash, never as zero. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  // Days past two of them. Time-to-first-success is measured from signup and is
  // routinely a fortnight, which this rendered as "350h 30m" — a number nobody
  // can read without dividing. Two days rather than one, so "36h 20m" still
  // reads as the long afternoon it describes.
  if (h < 48) return `${h}h ${m - h * 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h - d * 24}h`;
}

/**
 * Group values by a key, keeping the key order stable.
 *
 * Used everywhere the page breaks a metric down by lane or by reason. Lifted out
 * because doing it inline four times is how one of them ends up sorted by count
 * and the others by name.
 */
export function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/**
 * The shape of a failure, from the text of one.
 *
 * Deploy errors are prose written at a dozen call sites, so the only honest
 * grouping is a coarse one over patterns that are actually stable — the ones the
 * pipeline itself formats. Anything unrecognised stays "other" rather than being
 * bucketed by a guess; a failure taxonomy that quietly absorbs new failures into
 * an existing bucket is how a regression goes unnoticed.
 */
export function classifyFailure(error: string | null | undefined): string {
  const e = (error ?? "").toLowerCase();
  if (!e.trim()) return "unrecorded";
  if (/cannot tell what this app is|declares .* and .*, and planning/.test(e)) return "refused: ambiguous repo";
  if (/didn'?t start on|failed to start and listen|container failed to start/.test(e)) return "container did not start";
  // `sh: 1: fastapi: not found` is the shell's own form and the most common way
  // a wrong lane shows up. The colon is what keeps it apart from "repository not
  // found", which is a different failure with a different fix.
  if (/missing script|command not found|:\s*not found|exit 127/.test(e)) return "run command wrong";
  if (/build failed|npm err|pip install|uv sync/.test(e)) return "build failed";
  if (/permission|denied|403|iam|forbidden/.test(e)) return "platform: permission";
  if (/quota|429|rate limit|resource exhausted/.test(e)) return "platform: quota";
  if (/timed out|timeout|deadline/.test(e)) return "timed out";
  if (/stopped reporting|never finished/.test(e)) return "deploy went silent";
  if (/clone|repository not found|404.*git/.test(e)) return "could not fetch the code";
  return "other";
}
