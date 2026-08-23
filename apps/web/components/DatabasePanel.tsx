"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, Play, Table2 } from "lucide-react";
import { Chips, Row, RowList, StatusChip } from "@/components/panel/atoms";

/**
 * The app's data, answering "did it land".
 *
 * Each table is a cell carrying the two facts that answer that — how many rows,
 * and when the last one arrived — and pushing into its rows, newest first.
 * See docs/superpowers/specs/2026-08-20-database-view-design.md.
 *
 * The rule the whole surface follows: a number we cannot vouch for is LABELLED,
 * and a fact the database cannot supply is OMITTED. A table with no arrival time
 * says nothing about time; it does not say "just now".
 */

interface TableSummary {
  name: string;
  columns: number;
  rows: number;
  rowsExact: boolean;
  lastWriteAt: string | null;
  orderedBy: string;
}

interface Page {
  table: string;
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  total: number;
  totalExact: boolean;
  limit: number;
  offset: number;
  orderedBy: string;
}

const PAGE = 50;

/** `~1,200` when the count is the stats collector's guess, `1,200` when it is real. */
function count(n: number, exact: boolean): string {
  return `${exact ? "" : "~"}${n.toLocaleString()} ${n === 1 && exact ? "row" : "rows"}`;
}

/** "4 minutes ago". Absent input yields absent output — never "unknown", never "never". */
function ago(iso: string | null): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * A cell value, readable.
 *
 * `null` is shown as a dimmed word rather than an empty cell, because an empty
 * cell and a NULL are different facts and the owner is here to tell them apart.
 * Objects are JSON, and long strings are cut with the full value on hover.
 */
function fmt(v: unknown): { text: string; dim?: boolean } {
  if (v === null || v === undefined) return { text: "null", dim: true };
  if (v instanceof Date) return { text: v.toISOString().replace("T", " ").slice(0, 19) };
  if (typeof v === "object") return { text: JSON.stringify(v) };
  if (typeof v === "boolean") return { text: v ? "true" : "false" };
  return { text: String(v) };
}

export function DatabasePanel({ slug, hasDb }: { slug: string; hasDb: boolean }) {
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!hasDb) return;
    let alive = true;
    fetch(`/api/apps/${encodeURIComponent(slug)}/db`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.error) setErr(String(d.error));
        else setTables(d.tables ?? []);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [slug, hasDb]);

  if (!hasDb) return <Empty>this app has no database</Empty>;
  if (err) return <Empty>⚠ {err.slice(0, 160)}</Empty>;
  if (tables === null) return <Empty>reading…</Empty>;
  if (open) return <TableView onBack={() => setOpen(null)} slug={slug} table={open} />;

  return (
    <div className="flex flex-col gap-3">
      {tables.length === 0 ? (
        <Empty>no tables yet — nothing has written to this database</Empty>
      ) : (
        <RowList>
          {tables.map((t) => {
            const when = ago(t.lastWriteAt);
            return (
              <Row
                key={t.name}
                onOpen={() => setOpen(t.name)}
                // The sub-line carries arrival when the table records one, and
                // the column count when it does not — never a hedge about time.
                sub={when ? `last ${when}` : `${t.columns} column${t.columns === 1 ? "" : "s"}`}
                title={t.name}
              >
                <Chips>
                  <StatusChip text={count(t.rows, t.rowsExact)} tone={t.rows > 0 ? "green" : "grey"} />
                </Chips>
              </Row>
            );
          })}
        </RowList>
      )}
      <QueryBox slug={slug} />
    </div>
  );
}

function TableView({ slug, table, onBack }: { slug: string; table: string; onBack: () => void }) {
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPage(null);
    fetch(`/api/apps/${encodeURIComponent(slug)}/db?table=${encodeURIComponent(table)}&limit=${PAGE}&offset=${offset}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.error) setErr(String(d.error));
        else { setErr(null); setPage(d); }
      })
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [slug, table, offset]);

  const last = page ? Math.min(page.offset + page.rows.length, page.total) : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button className="flex items-center gap-1 text-sub text-ink-2 hover:text-ink" onClick={onBack} type="button">
          <ChevronLeft size={14} />back
        </button>
        <Table2 className="text-ink-3" size={13} />
        <span className="text-val text-ink">{table}</span>
        {/* Said, not assumed: the route decides the ordering and reports it, so
            this line and the SQL behind it cannot disagree. */}
        {page ? <span className="text-sub text-ink-3">· {page.orderedBy}</span> : null}
      </div>

      {err ? <Empty>⚠ {err.slice(0, 160)}</Empty> : null}
      {!page && !err ? <Empty>reading…</Empty> : null}

      {page ? (
        page.rows.length === 0 ? (
          <Empty>this table is empty</Empty>
        ) : (
          <>
            <div className="overflow-auto rounded-xl border border-border">
              <table className="w-full border-collapse text-sub">
                <thead>
                  <tr className="bg-card">
                    {page.columns.map((c) => (
                      <th className="whitespace-nowrap px-3 py-2 text-left font-normal text-ink-2" key={c.name}>
                        {c.name}
                        {/* The type is here because a column of unreadable values
                            needs it explained — not because the schema is the point. */}
                        <span className="pl-1.5 text-ink-3">{c.type}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, i) => (
                    <tr className="border-t border-border" key={i}>
                      {page.columns.map((c) => {
                        const v = fmt(row[c.name]);
                        return (
                          <td
                            className={`max-w-[22rem] truncate px-3 py-1.5 ${v.dim ? "text-ink-3" : "text-ink"}`}
                            key={c.name}
                            title={v.text}
                          >
                            {v.text}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center gap-3 text-sub text-ink-2">
              <span>
                {page.offset + 1}–{last} of {page.totalExact ? page.total.toLocaleString() : `~${page.total.toLocaleString()}`}
              </span>
              <button
                className="rounded-md border border-border px-2 py-1 disabled:opacity-40"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
                type="button"
              >
                newer
              </button>
              <button
                className="rounded-md border border-border px-2 py-1 disabled:opacity-40"
                disabled={last >= page.total}
                onClick={() => setOffset(offset + PAGE)}
                type="button"
              >
                older
              </button>
            </div>
          </>
        )
      ) : null}
    </div>
  );
}

/** The escape hatch: one read-only statement, below the view rather than above it. */
function QueryBox({ slug }: { slug: string }) {
  const [sql, setSql] = useState("");
  const [out, setOut] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(() => {
    if (!sql.trim()) return;
    setErr(null);
    fetch(`/api/apps/${encodeURIComponent(slug)}/db`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    })
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(String(d.error)) : setOut(d)))
      .catch((e) => setErr(String(e)));
  }, [slug, sql]);

  return (
    <details className="rounded-xl border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sub text-ink-2">Ask it something else</summary>
      <div className="flex flex-col gap-2 p-3 pt-0">
        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1 text-sub text-ink"
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") run(); }}
            placeholder="SELECT … — read-only, one statement"
            value={sql}
          />
          <button className="flex items-center gap-1 rounded-md border border-border px-2 text-sub" onClick={run} type="button">
            <Play size={12} />Run
          </button>
        </div>
        {err ? <div className="text-sub text-ink-3">⚠ {err.slice(0, 200)}</div> : null}
        {out && out.rows.length === 0 ? <div className="text-sub text-ink-3">0 rows</div> : null}
        {out && out.rows.length > 0 ? (
          <div className="max-h-64 overflow-auto rounded-md border border-border">
            <table className="w-full border-collapse text-sub">
              <thead>
                <tr className="bg-card">
                  {out.columns.map((c) => <th className="px-2 py-1 text-left font-normal text-ink-2" key={c}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {out.rows.map((r, i) => (
                  <tr className="border-t border-border" key={i}>
                    {out.columns.map((c) => {
                      const v = fmt(r[c]);
                      return <td className={`max-w-[18rem] truncate px-2 py-1 ${v.dim ? "text-ink-3" : "text-ink"}`} key={c} title={v.text}>{v.text}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-border p-4 text-sub text-ink-3">{children}</div>;
}
