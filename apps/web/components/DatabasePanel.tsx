"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Play, Table2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQueryState } from "@/lib/use-query-state";

/**
 * The app's data, answering "did it land".
 *
 * Two panes: every table on the left, the open one on the right. It was one pane
 * with a back button, which is the single biggest reason it did not feel like a
 * database — five tables and you could not compare two of them without leaving
 * the one you were reading. The left pane keeps the counts and the arrival times,
 * so it is still the summary screen as well as the switcher.
 *
 * Which table is open lives in `?table=`, like `view` and `addr` above it, so a
 * reload lands where you were and a link points at one table.
 *
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

interface Column {
  name: string;
  type: string;
}

interface Page {
  table: string;
  columns: Column[];
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

/** The same fact in a 224px column: "4 min ago", not "4 minutes ago". */
function agoShort(iso: string | null): string | null {
  const long = ago(iso);
  if (!long) return null;
  return long.replace(" minutes", " min").replace(" minute", " min").replace(" hours", " hr").replace(" hour", " hr").replace(" days", " d");
}

/**
 * A cell value in the grid, cut to fit.
 *
 * `null` is shown as a dimmed word rather than an empty cell, because an empty
 * cell and a NULL are different facts and the owner is here to tell them apart.
 * Objects are JSON on one line — the whole value is one click away.
 */
function fmt(v: unknown): { text: string; dim?: boolean } {
  if (v === null || v === undefined) return { text: "null", dim: true };
  if (v instanceof Date) return { text: v.toISOString().replace("T", " ").slice(0, 19) };
  if (typeof v === "object") return { text: JSON.stringify(v) };
  if (typeof v === "boolean") return { text: v ? "true" : "false" };
  return { text: String(v) };
}

/**
 * The same value, whole.
 *
 * jsonb indented, arrays one element per line, everything else as it is. This is
 * what the cell panel shows, and the reason `fmt` above is allowed to truncate:
 * `orders.shipping` is jsonb and `products.tags` is an array, which are exactly
 * the values somebody opens this screen to read.
 *
 * An empty string and an empty array are shown as their literals, dimmed, for the
 * same reason `null` is: they are three different facts and only one of them is
 * "there is nothing in this cell".
 */
function full(v: unknown): { text: string; dim?: boolean } {
  if (v === null || v === undefined) return { text: "null", dim: true };
  if (v instanceof Date) return { text: v.toISOString() };
  if (Array.isArray(v)) {
    if (v.length === 0) return { text: "[]", dim: true };
    return {
      text: v
        .map((e) => (e !== null && typeof e === "object" ? JSON.stringify(e) : String(e)))
        .join("\n"),
    };
  }
  if (typeof v === "object") return { text: JSON.stringify(v, null, 2) };
  if (typeof v === "boolean") return { text: v ? "true" : "false" };
  const s = String(v);
  return s === "" ? { text: '""', dim: true } : { text: s };
}

/**
 * Postgres types that are read as quantities, and therefore set on the right.
 *
 * Right-alignment on numbers is most of what makes a grid legible: the digits
 * line up, so two rows differing by an order of magnitude are obvious without
 * reading either number. Matched on a PREFIX because `information_schema` says
 * "numeric(10,2)" and "double precision", and on the whole string it would match
 * neither.
 */
const NUMERIC = [
  "int", "smallint", "bigint", "serial", "numeric", "decimal", "real", "double", "money",
];
function isNumeric(type: string): boolean {
  const t = type.toLowerCase();
  return NUMERIC.some((n) => t.startsWith(n));
}

/** A column of dates is narrow and fixed; a column of jsonb is not. */
function widthFor(type: string): string {
  const t = type.toLowerCase();
  if (t.startsWith("bool")) return "56px";
  if (t.includes("timestamp") || t.startsWith("date")) return "150px";
  if (isNumeric(t)) return "88px";
  return "auto";
}

export function DatabasePanel({ slug, hasDb }: { slug: string; hasDb: boolean }) {
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [param, setParam] = useQueryState("table");

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

  // The URL is a request, not a fact. `?table=` is only honoured once the listing
  // says such a table exists — otherwise a stale link fires a request that can
  // only come back as an error, and the first table is a better answer than one.
  const open = useMemo(() => {
    if (!tables || tables.length === 0) return null;
    if (param && tables.some((t) => t.name === param)) return param;
    return tables[0].name;
  }, [tables, param]);

  // Three different facts, and they used to be one sentence.
  //
  // `hasDb` is false whenever /db returned ANY error, so a read that failed —
  // an expired credential, a proxy that dropped the connection — was reported as
  // "this app has no database". Somebody seeing that goes looking for why their
  // database was never provisioned, which is the wrong afternoon. Same defect as
  // analytics reporting 0 visitors when umami cannot be reached.
  if (err) return <Empty>That could not be read. {err.slice(0, 160)}</Empty>;
  if (!hasDb) return <Empty>This app has no database.</Empty>;
  if (tables === null) return <Empty>Reading…</Empty>;
  if (tables.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <Empty>No tables yet — nothing has written to this database.</Empty>
        <QueryBox slug={slug} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <TableList onOpen={(t) => setParam(t)} open={open} tables={tables} />
        <div className="min-w-0 flex-1">
          {open ? <TableView key={open} slug={slug} table={open} /> : null}
        </div>
      </div>
      <QueryBox slug={slug} />
    </div>
  );
}

/**
 * Every table, permanently.
 *
 * Still carries both facts it carried as a full-width row — the shape, and when
 * something last arrived — because those answer the two halves of "did it land"
 * and losing them to make room for a grid would be a bad trade. Arrival is
 * omitted rather than hedged when the table records none.
 */
function TableList({
  tables,
  open,
  onOpen,
}: {
  tables: TableSummary[];
  open: string | null;
  onOpen: (t: string) => void;
}) {
  return (
    <div className="max-h-[560px] w-[224px] shrink-0 overflow-auto rounded-xl border border-border">
      {tables.map((t) => {
        const when = agoShort(t.lastWriteAt);
        const is = t.name === open;
        return (
          <button
            aria-current={is ? "true" : undefined}
            className={[
              "flex w-full flex-col gap-0.5 border-b border-border px-3 py-2 text-left last:border-b-0",
              is ? "bg-tile" : "hover:bg-tile",
            ].join(" ")}
            key={t.name}
            onClick={() => onOpen(t.name)}
            title={ago(t.lastWriteAt) ? `last write ${ago(t.lastWriteAt)}` : undefined}
            type="button"
          >
            {/* Mono, because a table name is an identifier you type into a query
                — the one thing on this screen that is not English. */}
            <span className={`truncate font-mono text-[13px] ${is ? "text-ink" : "text-ink-2"}`}>
              {t.name}
            </span>
            <span className="truncate text-[11.5px] tabular-nums text-ink-3">
              {count(t.rows, t.rowsExact)}
              {when ? ` · ${when}` : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function TableView({ slug, table }: { slug: string; table: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  // Which cell is open, as a position on this page — reset whenever the page is
  // replaced, because row 3 of the next page is a different row.
  const [focus, setFocus] = useState<{ row: number; column: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setPage(null);
    setFocus(null);
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
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex h-7 items-center gap-2.5">
        <Table2 className="size-3.5 shrink-0 text-ink-3" />
        <span className="truncate font-mono text-[14px] text-ink">{table}</span>
        {/* Said, not assumed: the route decides the ordering and reports it, so
            this line and the SQL behind it cannot disagree. */}
        {page ? <span className="truncate text-[13px] text-ink-3">{page.orderedBy}</span> : null}
      </div>

      {err ? <Empty>That could not be read. {err.slice(0, 160)}</Empty> : null}
      {!page && !err ? <Empty>Reading…</Empty> : null}

      {page ? (
        page.rows.length === 0 ? (
          <Empty>This table is empty.</Empty>
        ) : (
          <>
            {/* A data grid, not a layout table.

                Everything here is one decision: the values are MACHINE data, so
                they are set the way machine data is read. Mono, because an id and
                a timestamp are compared character by character and the UI font
                gives 0 and O the same width but not the same shape. 28px rows,
                so twice as many fit. Faint vertical rules, so a column can be
                followed down without losing your place. A sticky header, because
                scrolling past the names is how you end up guessing which column
                you are reading.

                None of this contradicts "no mono anywhere else": everywhere else
                the text is English. */}
            <div className="max-h-[560px] overflow-auto rounded-xl border border-border">
              <table className="w-full border-collapse font-mono text-[12.5px]">
                <thead className="sticky top-0 z-10">
                  <tr>
                    {/* The ordinal gutter. Not the primary key and not pretending
                        to be: it numbers the rows ON THIS PAGE against the total,
                        which is what tells you where you are in 40 rows. */}
                    <th className="w-[52px] border-b border-r border-border bg-tile px-2.5 py-2 text-right font-normal text-ink-3">
                      #
                    </th>
                    {page.columns.map((c) => (
                      <th
                        className={`border-b border-r border-border bg-tile px-2.5 py-2 font-normal last:border-r-0 ${
                          isNumeric(c.type) ? "text-right" : "text-left"
                        }`}
                        key={c.name}
                        style={{ width: widthFor(c.type) }}
                      >
                        <span className="whitespace-nowrap text-ink">{c.name}</span>
                        {/* The type, dimmer and one size down. It is here because
                            a column of unreadable values needs it explained — not
                            because the schema is the point. */}
                        <span className="whitespace-nowrap pl-2 text-[11px] text-ink-3">
                          {c.type}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, i) => (
                    <tr className="group" key={i}>
                      <td className="border-b border-r border-border bg-ground px-2.5 py-[5px] text-right tabular-nums text-ink-3 group-hover:bg-tile">
                        {page.offset + i + 1}
                      </td>
                      {page.columns.map((c) => {
                        const v = fmt(row[c.name]);
                        const num = isNumeric(c.type);
                        const on = focus?.row === i && focus.column === c.name;
                        return (
                          <td
                            className={[
                              "max-w-[22rem] cursor-pointer truncate border-b border-r border-border px-2.5 py-[5px] last:border-r-0 group-hover:bg-tile",
                              num ? "text-right tabular-nums" : "text-left",
                              // `null` is dim AND italic. Dim alone reads as a
                              // pale string, and "null" is a value people also
                              // store as text.
                              v.dim ? "italic text-ink-3" : "text-ink",
                              on ? "bg-tile ring-1 ring-inset ring-ink-3" : "",
                            ].join(" ")}
                            key={c.name}
                            onClick={() =>
                              setFocus(on ? null : { row: i, column: c.name })
                            }
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

            {focus && page.rows[focus.row] ? (
              <CellPanel
                column={focus.column}
                columns={page.columns}
                onClose={() => setFocus(null)}
                onColumn={(name) => setFocus({ row: focus.row, column: name })}
                ordinal={page.offset + focus.row + 1}
                row={page.rows[focus.row]}
              />
            ) : null}

            <div className="flex items-center gap-2">
              {/* The count keeps its `~`: an estimate that looks exact is the one
                  number on this screen somebody might act on. */}
              <span className="text-[13px] tabular-nums text-ink-2">
                {page.offset + 1}–{last} of{" "}
                {page.totalExact ? page.total.toLocaleString() : `~${page.total.toLocaleString()}`}
              </span>
              <Button
                className="ml-auto h-7 px-2.5 text-[13px]"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
                size="sm"
                variant="outline"
              >
                Newer
              </Button>
              <Button
                className="h-7 px-2.5 text-[13px]"
                disabled={last >= page.total}
                onClick={() => setOffset(offset + PAGE)}
                size="sm"
                variant="outline"
              >
                Older
              </Button>
            </div>
          </>
        )
      ) : null}
    </div>
  );
}

/**
 * One cell, whole.
 *
 * Under the grid rather than beside it, because the values this exists for —
 * indented jsonb, an array one element per line — want width, and the grid pane
 * is the widest thing on the screen. Beside it, both would be too narrow.
 *
 * The rest of the row comes along on the right. The reason to open a cell is
 * almost always to work out which row it belongs to, and each of those fields is
 * itself a button, so reading across a row is clicking down a list rather than
 * closing this and hunting for the next cell.
 */
function CellPanel({
  columns,
  column,
  row,
  ordinal,
  onColumn,
  onClose,
}: {
  columns: Column[];
  column: string;
  row: Record<string, unknown>;
  ordinal: number;
  onColumn: (name: string) => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const type = columns.find((c) => c.name === column)?.type;
  const v = full(row[column]);

  useEffect(() => setCopied(false), [column, ordinal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = useCallback(() => {
    // The raw value, not the pretty one: `null` copies as nothing rather than as
    // the four letters we drew, because pasting the word into a query is a bug.
    const raw = row[column];
    const text =
      raw === null || raw === undefined
        ? ""
        : typeof raw === "object"
          ? JSON.stringify(raw)
          : String(raw);
    void navigator.clipboard?.writeText(text).then(() => setCopied(true));
  }, [row, column]);

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-tile px-3 py-2">
        <span className="truncate font-mono text-[13px] text-ink">{column}</span>
        {type ? <span className="truncate text-[11.5px] text-ink-3">{type}</span> : null}
        <span className="ml-auto shrink-0 text-[12px] tabular-nums text-ink-3">row {ordinal}</span>
        <Button
          aria-label="Copy value"
          className="size-6 shrink-0 text-ink-3 hover:text-ink"
          onClick={copy}
          size="icon-sm"
          variant="ghost"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
        <Button
          aria-label="Close"
          className="size-6 shrink-0 text-ink-3 hover:text-ink"
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="flex items-stretch">
        <pre
          className={`max-h-[280px] min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12.5px] leading-[1.55] ${
            v.dim ? "italic text-ink-3" : "text-ink"
          }`}
        >
          {v.text}
        </pre>
        <div className="max-h-[280px] w-[212px] shrink-0 overflow-auto border-l border-border">
          {columns.map((c) => {
            const cell = fmt(row[c.name]);
            const is = c.name === column;
            return (
              <button
                className={[
                  "flex w-full flex-col items-start gap-px border-b border-border px-2.5 py-1.5 text-left last:border-b-0",
                  is ? "bg-tile" : "hover:bg-tile",
                ].join(" ")}
                key={c.name}
                onClick={() => onColumn(c.name)}
                type="button"
              >
                <span className="truncate font-mono text-[11px] text-ink-3">{c.name}</span>
                <span
                  className={`w-full truncate font-mono text-[12px] ${
                    cell.dim ? "italic text-ink-3" : is ? "text-ink" : "text-ink-2"
                  }`}
                >
                  {cell.text}
                </span>
              </button>
            );
          })}
        </div>
      </div>
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
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3.5 text-[14px] text-ink-2">
      {children}
    </div>
  );
}
