export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import Link from "next/link";
import { currentAdminEmail } from "@/lib/admin";
import { buildReport } from "@/lib/analytics/report";
import { formatRate, formatDuration } from "@/lib/analytics/metrics";
import * as q from "@/lib/analytics/queries";
import {
  Caveat,
  CountBars,
  Funnel,
  OutcomeBar,
  RankedBars,
  RateBars,
  Section,
  StatTile,
  Table,
} from "@/components/AnalyticsCharts";

/**
 * The operators' view of whether this product is working for the people using it.
 *
 * Server-rendered and read-only. The gate is `currentAdminEmail()`, which is the
 * sign-in allowlist's own matcher over a separate table — see `lib/admin.ts`.
 * A caller who is not an operator gets a 404 rather than a 403: there is no
 * reason to confirm to a stranger that this page exists.
 *
 * The design rule for everything below: a number that could mislead carries the
 * reason next to it. Most of the caveats here are not stylistic — they are
 * consequences of how the tables were built, and an operator who does not know
 * them will read the page wrongly. In particular `deploys` holds one row per app
 * and overwrites it, so it can say what went wrong last but never how often.
 */

const WINDOWS = [7, 30, 90] as const;

function parseDays(raw: string | string[] | undefined): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return WINDOWS.includes(n as (typeof WINDOWS)[number]) ? n : 30;
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const operator = await currentAdminEmail();
  if (!operator) notFound();

  const days = parseDays(searchParams.days);
  const now = new Date();
  const window = q.windowOf(days, now);

  const [users, apps, stages, firstDeploys, deployStates, errorEvents, oldestEventAt] = await Promise.all([
    q.users(),
    q.apps(),
    q.stages(window),
    q.firstDeploys(),
    q.deployStates(),
    q.errorEvents(window),
    q.oldestEventAt(),
  ]);

  const slugOwners = new Map<string, string>();
  for (const d of deployStates) if (d.ownerId) slugOwners.set(d.slug, d.ownerId);
  for (const a of apps) slugOwners.set(a.slug, a.ownerId);

  const r = buildReport({
    users,
    apps,
    stages: stages.rows,
    stagesTruncated: stages.truncated,
    firstDeploys,
    deployStates,
    errorEvents,
    oldestEventAt,
    slugOwners,
    window,
    now,
  });

  const { acquisition: acq, activation: act, reliability: rel, speed: spd, depth: dep } = r;

  return (
    <div className="shell">
      <div className="main">
        <div className="scroll">
          <div className="an-page">
            <header className="an-head">
              <div>
                <h2>Product analytics</h2>
                <p>
                  Who is using Supersonic and whether it is working for them. Read-only, from the
                  production database. Signed in as <span className="mono">{operator}</span>.
                </p>
              </div>
              <nav className="an-range">
                {WINDOWS.map((d) => (
                  <Link key={d} href={`/admin/analytics?days=${d}`} className={"an-range-btn" + (d === days ? " active" : "")}>
                    {d}d
                  </Link>
                ))}
              </nav>
            </header>

            {r.truncated && (
              <div className="an-warn">
                The stage read hit its {q.ROW_CAP.toLocaleString()}-row cap. Everything under Reliability and
                Speed describes part of this window, not all of it.
              </div>
            )}

            <div className="an-tiles">
              <StatTile label="users" value={String(acq.totalUsers)} sub={`${acq.newInWindow} in the last ${days} days`} />
              <StatTile
                label="reached a working deploy"
                value={formatRate(act.rate)}
                sub={`${act.activated} of ${act.eligible} accounts, all time`}
                hint="A user counts once they have any app with a successful deploy stage recorded."
              />
              <StatTile
                label="deploy success rate"
                value={formatRate(rel.rate)}
                sub={`${rel.ok} of ${rel.ok + rel.failed} finished deploys · last ${days} days`}
                hint="Deploys that left no verdict are excluded from the denominator rather than counted as failures."
              />
              <StatTile
                label="median deploy"
                value={formatDuration(spd.overall?.p50 ?? null)}
                sub={spd.overall ? `p90 ${formatDuration(spd.overall.p90)} · n=${spd.overall.n}` : "no finished deploys"}
              />
              <StatTile
                label="live apps"
                value={String(dep.liveApps)}
                sub={`${dep.deployingApps} deploying · ${dep.failedApps} failed`}
              />
            </div>

            {r.noStageData && (
              <div className="an-warn">
                <b>deploy_stages held nothing for this window.</b> Reliability and Speed below are
                empty for that reason, not because every deploy succeeded instantly. Widen the range,
                or check that the control plane is writing stages.
              </div>
            )}

            {/* ── Acquisition ─────────────────────────────────────────────── */}
            <Section title="Acquisition" blurb="Who arrives, and where they stop.">
              <div className="an-panel">
                <div className="an-panel-title">
                  Signups, by {acq.granularity} · {acq.newInWindow} in this window
                </div>
                <CountBars series={acq.signups} unit="signups" />
              </div>

              <div className="an-panel">
                <div className="an-panel-title">From signing up to something that works</div>
                <Funnel steps={acq.steps} />
                <Caveat>
                  All time, not this window — a funnel over 30 days counts people who signed up
                  before it as though they never got anywhere. &ldquo;Started a deploy&rdquo; means the app left a
                  row in <span className="mono">deploy_stages</span>; apps deployed before that table
                  existed are invisible here and drag this step down.
                </Caveat>
              </div>

              <div className="an-panel">
                <div className="an-panel-title">Where accounts stall</div>
                <Table
                  columns={["stalled at", "users", "what it means"]}
                  rows={[
                    ["never created an app", acq.stalledBeforeApp, "signed in and left"],
                    ["app, but no deploy recorded", acq.stalledBeforeDeploy, "reserved a slug, never got a deploy running"],
                    ["deployed, never succeeded", acq.stalledBeforeSuccess, "tried and could not get it live"],
                  ]}
                  emptyText="No users yet."
                />
                <Caveat>
                  The third row is the one to act on: those are people who used the product as
                  intended and it did not work for them.
                </Caveat>
              </div>
            </Section>

            {/* ── Activation ──────────────────────────────────────────────── */}
            <Section title="Activation" blurb="How many get to a first working deploy, and how long it takes.">
              <div className="an-panel">
                <div className="an-tiles inner">
                  <StatTile label="activated" value={`${act.activated}`} sub={`of ${act.eligible} accounts · ${formatRate(act.rate)}`} />
                  <StatTile
                    label="median time to first success"
                    value={formatDuration(act.lag?.p50 ?? null)}
                    sub={act.lag ? `p90 ${formatDuration(act.lag.p90)} · n=${act.lag.n}` : "nobody has activated yet"}
                  />
                  <StatTile
                    label="fastest"
                    value={formatDuration(act.lag?.min ?? null)}
                    sub={act.lag ? `slowest ${formatDuration(act.lag.max)}` : "—"}
                  />
                </div>
                <Caveat>
                  Timed from <b>signing up</b>, not from the first deploy attempt — so it includes the
                  time somebody spent stuck, which is the point. It also includes time they spent not
                  using the product at all, so a large median means &ldquo;they came back days later&rdquo; at
                  least as often as it means &ldquo;the deploy was slow&rdquo;; the Speed section below is the
                  one that measures the deploy.
                  {act.untimeable > 0 && (
                    <> {act.untimeable} account{act.untimeable === 1 ? " has a success" : "s have successes"} recorded
                    before the account existed and {act.untimeable === 1 ? "is" : "are"} counted as activated but left out of the timings.</>
                  )}
                </Caveat>
              </div>
            </Section>

            {/* ── Reliability ─────────────────────────────────────────────── */}
            <Section title="Reliability" blurb={`Do deploys work? Last ${days} days.`}>
              <div className="an-panel">
                <div className="an-panel-title">{rel.attempts} deploys in this window</div>
                <OutcomeBar ok={rel.ok} failed={rel.failed} unknown={rel.unknown} />
                <Caveat>
                  A deploy here is one thing a person started, not one push to Cloud Run: the repair
                  agent redeploys inside the same deploy, so counting rows would count its retries as
                  separate deploys and overstate both the total and the failures. &ldquo;No verdict&rdquo; is a
                  deploy still running, or one whose process died without writing an outcome — they
                  are excluded from the rate rather than counted as failures.
                </Caveat>
              </div>

              <div className="an-panel">
                <div className="an-panel-title">Success rate over time</div>
                <RateBars series={rel.overTime} />
              </div>

              <div className="an-panel">
                <div className="an-panel-title">By lane</div>
                <Table
                  columns={["lane", "deploys", "succeeded", "failed", "rate"]}
                  rows={rel.byLane.map((l) => [l.lane, l.total, l.ok, l.failed, formatRate(l.rate)])}
                  emptyText="No deploys recorded."
                />
                <Caveat>
                  {rel.neverChoseLane > 0 && (
                    <>
                      <b>{rel.neverChoseLane}</b> deploy{rel.neverChoseLane === 1 ? "" : "s"} never got as far as
                      choosing a lane — a refusal, or a failure during clone or detect — and {rel.neverChoseLane === 1 ? "is" : "are"} in
                      none of these rows.{" "}
                    </>
                  )}
                  The lane is read from the stages recorded after the pipeline picks one. Everything
                  before that point is written as <span className="mono">generic</span> because the lane
                  is not known yet, so a lane read off an early row would file every static deploy
                  under generic.
                </Caveat>
              </div>

              <div className="an-panel">
                <div className="an-panel-title">The repair agent</div>
                <div className="an-tiles inner">
                  <StatTile label="ran on" value={`${rel.repairRuns}`} sub={`of ${rel.attempts} deploys`} />
                  <StatTile label="rescued the deploy" value={formatRate(rel.repairRate)} sub={`${rel.repairHelped} of ${rel.repairRuns}`} />
                </div>
                <Caveat>
                  A deploy the agent rescued counts as a success above — it is the last thing that
                  runs, so it gets the last word. This panel is how to tell how much of the success
                  rate is being bought by it.
                </Caveat>
              </div>

              <div className="an-panel">
                <div className="an-panel-title">Why deploys failed — from the per-deploy event log</div>
                <RankedBars
                  rows={rel.reasonsFromEvents.map((f) => ({ label: f.reason, value: f.count, display: String(f.count) }))}
                  emptyText="No failure events in this window."
                />
                <Caveat>
                  One row per failed deploy, which makes this the only source that can say how <i>often</i>{" "}
                  something goes wrong. It is also the shortest-lived: <span className="mono">pruneEvents</span>{" "}
                  drops anything older than {q.EVENT_RETENTION_DAYS} days, so
                  {oldestEventAt ? (
                    <> the log currently reaches back only to {oldestEventAt.toISOString().slice(0, 10)}</>
                  ) : (
                    <> the log is empty</>
                  )}
                  {days > q.EVENT_RETENTION_DAYS && <>, well short of the {days}-day range selected above</>}.
                </Caveat>
              </div>

              <div className="an-panel">
                <div className="an-panel-title">Why apps are currently broken — from the latest state per app</div>
                <RankedBars
                  rows={rel.reasonsFromAppState.map((f) => ({ label: f.reason, value: f.count, display: String(f.count) }))}
                  emptyText="No apps are in a failed state."
                />
                <Caveat>
                  <span className="mono">deploys</span> holds one row per app and overwrites it on every
                  deploy, so this is <b>what is wrong with each app right now</b> — not a count of how
                  often that happens. An app that failed forty times and then worked contributes
                  nothing here. Do not add these to the numbers above.
                </Caveat>
              </div>
            </Section>

            {/* ── Speed ───────────────────────────────────────────────────── */}
            <Section title="Speed" blurb="Where a deploy's time goes. Nobody had looked at this table before.">
              <div className="an-panel">
                <div className="an-panel-title">Stages, slowest median first</div>
                <RankedBars
                  rows={spd.stages.map((s) => ({
                    label: s.stage,
                    value: s.p50,
                    display: formatDuration(s.p50),
                    note: `n=${s.n} · p90 ${formatDuration(s.p90)}${s.nestedIn ? ` · inside ${s.nestedIn}` : ""}`,
                  }))}
                  emptyText="No stage timings recorded in this window."
                />
                {spd.stages.length > 0 && (
                  <Caveat>
                    Each stage&rsquo;s median is taken over the deploys that <i>recorded that stage</i>, so
                    the rows describe different deploys and are not a breakdown of one.{" "}
                    <span className="mono">n=</span> is how many deploys each is over — a stage with a
                    large median and a small <span className="mono">n</span> is not where most deploys
                    spend their time.{" "}
                    {spd.accounted && spd.overall && (
                      <>
                        Summed <i>within</i> each deploy, recorded stages account for a median of{" "}
                        <b>{formatDuration(spd.accounted.p50)}</b> of a median{" "}
                        <b>{formatDuration(spd.overall.p50)}</b> deploy; the rest is time no stage is
                        watching.{" "}
                      </>
                    )}
                    Stages marked <span className="mono">inside</span> are measured within another —{" "}
                    <span className="mono">run-fetch</span> happens during{" "}
                    <span className="mono">job-cold-start</span> — and are excluded from that total,
                    because adding them would count the same seconds twice.
                  </Caveat>
                )}
              </div>

              <div className="an-panel">
                <div className="an-panel-title">Whole deploys, by lane</div>
                <Table
                  columns={["lane", "deploys", "median", "p90", "slowest"]}
                  rows={spd.byLane.map((l) => [l.lane, l.n, formatDuration(l.p50), formatDuration(l.p90), formatDuration(l.max)])}
                  emptyText="No finished deploys with a known lane."
                />
                <Caveat>
                  First stage to last stage, which is server-side time. It is not what a user waits:
                  the CLI returns in about a second and the build continues without them.
                </Caveat>
              </div>
            </Section>

            {/* ── Retention and depth ─────────────────────────────────────── */}
            <Section title="Retention and depth" blurb="Do people come back, and how much do they build?">
              <div className="an-panel">
                <div className="an-panel-title">Still active after week one</div>
                <div className="an-tiles inner">
                  <StatTile label="came back" value={formatRate(dep.retention.rate)} sub={`${dep.retention.returned} of ${dep.retention.returned + dep.retention.didNotReturn}`} />
                  <StatTile label="did not" value={String(dep.retention.didNotReturn)} />
                  <StatTile label="too new to say" value={String(dep.retention.tooEarly)} sub="signed up under 7 days ago" />
                </div>
                <Caveat>
                  The rate is over the people who <i>could</i> have come back. Someone who signed up on
                  Tuesday cannot have returned in week two, and counting them as churned would make
                  this number look worst exactly when signups look best.
                  {" "}Activity means an app created or a deploy recorded after day seven. Because{" "}
                  <span className="mono">deploys</span> keeps only the latest timestamp per app, a user
                  who deployed six times in week three shows up as having returned, but the six does not.
                </Caveat>
              </div>

              <div className="an-panel">
                <div className="an-panel-title">Apps per user</div>
                <Table
                  columns={["apps owned", "users"]}
                  rows={dep.appsPerUserHistogram.map((h) => [h.apps, h.users])}
                  emptyText="Nobody owns an app yet."
                />
                {dep.appsPerUser && (
                  <Caveat>
                    Median {dep.appsPerUser.p50}, most {dep.appsPerUser.max}, over the{" "}
                    {dep.appsPerUser.n} account{dep.appsPerUser.n === 1 ? "" : "s"} that own at least one.
                    The {acq.stalledBeforeApp} account{acq.stalledBeforeApp === 1 ? "" : "s"} with no app
                    at all {acq.stalledBeforeApp === 1 ? "is" : "are"} not in this distribution — they are
                    in Acquisition.
                  </Caveat>
                )}
              </div>

              <div className="an-panel">
                <div className="an-panel-title">Plans and subscription status</div>
                <div className="an-two">
                  <Table columns={["plan", "users"]} rows={dep.plans.map((p) => [p.plan, p.count])} emptyText="No users." />
                  <Table columns={["status", "users"]} rows={dep.statuses.map((s) => [s.status, s.count])} emptyText="No users." />
                </div>
                <Caveat>
                  The stored columns, not what anyone is actually charged. With{" "}
                  <span className="mono">GATING_ENABLED</span> off, everyone is treated as Pro whatever
                  this says; at least one row here was set by hand for testing.
                </Caveat>
              </div>
            </Section>

            <footer className="an-foot">
              <p>
                Window {window.from.toISOString().slice(0, 16).replace("T", " ")} to{" "}
                {window.to.toISOString().slice(0, 16).replace("T", " ")} UTC. All dates are UTC.
                Every query on this page runs inside a read-only transaction.
              </p>
              {!r.noStageData && (
                <p>
                  Reliability and Speed are reconstructed from {stages.rows.length.toLocaleString()} stage
                  rows; that table has no run id, so deploys are grouped by their{" "}
                  <span className="mono">run-record</span> marker and, where there is none, by a
                  30-minute silence.
                </p>
              )}
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
}
