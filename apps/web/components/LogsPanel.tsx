"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2, Pause, Play, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { FixPrompt } from "@/components/FixPrompt";
import type { LogRow, Level, Source } from "@/lib/logs";

/**
 * The log view: a live tail you can search, over one app.
 *
 * NEWEST AT THE TOP, which is the decision everything else follows from. A
 * bottom-appending tail — `tail -f` — needs scroll management that fights the
 * reader: you are either pinned to the bottom and cannot read, or scrolled up and
 * missing lines. Newest-first means new rows arrive where you are already looking
 * and history is simply further down.
 *
 * It does cost one thing, and it is handled rather than ignored: prepending while
 * somebody is scrolled into history would shove the line they are reading down the
 * page. So arriving rows are BUFFERED whenever the list is not at the top, and a
 * pill says how many are waiting. Clicking it flushes and returns to the top.
 *
 * The two-way division people actually want — is this my frontend or my backend —
 * is a segmented control and not two screens, because a 500 from an API and the
 * browser error it caused belong on one screen seconds apart, and tabs make that
 * impossible. `Requests` is its own segment because the edge cannot tell which
 * side a request belongs to and will not guess.
 */

const WINDOWS = [
  { id: "1h", label: "Last hour" },
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "all", label: "All time" },
] as const;

const FACES = [
  { id: "", label: "All" },
  { id: "frontend", label: "Frontend" },
  { id: "backend", label: "Backend" },
  { id: "edge", label: "Requests" },
] as const;

const LEVEL_LABEL: Record<Level, string> = {
  debug: "Debug and above",
  info: "Info and above",
  warn: "Warnings and errors",
  error: "Errors only",
};

/** The rule down the left of a row. The only colour in the list. */
const RULE: Record<Level, string> = {
  error: "bg-red",
  warn: "bg-[var(--amber,#b45309)]",
  info: "bg-transparent",
  debug: "bg-transparent",
};

const SOURCE_LABEL: Record<Source, string> = {
  app: "app",
  edge: "req",
  browser: "web",
  build: "build",
  deploy: "deploy",
  platform: "sys",
};

/** 2xx is unremarkable; the point of colour here is the ones that are not. */
function statusTone(status: number): string {
  if (status >= 500) return "text-red";
  if (status >= 400) return "text-[var(--amber,#b45309)]";
  if (status >= 300) return "text-ink-2";
  return "text-ink-3";
}

/** `00:14:22.318` — the part of a timestamp you compare against another line. */
function clock(at: string): string {
  const t = at.slice(11, 23);
  return t || at.slice(0, 12);
}

interface Filters {
  window: string;
  face: string;
  level: Level | "";
  q: string;
}

export function LogsPanel({ slug }: { slug: string }) {
  const [f, setF] = useState<Filters>({ window: "24h", face: "", level: "", q: "" });
  /** What the user is typing, separate from what has been asked for. */
  const [typed, setTyped] = useState("");

  const [rows, setRows] = useState<LogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [since, setSince] = useState<string | null>(null);

  const [live, setLive] = useState(true);
  const [held, setHeld] = useState<LogRow[]>([]);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const atTop = useRef(true);

  const params = useMemo(() => {
    const p = new URLSearchParams({ window: f.window });
    if (f.face === "frontend" || f.face === "backend") p.set("face", f.face);
    if (f.face === "edge") p.set("source", "edge");
    if (f.level) p.set("level", f.level);
    if (f.q.trim()) p.set("q", f.q.trim());
    return p;
  }, [f]);

  /* ── history ─────────────────────────────────────────────────────────── */

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    setRows([]);
    setHeld([]);
    setCursor(null);
    const p = new URLSearchParams(params);
    p.set("limit", "100");
    fetch(`/api/apps/${encodeURIComponent(slug)}/logs/query?${p}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.error) setErr(String(d.error));
        else {
          setRows(d.rows ?? []);
          setCursor(d.cursor ?? null);
          setSince(d.since ?? null);
        }
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [slug, params]);

  const loadMore = useCallback(() => {
    if (!cursor || more) return;
    setMore(true);
    const p = new URLSearchParams(params);
    p.set("limit", "100");
    p.set("cursor", cursor);
    fetch(`/api/apps/${encodeURIComponent(slug)}/logs/query?${p}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setErr(String(d.error));
        // Appended, and de-duplicated on id. A page token should not overlap, and
        // it does not — but a list that renders one row twice is a bug people
        // report as "the logs are wrong", so it is made impossible here rather
        // than assumed away.
        setRows((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...(d.rows ?? []).filter((r: LogRow) => !seen.has(r.id))];
        });
        setCursor(d.cursor ?? null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setMore(false));
  }, [cursor, more, params, slug]);

  /* ── the tail ────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!live) return;
    const es = new EventSource(`/api/apps/${encodeURIComponent(slug)}/logs/tail?${params}`);
    es.addEventListener("row", (ev) => {
      const row = JSON.parse((ev as MessageEvent).data) as LogRow;
      // At the top: straight in. Anywhere else: held, so the line somebody is
      // reading does not move under them.
      if (atTop.current) {
        setRows((prev) => (prev.some((r) => r.id === row.id) ? prev : [row, ...prev]));
      } else {
        setHeld((prev) => (prev.some((r) => r.id === row.id) ? prev : [row, ...prev]));
      }
    });
    es.addEventListener("broken", (ev) => {
      // A tail that died silently is indistinguishable from an app that went
      // quiet, and those are opposite facts.
      setErr(`the live tail stopped: ${JSON.parse((ev as MessageEvent).data).why}`);
      setLive(false);
    });
    es.onerror = () => { /* EventSource reconnects by itself; a blip is not news. */ };
    return () => es.close();
  }, [slug, params, live]);

  function flush() {
    setRows((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      return [...held.filter((r) => !seen.has(r.id)), ...prev];
    });
    setHeld([]);
    scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  const empty = !loading && !err && rows.length === 0;

  /**
   * The newest error worth handing over.
   *
   * From what is ON SCREEN rather than from a second query, so it follows the
   * filters: narrow to Requests and it offers the newest failing request, narrow
   * to Backend and it offers what the app printed. A request line is excluded
   * because `GET /x 503` is not an error a coding agent can act on — the app's own
   * output is.
   */
  const newestError = useMemo(
    () => rows.find((r) => r.level === "error" && !r.http && r.msg.trim().length > 8) ?? null,
    [rows],
  );

  return (
    <div className="flex flex-col gap-3">
      {/* ── the toolbar ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="relative min-w-[220px] flex-1"
          onSubmit={(e) => { e.preventDefault(); setF((x) => ({ ...x, q: typed })); }}
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
          <Input
            aria-label="Search logs"
            className="h-8 pl-8 pr-8 text-[13px]"
            onChange={(e) => setTyped(e.currentTarget.value)}
            placeholder="Search logs"
            value={typed}
          />
          {typed ? (
            <button
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
              onClick={() => { setTyped(""); setF((x) => ({ ...x, q: "" })); }}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </form>

        {/* The two-way division, as one click. */}
        <div className="flex shrink-0 items-center rounded-md border border-border p-0.5">
          {FACES.map((o) => (
            <button
              className={[
                "rounded-[4px] px-2.5 py-1 text-[12.5px] transition-colors",
                f.face === o.id ? "bg-tile text-ink" : "text-ink-2 hover:text-ink",
              ].join(" ")}
              key={o.id}
              onClick={() => setF((x) => ({ ...x, face: o.id }))}
              type="button"
            >
              {o.label}
            </button>
          ))}
        </div>

        <Picker label={f.level ? LEVEL_LABEL[f.level] : "All levels"}>
          <DropdownMenuItem onClick={() => setF((x) => ({ ...x, level: "" }))}>All levels</DropdownMenuItem>
          {(["error", "warn", "info", "debug"] as Level[]).map((l) => (
            <DropdownMenuItem key={l} onClick={() => setF((x) => ({ ...x, level: l }))}>
              {LEVEL_LABEL[l]}
            </DropdownMenuItem>
          ))}
        </Picker>

        <Picker label={WINDOWS.find((w) => w.id === f.window)?.label ?? "Last 24 hours"}>
          {WINDOWS.map((w) => (
            <DropdownMenuItem key={w.id} onClick={() => setF((x) => ({ ...x, window: w.id }))}>
              {w.label}
            </DropdownMenuItem>
          ))}
        </Picker>

        <Button
          className="h-8 shrink-0 gap-1.5 px-2.5 text-[12.5px]"
          onClick={() => setLive((l) => !l)}
          size="sm"
          variant="outline"
        >
          {live ? (
            <>
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--green)] opacity-75" />
                <span className="relative inline-flex size-1.5 rounded-full bg-[var(--green)]" />
              </span>
              Live
            </>
          ) : (
            <>
              <Play className="size-3" />
              Paused
            </>
          )}
        </Button>
      </div>

      {err ? (
        <div className="rounded-xl border border-border bg-card px-4 py-3 text-[13px] text-red">{err}</div>
      ) : null}

      {/* The newest error on screen, and a prompt for it.
          Above the list, because somebody who arrived here from "a path has been
          failing" came to act rather than to read — and below the filters,
          because which error it offers follows what they have narrowed to.
          Absent when nothing is failing: an app that is fine should not be shown
          a fix button for it. */}
      {newestError ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-tint p-3.5">
          <p className="font-mono text-[12.5px] leading-[1.5] text-ink">
            {newestError.msg.slice(0, 300)}
          </p>
          <FixPrompt error={newestError.msg} slug={slug} />
        </div>
      ) : null}

      {/* ── the list ──────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-xl border border-border">
        {held.length > 0 ? (
          <button
            className="absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-full border border-border bg-card px-3 py-1 text-[12px] text-ink shadow-sm"
            onClick={flush}
            type="button"
          >
            {held.length} new {held.length === 1 ? "line" : "lines"}
          </button>
        ) : null}

        <div
          className="max-h-[560px] overflow-auto"
          onScroll={(e) => { atTop.current = e.currentTarget.scrollTop < 8; }}
          ref={scroller}
        >
          {loading ? (
            <div className="flex flex-col gap-2 p-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton className="h-3" key={i} style={{ width: `${[70, 45, 88, 60, 52, 78][i]}%` }} />
              ))}
            </div>
          ) : null}

          {empty ? (
            <div className="px-4 py-8 text-center">
              <p className="text-[14px] text-ink-2">
                Nothing since {since ? new Date(since).toLocaleString() : "the start of the window"}
              </p>
              {/* NOT "no logs". A file tail has no history — whatever the app said
                  before we started watching was never captured, and an app that
                  prints nothing is not an app with no logs. */}
              <p className="pt-1 text-[12.5px] text-ink-3">
                {live ? "Watching for new lines." : "The tail is paused."}
              </p>
            </div>
          ) : null}

          {rows.length > 0 ? (
            <div className="font-mono text-[12.5px]">
              {rows.map((r) => (
                <Line
                  key={r.id}
                  onToggle={() => setOpenRow((o) => (o === r.id ? null : r.id))}
                  open={openRow === r.id}
                  row={r}
                />
              ))}
            </div>
          ) : null}

          {cursor ? (
            <div className="border-t border-border p-2">
              <Button
                className="h-7 w-full text-[12.5px] text-ink-2"
                disabled={more}
                onClick={loadMore}
                size="sm"
                variant="ghost"
              >
                {more ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {more ? "Loading" : "Load older"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * One line.
 *
 * Time, a level rule, what produced it, and the message — in that order, because
 * that is the order the eye needs them: when, how bad, from where, what. Dense
 * enough that a screen holds forty of them, which is what makes a log list
 * readable rather than a list of cards.
 */
function Line({ row, open, onToggle }: { row: LogRow; open: boolean; onToggle: () => void }) {
  const dim = row.level === "debug";
  return (
    <div className="border-b border-border last:border-0">
      <button
        className="group flex w-full items-start gap-2.5 px-3 py-[3px] text-left hover:bg-tile"
        onClick={onToggle}
        type="button"
      >
        <span aria-hidden="true" className={`mt-[3px] h-[13px] w-[2px] shrink-0 rounded-full ${RULE[row.level]}`} />
        <span className="shrink-0 tabular-nums text-ink-3">{clock(row.at)}</span>
        <span className="w-[38px] shrink-0 text-[11px] uppercase tracking-[0.04em] text-ink-3">
          {SOURCE_LABEL[row.source]}
        </span>
        {row.http ? (
          <>
            <span className={`w-[30px] shrink-0 tabular-nums ${statusTone(row.http.status)}`}>
              {row.http.status}
            </span>
            <span className="w-[46px] shrink-0 text-ink-3">{row.http.method}</span>
            <span className="min-w-0 flex-1 truncate text-ink">{row.http.path}</span>
            <span className="shrink-0 tabular-nums text-ink-3">{row.http.ms}ms</span>
          </>
        ) : (
          <span
            className={`min-w-0 flex-1 truncate ${
              row.level === "error" ? "text-red" : dim ? "text-ink-3" : "text-ink"
            }`}
          >
            {row.msg || <span className="text-ink-3">·</span>}
          </span>
        )}
      </button>

      {open ? (
        <div className="border-t border-border bg-tile/50 px-3 py-2.5">
          <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
            <Field k="time">{row.at}</Field>
            <Field k="source">{row.source}</Field>
            {row.face ? <Field k="side">{row.face}</Field> : null}
            <Field k="level">{row.level}</Field>
            {row.process ? <Field k="process">{row.process}</Field> : null}
            {row.release ? <Field k="release">{row.release}</Field> : null}
            {row.http ? <Field k="request">{`${row.http.method} ${row.http.path} → ${row.http.status} in ${row.http.ms}ms`}</Field> : null}
            {row.page?.url ? <Field k="page">{row.page.url}</Field> : null}
            {row.page?.line ? <Field k="at line">{String(row.page.line)}</Field> : null}
          </dl>
          {row.msg ? (
            <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-words text-[12px] leading-[1.55] text-ink">
              {row.msg}
            </pre>
          ) : null}
          {row.page?.stack ? (
            <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-words text-[12px] leading-[1.55] text-ink-2">
              {row.page.stack}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Field({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-ink-3">{k}</dt>
      <dd className="min-w-0 truncate text-ink-2">{children}</dd>
    </>
  );
}

function Picker({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="h-8 shrink-0 px-2.5 text-[12.5px]" size="sm" variant="outline">
          {label}
          <ChevronDown className="size-3.5 text-ink-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
