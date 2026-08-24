"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/panel/toast";

/**
 * The Analytics screen.
 *
 * WHY THIS IS ITS OWN READ AND NOT PART OF THE PANEL'S POLL
 *
 * The panel polls nine reads every three seconds and draws each row as it lands.
 * The audience half of that poll is six numbers, on purpose: it is the cheapest
 * question umami will answer and it sits inline on a request somebody is waiting
 * on. THIS is twenty-odd queries — every dimension the instance will answer for,
 * the time series, who is on the site this second, and the last eight visitors —
 * and it happens once, when a person opens this screen, for the window they
 * asked for. Putting it on the poll would mean six hundred admin queries a
 * minute against an instance sized for a 2 KB tracker.
 *
 * `?detail=1` on the app's own analytics route, which is same-origin here and
 * reads umami server-side. Not the edge's `/_dashboard/analytics`: that is
 * owner-only by session cookie on the TENANT host, which is a different root
 * from this one mid-rename, and a read that depends on a cookie crossing two
 * roots is a read that breaks on the day the roots change.
 */

interface Point { t: number; views: number; visitors: number }
interface Visitor {
  id: string;
  firstAt: string;
  lastAt: string;
  visits: number;
  views: number;
  country: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
}
interface Detail {
  range: string;
  startAt: number;
  endAt: number;
  unit: string;
  visitors: number;
  views: number;
  visits: number;
  bounces: number;
  totalTime: number;
  prevVisitors: number;
  prevViews: number;
  active: number | null;
  series: Point[];
  dims: Record<string, [string, number][]>;
  visitors_recent: Visitor[];
}
interface Answer { enabled: boolean; provisioned: boolean; range: string; detail: Detail | null }

const RANGES: [string, string][] = [
  ["1d", "24 hours"],
  ["7d", "7 days"],
  ["30d", "30 days"],
];

/**
 * The lists, grouped by the QUESTION they answer rather than by which call
 * fetched them. An owner opening this screen wants to know what people read,
 * where they came from, who they are and what they were using — four questions,
 * and sixteen ranked lists in one column is not an answer to any of them.
 */
const GROUPS: [string, [string, string][]][] = [
  ["What they opened", [["pages", "Pages"], ["entry", "Came in at"], ["exit", "Left from"], ["titles", "By title"]]],
  ["How they got here", [["from", "Referrer"], ["channel", "Channel"], ["query", "Search terms"]]],
  ["Who they are", [["country", "Country"], ["city", "City"], ["language", "Language"]]],
  ["What they used", [["device", "Device"], ["browser", "Browser"], ["os", "System"], ["screen", "Screen"]]],
];

/** Country codes are for machines; a flag and a name are for people. */
function flag(cc: string): string {
  if (!/^[A-Za-z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

function pct(now: number, prev: number): { text: string; up: boolean } {
  if (prev <= 0) return { text: "", up: true };
  const p = Math.round(((now - prev) / prev) * 100);
  return { text: `${p >= 0 ? "+" : ""}${p}%`, up: p >= 0 };
}

export function AnalyticsScreen({ slug, enabled, provisioned }: { slug: string; enabled: boolean; provisioned: boolean }) {
  const [range, setRange] = useState("7d");
  const [a, setA] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(true);
  const [on, setOn] = useState(enabled);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (r: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/analytics?detail=1&range=${r}`, {
        headers: { Accept: "application/json" },
      });
      const j = (await res.json()) as Answer;
      setA(j);
      setOn(j.enabled);
    } catch {
      setA(null);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { void load(range); }, [load, range]);

  async function flip(next: boolean) {
    setSaving(true);
    setOn(next);
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(slug)}/analytics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) throw new Error(String(r.status));
      toast(next ? "Counting visitors again." : "Off. Pages already served still count, for up to 30s.");
      if (next) void load(range);
    } catch {
      setOn(!next);
      toast("That did not save. Nothing changed.");
    } finally {
      setSaving(false);
    }
  }

  const d = a?.detail ?? null;
  const sessions = d ? Math.max(d.visits || 0, 1) : 1;
  const change = d ? pct(d.visitors, d.prevVisitors) : { text: "", up: true };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
          {RANGES.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setRange(key)}
              className={`rounded-md px-2.5 py-1 text-[13px] transition-colors ${
                range === key ? "bg-tile font-semibold text-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {d && d.active !== null && d.active > 0 ? (
          <span className="flex items-center gap-2 text-sub text-ink-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--live)]" aria-hidden="true" />
            {d.active} here now
          </span>
        ) : null}
      </div>

      {loading && !d ? (
        <Card className="rounded-xl border-border bg-card p-4 shadow-none">
          <div className="flex flex-col gap-3">
            <div className="h-8 w-40 animate-pulse rounded bg-tile" />
            <div className="h-24 w-full animate-pulse rounded bg-tile" />
          </div>
        </Card>
      ) : !d ? (
        <Card className="rounded-xl border-border bg-card p-4 shadow-none">
          <p className="text-sub text-ink-2">
            {!on
              ? "Analytics is off, so nobody is being counted."
              : !provisioned
                ? "Analytics is still being set up for this app."
                : "The count could not be read just now — which is not the same as nobody having visited."}
          </p>
        </Card>
      ) : (
        <>
          <Card className="flex flex-col gap-5 rounded-xl border-border bg-card p-4 shadow-none">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="visitors" value={d.visitors.toLocaleString()} />
              <Stat label="views" value={d.views.toLocaleString()} />
              <Stat label="bounce" value={`${Math.round(((d.bounces || 0) / sessions) * 100)}%`} />
              <Stat
                label="change"
                value={change.text || "—"}
                tone={change.text ? (change.up ? "up" : "down") : undefined}
              />
            </div>
            {/* TWO CHARTS, NOT TWO LINES ON ONE. 175 views against 10 visitors on
                a shared axis makes the smaller series a flat line along the floor,
                and a second y-axis to rescue it would let the crossing point mean
                whatever the scales were chosen to make it mean. */}
            <div className="grid gap-5 sm:grid-cols-2">
              <Trend points={d.series} unit={d.unit} field="views" title="Views" />
              <Trend points={d.series} unit={d.unit} field="visitors" title="Visitors" />
            </div>
          </Card>

          {GROUPS.map(([title, keys]) => {
            const present = keys.filter(([k]) => d.dims[k]?.length);
            if (!present.length) return null;
            return (
              <Card key={title} className="flex flex-col gap-4 rounded-xl border-border bg-card p-4 shadow-none">
                <div className="text-[13px] text-ink-3">{title}</div>
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                  {present.map(([k, label]) => (
                    <RankList key={k} title={label} rows={d.dims[k]} country={k === "country"} />
                  ))}
                </div>
              </Card>
            );
          })}

          {d.visitors_recent.length ? (
            <Card className="flex flex-col gap-3 rounded-xl border-border bg-card p-4 shadow-none">
              <div className="text-[13px] text-ink-3">Recent visitors</div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-val">
                  <thead>
                    <tr className="text-[12px] text-ink-3">
                      <th className="pb-2 text-left font-normal">Last seen</th>
                      <th className="pb-2 text-left font-normal">Where</th>
                      <th className="pb-2 text-left font-normal">On</th>
                      <th className="pb-2 text-right font-normal">Visits</th>
                      <th className="pb-2 text-right font-normal">Views</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.visitors_recent.map((v, i) => (
                      <tr key={`${v.id}-${i}`} className="border-t border-border">
                        <td className="py-1.5 text-ink">{ago(v.lastAt)}</td>
                        <td className="py-1.5 text-ink-2">
                          {[v.country ? `${flag(v.country)} ${v.city ?? v.country}` : null].filter(Boolean).join("") || "unknown"}
                        </td>
                        <td className="py-1.5 text-ink-2">{[v.browser, v.os].filter(Boolean).join(" · ") || "unknown"}</td>
                        <td className="py-1.5 text-right tabular-nums text-ink-2">{v.visits}</td>
                        <td className="py-1.5 text-right tabular-nums text-ink-2">{v.views}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Said plainly, because an owner looking at a row of a stranger's
                  city and browser deserves to know what is NOT here. */}
              <p className="text-sub text-ink-3">
                No names, no cookies, no cross-site id — a visitor is a daily hash of address and browser, and
                it stops meaning anything tomorrow.
              </p>
            </Card>
          ) : null}
        </>
      )}

      <Card className="flex items-center justify-between gap-4 rounded-xl border-border bg-card p-4 shadow-none">
        <div className="flex flex-col gap-0.5">
          <div className="text-val text-ink">Count visitors</div>
          <p className="text-sub text-ink-2">
            First-party, from this app&apos;s own address. No cookie, no third-party script, and nothing leaves
            the hostname your visitors already chose to trust.
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={saving} onClick={() => flip(!on)}>
          {on ? "Turn off" : "Turn on"}
        </Button>
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div
        className={`text-section tabular-nums ${
          tone === "up" ? "text-[var(--live)]" : tone === "down" ? "text-[var(--accent)]" : "text-ink"
        }`}
      >
        {value}
      </div>
      <div className="text-[13px] text-ink-3">{label}</div>
    </div>
  );
}

/**
 * One measure over time.
 *
 * An area under a 2px line, with the last point marked: the shape carries the
 * trend and the endpoint carries "and here is where it is now", which is the
 * only point on a chart this size anybody reads a value off. Hovering names the
 * bucket, because a chart whose x-axis is unlabelled is a chart you cannot cite.
 *
 * Drawn in viewBox space and stretched by CSS, with non-scaling strokes so the
 * line stays 2px at any panel width rather than smearing with the box.
 */
function Trend({ points, unit, field, title }: { points: Point[]; unit: string; field: "views" | "visitors"; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 300;
  const H = 74;
  const pad = 3;

  if (points.length < 2) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-[13px] text-ink-3">{title}</div>
        <p className="text-sub text-ink-2">Not enough of a window yet to draw a line.</p>
      </div>
    );
  }

  const vals = points.map((p) => p[field]);
  const max = Math.max(1, ...vals);
  const x = (i: number) => pad + (i * (W - pad * 2)) / (points.length - 1);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);

  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[field]).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;
  const at = hover === null ? points.length - 1 : hover;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] text-ink-3">{title}</span>
        <span className="text-val tabular-nums text-ink">
          {points[at][field].toLocaleString()}
          <span className="pl-1.5 text-[12px] text-ink-3">{bucket(points[at].t, unit)}</span>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[74px] w-full touch-none"
        role="img"
        aria-label={`${title} per ${unit}, ${points.length} buckets, peak ${max}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const rel = (e.clientX - r.left) / Math.max(r.width, 1);
          setHover(Math.min(points.length - 1, Math.max(0, Math.round(rel * (points.length - 1)))));
        }}
      >
        {/* Recessive: one hairline at the floor, so the area has something to sit on. */}
        <line x1="0" y1={H - pad} x2={W} y2={H - pad} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d={area} fill="var(--accent)" opacity="0.10" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <line x1={x(at)} y1="0" x2={x(at)} y2={H - pad} stroke="var(--ink-3)" strokeWidth="1" opacity={hover === null ? 0 : 0.35} vectorEffect="non-scaling-stroke" />
        {/* A 2px surface ring, so the endpoint reads as a mark and not as a lump
            in the line where the area meets it. */}
        <circle cx={x(at)} cy={y(points[at][field])} r="3.5" fill="var(--accent)" stroke="var(--card)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function RankList({ title, rows, country }: { title: string; rows: [string, number][]; country?: boolean }) {
  const top = Math.max(1, ...rows.map(([, n]) => n));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="text-[13px] text-ink-3">{title}</div>
      {rows.map(([name, n]) => (
        <div key={name} className="flex flex-col gap-0.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-val text-ink">{country ? `${flag(name)} ${name}` : name}</span>
            <span className="text-val tabular-nums text-ink-2">{n.toLocaleString()}</span>
          </div>
          {/* The bar is the comparison; the number is the fact. Both, because the
              eye reads the first and a person quoting it needs the second. */}
          <div className="h-[3px] w-full overflow-hidden rounded-full bg-tile">
            <div className="h-full rounded-full bg-[var(--accent)] opacity-70" style={{ width: `${Math.max(3, (n / top) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The bucket a point covers, named the way somebody reads a chart. */
function bucket(t: number, unit: string): string {
  const d = new Date(t);
  return unit === "hour"
    ? d.toLocaleTimeString(undefined, { hour: "numeric" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** How long ago, in the shortest true form. */
function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
