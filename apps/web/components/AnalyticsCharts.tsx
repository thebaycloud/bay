import { formatDuration, formatRate, type Bucket, type FunnelStep } from "@/lib/analytics/metrics";

/**
 * The pieces the analytics page is drawn with.
 *
 * All server components and all plain HTML: bars are divs, so they reflow with
 * the page and need no viewBox arithmetic, and the whole page ships as HTML with
 * no client JavaScript at all. Hover text is a `title` attribute for the same
 * reason — it works before hydration because there is no hydration.
 *
 * Two rules run through everything here, and both come from the data rather than
 * from taste:
 *
 * - **Null is not zero.** Every number that can be absent renders as "—", and a
 *   bucket with nothing in it renders as a baseline tick rather than a zero-height
 *   bar. A zero bar and an empty bar look identical and mean opposite things.
 * - **Success and failure are never distinguished by colour alone.** Green and
 *   red sit at ΔE 5.8 under deuteranopia — indistinguishable to roughly one man
 *   in twelve — so every outcome carries its own text label, and the failure
 *   fill is hatched as well as coloured.
 */

export function StatTile({
  label,
  value,
  sub,
  hint,
}: {
  label: string;
  value: string;
  sub?: string;
  hint?: string;
}) {
  return (
    <div className="an-tile" title={hint}>
      <div className="an-tile-label">{label}</div>
      <div className="an-tile-value">{value}</div>
      {sub && <div className="an-tile-sub">{sub}</div>}
    </div>
  );
}

/** A note attached to a number, for the places where it can mislead. */
export function Caveat({ children }: { children: React.ReactNode }) {
  return <p className="an-caveat">{children}</p>;
}

/**
 * One panel of the page.
 *
 * `error` replaces the contents rather than sitting beside them. A chart drawn
 * from a failed read is a chart of nothing, and an operator would read it as a
 * quiet week — which is the single confusion this page must not create.
 */
export function Panel({
  title,
  error,
  children,
}: {
  title: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="an-panel">
      <div className="an-panel-title">{title}</div>
      {error ? <PanelError message={error} /> : children}
    </div>
  );
}

export function Section({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="an-section">
      <div className="an-section-head">
        <h3>{title}</h3>
        {blurb && <p>{blurb}</p>}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="an-empty">{children}</div>;
}

/**
 * A panel whose data could not be read.
 *
 * Rendered INSTEAD of the panel's chart, never beside it — a chart drawn from a
 * failed read is a chart of nothing, and an operator would read it as a quiet
 * week. The database's own words are shown verbatim because they name the
 * defect: "column deploys.finished_at does not exist" is actionable in a way
 * that "something went wrong" is not.
 */
export function PanelError({ message }: { message: string }) {
  return (
    <div className="an-panel-error">
      <div className="an-panel-error-head">This panel could not be read.</div>
      <div className="an-panel-error-msg mono">{message}</div>
      <div className="an-panel-error-note">
        This is not &ldquo;no activity&rdquo; — the query failed. Nothing here should be read as a
        measurement.
      </div>
    </div>
  );
}

/** Counts over time. Every bucket in the range is present, including the empty ones. */
export function CountBars({ series, unit }: { series: Bucket[]; unit: string }) {
  const max = Math.max(1, ...series.map((b) => b.count));
  const total = series.reduce((n, b) => n + b.count, 0);
  return (
    <div className="an-chart">
      <div className="an-bars" role="img" aria-label={`${unit} per bucket, ${total} in total`}>
        {series.map((b) => (
          <div key={b.key} className="an-bar-slot" title={`${b.key}: ${b.count} ${unit}`}>
            <div
              className={"an-bar" + (b.count === 0 ? " zero" : "")}
              style={{ height: b.count === 0 ? "1px" : `${Math.max(2, (b.count / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="an-axis">
        <span>{series[0]?.key ?? ""}</span>
        <span className="an-axis-max">peak {max}</span>
        <span>{series[series.length - 1]?.key ?? ""}</span>
      </div>
    </div>
  );
}

/**
 * A rate over time.
 *
 * A bucket where nothing finished has no rate, and is drawn as a baseline tick
 * rather than as 0%. Drawing it as zero would report a total outage on every
 * quiet day.
 */
export function RateBars({ series }: { series: Array<{ key: string; total: number; ok: number; rate: number | null }> }) {
  return (
    <div className="an-chart">
      <div className="an-bars" role="img" aria-label="deploy success rate per bucket">
        {series.map((b) => (
          <div
            key={b.key}
            className="an-bar-slot"
            title={b.rate === null ? `${b.key}: no deploys finished` : `${b.key}: ${b.ok}/${b.total} succeeded (${formatRate(b.rate)})`}
          >
            {b.rate === null ? (
              <div className="an-bar none" style={{ height: "1px" }} />
            ) : (
              <div className="an-bar good" style={{ height: `${Math.max(2, b.rate * 100)}%` }} />
            )}
          </div>
        ))}
      </div>
      <div className="an-axis">
        <span>{series[0]?.key ?? ""}</span>
        <span className="an-axis-max">100% at full height · a flat line means no deploys that day</span>
        <span>{series[series.length - 1]?.key ?? ""}</span>
      </div>
    </div>
  );
}

/**
 * Horizontal bars for a ranked list — stages by median, failures by count.
 *
 * Every row is directly labelled, because the list is short enough that a legend
 * and an axis would both be indirection.
 */
export function RankedBars({
  rows,
  emptyText,
}: {
  rows: Array<{ label: string; value: number; display: string; note?: string }>;
  emptyText: string;
}) {
  if (!rows.length) return <Empty>{emptyText}</Empty>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="an-ranked">
      {rows.map((r) => (
        <div className="an-ranked-row" key={r.label}>
          <div className="an-ranked-label">
            {r.label}
            {r.note && <span className="an-ranked-note">{r.note}</span>}
          </div>
          <div className="an-ranked-track" title={`${r.label}: ${r.display}`}>
            <div className="an-ranked-fill" style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} />
          </div>
          <div className="an-ranked-value">{r.display}</div>
        </div>
      ))}
    </div>
  );
}

/** The acquisition funnel, each step measured against the one above it. */
export function Funnel({ steps }: { steps: FunnelStep[] }) {
  const top = steps[0]?.count ?? 0;
  return (
    <div className="an-funnel">
      {steps.map((s, i) => (
        <div className="an-funnel-step" key={s.label}>
          <div className="an-funnel-head">
            <span className="an-funnel-label">{s.label}</span>
            <span className="an-funnel-count">{s.count}</span>
          </div>
          <div className="an-funnel-track">
            <div
              className="an-funnel-fill"
              style={{ width: top > 0 ? `${Math.max(1, (s.count / top) * 100)}%` : "0%" }}
              title={`${s.count} of ${top}`}
            />
          </div>
          <div className="an-funnel-foot">
            {i === 0 ? (
              <span>everyone who has ever signed up</span>
            ) : (
              <>
                <span>{formatRate(s.ofPrevious)} of the step above</span>
                {s.lost > 0 && <span className="an-lost">{s.lost} did not get here</span>}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The split of deploy outcomes.
 *
 * Labelled and hatched rather than only coloured — see the note at the top of
 * this file about red and green.
 */
export function OutcomeBar({ ok, failed, unknown }: { ok: number; failed: number; unknown: number }) {
  const total = ok + failed + unknown;
  if (!total) return <Empty>No deploys recorded in this window.</Empty>;
  const w = (n: number) => `${(n / total) * 100}%`;
  return (
    <div>
      <div className="an-stack" role="img" aria-label={`${ok} succeeded, ${failed} failed, ${unknown} without a verdict`}>
        {ok > 0 && <div className="an-stack-seg good" style={{ width: w(ok) }} title={`${ok} succeeded`} />}
        {failed > 0 && <div className="an-stack-seg bad" style={{ width: w(failed) }} title={`${failed} failed`} />}
        {unknown > 0 && <div className="an-stack-seg none" style={{ width: w(unknown) }} title={`${unknown} left no verdict`} />}
      </div>
      <div className="an-legend">
        <span className="an-key"><i className="an-sw good" />succeeded <b>{ok}</b></span>
        <span className="an-key"><i className="an-sw bad" />failed <b>{failed}</b></span>
        <span className="an-key"><i className="an-sw none" />no verdict <b>{unknown}</b></span>
      </div>
    </div>
  );
}

/** A plain table. The reading of last resort, and the accessible view of every chart above it. */
export function Table({
  columns,
  rows,
  emptyText,
}: {
  columns: string[];
  rows: Array<Array<string | number>>;
  emptyText: string;
}) {
  if (!rows.length) return <Empty>{emptyText}</Empty>;
  return (
    <div className="an-table-wrap">
      <table className="an-table">
        <thead>
          <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Durations, formatted once so every panel says "3m 47s" the same way. */
export const dur = formatDuration;
