"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, Check, ChevronDown, Copy, Database, Filter as FilterIcon,
  KeyRound, Pencil, Play, RefreshCw, SquareTerminal, Table2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  FILTER_OPS, editRefusal, opTakesValue,
  type Column, type Filter, type FilterOp, type Sort, type TableShape,
} from "@/lib/db-browse";
import { useQueryRecord } from "@/lib/use-query-state";

/**
 * Everything about this screen that belongs in the URL, in one place.
 *
 * They move together — picking a table clears the sort and the filter, because a
 * column of `orders` means nothing in `customers` — and moving them one at a time
 * left six entries in the history for one click. See `useQueryRecord`.
 *
 * `sql` carries the whole statement, which is what makes a query somebody wrote
 * a thing they can send to somebody else.
 */
const VIEW_KEYS = ["table", "sort", "dir", "where", "op", "value", "pane", "sql"] as const;

/**
 * Postgres types that are read as quantities, and therefore set on the right.
 *
 * Right-alignment on numbers is most of what makes a grid legible: the digits
 * line up, so two rows differing by an order of magnitude are obvious without
 * reading either number. Matched on a PREFIX because a type arrives spelled
 * "numeric(10,2)" or "double precision", and on the whole string it would match
 * neither.
 */
const NUMERIC = [
  "int", "smallint", "bigint", "serial", "numeric", "decimal", "real", "double", "money",
  // `float` because the SQL surface reports Postgres's own `typname`, where a
  // double is `float8` and an integer is `int4`.
  "float",
];
function isNumeric(type: string): boolean {
  const t = type.toLowerCase();
  // An array of numbers is not a number, and right-aligning `{1,2,3}` helps
  // nobody.
  if (t.endsWith("[]") || t.startsWith("_")) return false;
  return NUMERIC.some((n) => t.startsWith(n));
}

/** A column of dates is narrow and fixed; a column of jsonb is not. */
function widthFor(type: string): string {
  const t = type.toLowerCase();
  if (t.startsWith("bool")) return "56px";
  if (t.includes("timestamp")) return "224px";
  if (t.startsWith("date")) return "104px";
  if (isNumeric(t)) return "88px";
  return "auto";
}

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

/**
 * A table, as the list knows it before anything has been counted.
 *
 * The whole shape comes with it, not a count of columns: the filter needs to know
 * what a column is called, the grid needs to know which one is the key, and
 * sending it here means opening a table does not ask a second time.
 */
interface TableSummary {
  name: string;
  columns: Column[];
  primaryKey: string[];
  orderedBy: string;
}

/** The slow half, which arrives second and separately. */
interface TableStat {
  rows: number;
  rowsExact: boolean;
  lastWriteAt: string | null;
}

interface Page {
  table: string;
  columns: Column[];
  /** The columns making up the primary key, in order. Empty when there is none. */
  primaryKey: string[];
  rows: Record<string, unknown>[];
  /** Null when the count could not be taken — never 0, which is a different fact. */
  total: number | null;
  totalExact: boolean;
  limit: number;
  offset: number;
  /** What was APPLIED, which is not always what the URL asked for. */
  sort: Sort | null;
  filter: Filter | null;
  orderedBy: string;
}

/** The comparisons, in the words somebody reading a row would use. */
const OP_LABEL: Record<FilterOp, string> = {
  eq: "is",
  neq: "is not",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  contains: "contains",
  starts: "starts with",
  // Said as `null` rather than "is empty", because the grid draws the word `null`
  // and an empty string is a different thing sitting in the same column.
  null: "is null",
  notnull: "is not null",
};

const PAGE = 50;

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
  // No `Date` branch, and there never should have been one: this reads a JSON
  // payload, and JSON has no date type. It was dead code claiming to trim a
  // timestamp, while timestamps went through `String(v)` untouched. They now
  // arrive as Postgres's own text — see `tenantTypes` in lib/db.ts — which is
  // both shorter and, for a `date`, the right day.
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
 * The value as the database would spell it, not as we drew it.
 *
 * `null` becomes nothing rather than the four letters the grid renders, because
 * pasting the word `null` into a query is a bug and typing it back into a cell
 * would store it as text. Shared by Copy and by the editor, so what you copy is
 * exactly what you would be handing back.
 */
function raw(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * The app's data, answering "did it land".
 *
 * Two panes: every table on the left, the open one on the right. It was one pane
 * with a back button, which is the single biggest reason it did not feel like a
 * database — five tables and you could not compare two of them without leaving
 * the one you were reading.
 *
 * WHAT IS ASKED FOR, AND WHEN
 *
 * Three requests, fired TOGETHER, because a round trip to Cloud SQL is 196ms and
 * this screen used to make fifteen of them in a chain: the shapes, then the
 * counts, then — only once all of that had returned — the page. About four
 * seconds before a single row appeared.
 *
 *   the shapes    names, columns, keys      renders the rail
 *   the stats     row counts, last write    fills the numbers in afterwards
 *   the page      whichever table is open   starts immediately when the URL says
 *
 * The counts are separate because the rail is a SWITCHER first and a summary
 * second — you can click a table while its number is still arriving — and because
 * counting is the slow part. And when `?table=` is in the URL, the page does not
 * wait to be told the table exists: the server will say if it does not, and being
 * wrong costs one request while waiting costs every visit.
 *
 * See docs/superpowers/specs/2026-08-20-database-view-design.md.
 *
 * The rule the whole surface follows: a number we cannot vouch for is LABELLED,
 * and a fact the database cannot supply is OMITTED. A table with no arrival time
 * says nothing about time; it does not say "just now".
 */
export function DatabasePanel({ slug, hasDb }: { slug: string; hasDb: boolean }) {
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [database, setDatabase] = useState<string>("");
  const [stats, setStats] = useState<Record<string, TableStat> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useQueryRecord(VIEW_KEYS);
  // Bumped by the one refresh button, which re-reads the counts AND the open
  // page: the point of this screen is watching data arrive, and it only ever
  // read on mount.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!hasDb) return;
    let alive = true;
    const at = `/api/apps/${encodeURIComponent(slug)}/db`;

    fetch(at)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.error) setErr(String(d.error));
        else { setTables(d.tables ?? []); setDatabase(String(d.database ?? "")); }
      })
      .catch((e) => alive && setErr(String(e)));

    // Not awaited on, and its failure is not the screen's failure: a count we
    // could not take leaves the rail without numbers, which is worse than having
    // them and much better than an error page over a list that loaded.
    fetch(`${at}?stats=1`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !Array.isArray(d.stats)) return;
        setStats(Object.fromEntries(d.stats.map((s: TableStat & { name: string }) => [s.name, s])));
      })
      .catch(() => {});

    return () => { alive = false; };
  }, [slug, hasDb, nonce]);

  // The URL is a request. Once the real list arrives, a `?table=` naming
  // something that is not in it is dropped — along with the sort and filter that
  // were made on it, which belong to that table and nothing else.
  useEffect(() => {
    if (!tables || !q.table) return;
    if (!tables.some((t) => t.name === q.table)) {
      setQ({ table: null, sort: null, dir: null, where: null, op: null, value: null }, "replace");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables, q.table]);

  // Trusted before the list has landed, so the page read starts at once.
  const open = q.table ?? (tables ? tables[0]?.name ?? null : null);
  const sqlPane = q.pane === "sql";
  const shape = tables?.find((t) => t.name === open) ?? null;

  // Three different facts, and they used to be one sentence.
  //
  // `hasDb` is false whenever /db returned ANY error, so a read that failed —
  // an expired credential, a proxy that dropped the connection — was reported as
  // "this app has no database". Somebody seeing that goes looking for why their
  // database was never provisioned, which is the wrong afternoon. Same defect as
  // analytics reporting 0 visitors when umami cannot be reached.
  if (err) return <Empty>That could not be read. {err.slice(0, 160)}</Empty>;
  if (!hasDb) return <Empty>This app has no database.</Empty>;

  return (
    <div className="flex items-start gap-3">
      <TableList
        database={database}
        loading={tables === null}
        // A sort or a filter belongs to the table it was made on. Carrying
        // `sort=total` into `customers` would either error or, worse, be
        // silently dropped while the URL still claimed it.
        onOpen={(t) =>
          setQ({ table: t, pane: null, sort: null, dir: null, where: null, op: null, value: null })
        }
        // The table state is kept, not cleared: coming back from the editor should
        // land on the table and the filter you left.
        onSql={() => setQ({ pane: "sql" })}
        open={sqlPane ? null : open}
        sqlOpen={sqlPane}
        stats={stats}
        tables={tables ?? []}
      />
      <div className="min-w-0 flex-1">
        {sqlPane ? (
          <SqlPane q={q} setQ={setQ} slug={slug} />
        ) : tables?.length === 0 ? (
          <Empty>No tables yet — nothing has written to this database.</Empty>
        ) : tables === null && !open ? (
          // No `?table=` and no list yet, so there is nothing to name. One beat,
          // and only on a first visit — with a table in the URL the grid is
          // already loading beside this.
          <Empty>Reading…</Empty>
        ) : open ? (
          <TableView
            key={open}
            nonce={nonce}
            onRefresh={() => setNonce((n) => n + 1)}
            q={q}
            setQ={setQ}
            shape={shape}
            slug={slug}
            table={open}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The rail: the database, the editor, and every table.
 *
 * It was a flat strip of buttons, which read as a menu rather than as a place —
 * and gave no hint what the one labelled "SQL" would do. So it has the three
 * things a database sidebar has: it says which database you are in, it separates
 * the tool from the data, and it puts the row counts in a COLUMN you can run your
 * eye down instead of burying them in a sentence.
 *
 * Not dark, not square, not mono except where a name is an identifier — the same
 * cards, radii and greys as the rest of the product. What makes it read as a
 * database is the structure and the alignment, not a change of costume.
 *
 * The counts arrive after the names, so their absence is a shimmer rather than a
 * zero. A zero here would be a claim, and the wrong one.
 */
function TableList({
  database,
  tables,
  stats,
  open,
  sqlOpen,
  loading,
  onOpen,
  onSql,
}: {
  database: string;
  tables: TableSummary[];
  stats: Record<string, TableStat> | null;
  open: string | null;
  sqlOpen: boolean;
  loading: boolean;
  onOpen: (t: string) => void;
  onSql: () => void;
}) {
  return (
    <div className="w-[248px] shrink-0 overflow-hidden rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-tile px-3 py-2.5">
        <Database className="size-3.5 shrink-0 text-ink-3" />
        <span className="truncate text-[13px] font-[450] text-ink">
          {database || <span className="text-ink-3">database</span>}
        </span>
      </div>

      {/* The editor, above the data and separated from it, with a line saying
          what it is for. "SQL" alone named a language, not an action. */}
      <button
        aria-current={sqlOpen ? "true" : undefined}
        className={[
          "flex w-full items-center gap-2.5 border-b border-border px-3 py-2.5 text-left",
          sqlOpen ? "bg-tile" : "hover:bg-tile",
        ].join(" ")}
        onClick={onSql}
        type="button"
      >
        <span
          aria-hidden="true"
          className={`h-8 w-[2px] shrink-0 rounded-full ${sqlOpen ? "bg-ink" : "bg-transparent"}`}
        />
        <SquareTerminal className="size-4 shrink-0 text-ink-3" />
        <span className="min-w-0">
          <span className={`block truncate text-[13px] ${sqlOpen ? "text-ink" : "text-ink-2"}`}>
            Query editor
          </span>
          <span className="block truncate text-[11px] text-ink-3">write SQL by hand</span>
        </span>
      </button>

      <div className="flex items-center justify-between bg-tile/60 px-3 py-1.5">
        <span className="text-[10.5px] font-[450] uppercase tracking-[0.07em] text-ink-3">
          Tables
        </span>
        <span className="text-[11px] tabular-nums text-ink-3">
          {loading ? "" : tables.length}
        </span>
      </div>

      <div className="max-h-[496px] overflow-auto border-t border-border">
        {loading ? (
          <div className="flex flex-col gap-2 px-3 py-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton className="h-3.5" key={i} style={{ width: [96, 72, 108, 84][i] }} />
            ))}
          </div>
        ) : null}

        {tables.map((t) => {
          const s = stats?.[t.name];
          const when = agoShort(s?.lastWriteAt ?? null);
          const is = t.name === open;
          return (
            <button
              aria-current={is ? "true" : undefined}
              className={[
                "flex w-full items-center gap-2.5 border-b border-border px-3 py-2 text-left last:border-b-0",
                is ? "bg-tile" : "hover:bg-tile",
              ].join(" ")}
              key={t.name}
              onClick={() => onOpen(t.name)}
              title={s?.lastWriteAt ? `last write ${ago(s.lastWriteAt)}` : undefined}
              type="button"
            >
              {/* The selected table, marked by a rule rather than by colour: this
                  rail sits beside a grid, and one more coloured thing on the
                  screen is one more thing competing with the data. */}
              <span
                aria-hidden="true"
                className={`h-7 w-[2px] shrink-0 rounded-full ${is ? "bg-ink" : "bg-transparent"}`}
              />
              <span className="min-w-0 flex-1">
                {/* Mono, because a table name is an identifier you type into a
                    query — the one thing in this rail that is not English. */}
                <span className={`block truncate font-mono text-[12.5px] ${is ? "text-ink" : "text-ink-2"}`}>
                  {t.name}
                </span>
                <span className="block truncate text-[11px] text-ink-3">
                  {t.columns.length} column{t.columns.length === 1 ? "" : "s"}
                  {when ? ` · ${when}` : ""}
                </span>
              </span>
              {/* The counts, right-aligned so they form a column. Absent until
                  they are known — a zero would be a claim, and the wrong one. */}
              {s ? (
                <span className="shrink-0 text-[12px] tabular-nums text-ink-2">
                  {s.rowsExact ? "" : "~"}
                  {s.rows.toLocaleString()}
                </span>
              ) : (
                <Skeleton className="h-3 w-7 shrink-0" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}


function TableView({
  slug,
  table,
  shape,
  q,
  setQ,
  nonce,
  onRefresh,
}: {
  slug: string;
  table: string;
  /** What the rail already knows about this table, or null before the list lands. */
  shape: TableSummary | null;
  q: Record<(typeof VIEW_KEYS)[number], string | null>;
  setQ: (patch: Partial<Record<(typeof VIEW_KEYS)[number], string | null>>, mode?: "push" | "replace") => void;
  nonce: number;
  onRefresh: () => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  // Which cell is open, as a position on this page — reset whenever the page is
  // replaced, because row 3 of the next page is a different row.
  const [focus, setFocus] = useState<{ row: number; column: string } | null>(null);
  const [barOpen, setBarOpen] = useState(false);

  // What the URL asked for. Used for the SORT CYCLE, because a click has to know
  // what the last click did without waiting for a round trip. What is DRAWN comes
  // from the payload below — the two are separate on purpose.
  const asked: Sort | null = q.sort ? { column: q.sort, dir: q.dir === "asc" ? "asc" : "desc" } : null;

  useEffect(() => {
    let alive = true;
    setPage(null);
    setFocus(null);
    const p = new URLSearchParams({ table, limit: String(PAGE), offset: String(offset) });
    if (q.sort) { p.set("sort", q.sort); p.set("dir", q.dir === "asc" ? "asc" : "desc"); }
    if (q.where) {
      p.set("where", q.where);
      p.set("op", q.op ?? "eq");
      if (q.value) p.set("value", q.value);
    }
    fetch(`/api/apps/${encodeURIComponent(slug)}/db?${p}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.error) setErr(String(d.error));
        else { setErr(null); setPage(d); }
      })
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [slug, table, offset, nonce, q.sort, q.dir, q.where, q.op, q.value]);

  // The URL is a request; the payload is what happened.
  //
  // A link made when this table had a `total` column is stale, not hostile: the
  // read succeeds without it, and the parameter that did nothing is dropped
  // rather than left in the URL claiming an order the grid is not in. Replace,
  // not push — nobody navigated anywhere.
  useEffect(() => {
    if (!page) return;
    if (!page.sort && (q.sort || q.dir)) setQ({ sort: null, dir: null }, "replace");
    if (!page.filter && q.where && q.value) setQ({ where: null, op: null, value: null }, "replace");
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Descending, then ascending, then back to the table's own order. */
  function clickSort(column: string) {
    setOffset(0);
    if (!asked || asked.column !== column) return setQ({ sort: column, dir: "desc" });
    if (asked.dir === "desc") return setQ({ sort: column, dir: "asc" });
    setQ({ sort: null, dir: null });
  }

  function applyFilter(f: Filter | null) {
    setOffset(0);
    setQ(f ? { where: f.column, op: f.op, value: f.value } : { where: null, op: null, value: null });
    if (!f) setBarOpen(false);
  }

  const shownTo = page ? page.offset + page.rows.length : 0;
  // Three answers, and the middle one is why `total` is nullable: a count that
  // gave up used to arrive as 0, so the footer read "1–50 of ~0" underneath fifty
  // visible rows.
  const of = !page
    ? ""
    : page.total === null
      ? "many"
      : page.totalExact
        ? page.total.toLocaleString()
        : `~${page.total.toLocaleString()}`;
  const more = page ? (page.total === null ? page.rows.length === page.limit : shownTo < page.total) : false;

  // The columns are known from the rail before any row has arrived, so the grid
  // can be drawn with its real headers while the rows are still coming. Waiting
  // to know the shape we already knew is most of what made this feel slow.
  const columns = page?.columns ?? shape?.columns ?? [];
  const primaryKey = page?.primaryKey ?? shape?.primaryKey ?? [];
  const orderedBy = page?.orderedBy ?? shape?.orderedBy ?? "";

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex h-7 items-center gap-2.5">
        <Table2 className="size-3.5 shrink-0 text-ink-3" />
        <span className="truncate font-mono text-[14px] text-ink">{table}</span>
        {/* Said, not assumed: the route decides the ordering and reports it, so
            this line and the SQL behind it cannot disagree. */}
        {orderedBy ? <span className="truncate text-[13px] text-ink-3">{orderedBy}</span> : null}
        <Button
          className={`ml-auto h-7 shrink-0 px-2 text-[13px] ${page?.filter ? "text-ink" : "text-ink-2"}`}
          disabled={columns.length === 0}
          onClick={() => setBarOpen((o) => !o)}
          size="sm"
          variant="ghost"
        >
          <FilterIcon className="size-3.5" />
          Filter
        </Button>
        <Button
          aria-label="Read this again"
          className="size-7 shrink-0 text-ink-3 hover:text-ink"
          onClick={onRefresh}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      {/* Keyed on the applied filter, so applying one re-seeds the draft and
          clearing one empties it, without a second copy of the same state. */}
      {barOpen || page?.filter ? (
        <FilterBar
          applied={page?.filter ?? null}
          columns={columns}
          key={page?.filter ? `${page.filter.column}:${page.filter.op}:${page.filter.value}` : "none"}
          onApply={applyFilter}
        />
      ) : null}

      {err ? <Empty>That could not be read. {err.slice(0, 160)}</Empty> : null}

      {/* The grid, with real headers and shimmering rows, rather than the word
          "Reading…" where the data will be. */}
      {!page && !err ? (
        columns.length > 0 ? (
          <Grid columns={columns} focus={null} onFocus={() => {}} pending={12} primaryKey={primaryKey} rows={[]} />
        ) : (
          <Empty>Reading…</Empty>
        )
      ) : null}

      {page ? (
        page.rows.length === 0 ? (
          <Empty>{page.filter ? "No rows match that." : "This table is empty."}</Empty>
        ) : (
          <>
            <Grid
              columns={page.columns}
              focus={focus}
              offset={page.offset}
              onFocus={setFocus}
              onSort={clickSort}
              primaryKey={page.primaryKey}
              rows={page.rows}
              sort={page.sort}
            />

            {focus && page.rows[focus.row] ? (
              <CellDialog
                column={focus.column}
                columns={page.columns}
                onClose={() => setFocus(null)}
                onColumn={(name) => setFocus({ row: focus.row, column: name })}
                // The saved row goes straight back into the page. Re-reading
                // would be a second request whose answer we already hold — and
                // on a sorted or filtered table it could move the row out from
                // under the panel that is still open on it.
                onSaved={(saved) =>
                  setPage((prev) =>
                    prev
                      ? { ...prev, rows: prev.rows.map((r, i) => (i === focus.row ? saved : r)) }
                      : prev,
                  )
                }
                ordinal={page.offset + focus.row + 1}
                row={page.rows[focus.row]}
                shape={{ name: page.table, columns: page.columns, primaryKey: page.primaryKey }}
                slug={slug}
              />
            ) : null}

            <div className="flex items-center gap-2">
              {/* The count keeps its `~`: an estimate that looks exact is the one
                  number on this screen somebody might act on. */}
              <span className="text-[13px] tabular-nums text-ink-2">
                {page.offset + 1}–{shownTo} of {of}
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
                disabled={!more}
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
 * The grid, for a table and for a result set alike.
 *
 * Extracted so the query editor draws its answers the way the table view draws
 * its rows. The alternative — and what it was — is a second, worse table further
 * down the page: no type labels, no right-aligned numbers, no `null` you can tell
 * from an empty string, and no way to open a jsonb value.
 *
 * A data grid, not a layout table. Everything here is one decision: the values
 * are MACHINE data, so they are set the way machine data is read. Mono, because
 * an id and a timestamp are compared character by character and the UI font gives
 * 0 and O the same width but not the same shape. 28px rows, so twice as many fit.
 * Faint vertical rules, so a column can be followed down without losing your
 * place. A sticky header, because scrolling past the names is how you end up
 * guessing which column you are reading.
 *
 * `border-separate` and not `collapse`: a collapsed border is owned by the table
 * rather than the cell, and Chrome drops it entirely on a `position: sticky` cell
 * — so freezing the key column would have erased the grid's own lines. With
 * spacing at zero the two render the same.
 *
 * THE FROZEN COLUMN'S OFFSET IS MEASURED, NOT ASSUMED. It was `left-[52px]` to
 * match a gutter declared `w-[52px]` — and a table cell's `width` is a preference,
 * not a rule, so the gutter actually rendered about 36px wide and the key column
 * pinned itself 16px to the right of it, leaving a gap with the scrolled-away
 * columns showing through. One `ResizeObserver` and the two agree by construction.
 *
 * `onSort` absent means the headers are not buttons. A result set has no column we
 * could reorder without rewriting somebody's statement.
 *
 * None of this contradicts "no mono anywhere else": everywhere else the text is
 * English.
 */
function Grid({
  columns,
  rows,
  offset = 0,
  primaryKey = [],
  sort = null,
  onSort,
  focus,
  onFocus,
  pending = 0,
}: {
  columns: Column[];
  rows: Record<string, unknown>[];
  offset?: number;
  primaryKey?: string[];
  sort?: Sort | null;
  onSort?: (column: string) => void;
  focus: { row: number; column: string } | null;
  onFocus: (f: { row: number; column: string } | null) => void;
  /** Shimmering rows to draw while the real ones are still arriving. */
  pending?: number;
}) {
  // Frozen only when the key is a single LEADING column, which is what a
  // generated schema has. A composite key would need two sticky offsets from
  // measured widths, and a key in the middle of the table would have the columns
  // before it slide underneath — both are worse than not freezing.
  const frozen =
    primaryKey.length === 1 && columns[0]?.name === primaryKey[0] ? primaryKey[0] : null;
  const pk = new Set(primaryKey);

  const gutter = useRef<HTMLTableCellElement>(null);
  const [gutterW, setGutterW] = useState(52);
  useEffect(() => {
    const el = gutter.current;
    if (!el || !frozen) return;
    const read = () => setGutterW(el.getBoundingClientRect().width);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frozen]);
  const stick = (is: boolean) => (is ? { left: gutterW } : undefined);

  return (
    <div className="max-h-[560px] overflow-auto rounded-xl border border-border">
      <table className="w-full border-separate border-spacing-0 font-mono text-[12.5px]">
        <thead>
          <tr>
            {/* The ordinal gutter. Not the primary key and not pretending to be:
                it numbers the rows ON THIS PAGE against the total, which is what
                tells you where you are in 40 rows. */}
            <th
              className="sticky left-0 top-0 z-20 border-b border-r border-border bg-tile px-2.5 py-2 text-right font-normal text-ink-3"
              ref={gutter}
            >
              #
            </th>
            {columns.map((c) => {
              const on = sort?.column === c.name;
              const isFrozen = c.name === frozen;
              return (
                <th
                  className={[
                    "top-0 select-none border-b border-r border-border bg-tile px-2.5 py-2 font-normal last:border-r-0",
                    onSort ? "cursor-pointer hover:bg-card" : "",
                    isFrozen ? "sticky z-20" : "sticky z-10",
                    isNumeric(c.type) ? "text-right" : "text-left",
                  ].join(" ")}
                  key={c.name}
                  onClick={onSort ? () => onSort(c.name) : undefined}
                  style={{ width: widthFor(c.type), ...stick(isFrozen) }}
                  title={onSort ? `Sort by ${c.name}` : c.name}
                >
                  <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    {/* The key, marked. It was known server-side all along and
                        never sent, so the one column that identifies a row looked
                        like every other. */}
                    {pk.has(c.name) ? (
                      <KeyRound aria-label="primary key" className="size-3 shrink-0 text-ink-3" />
                    ) : null}
                    <span className="text-ink">{c.name}</span>
                    {on ? (
                      sort?.dir === "asc" ? (
                        <ArrowUp className="size-3 shrink-0 text-ink" />
                      ) : (
                        <ArrowDown className="size-3 shrink-0 text-ink" />
                      )
                    ) : null}
                  </span>
                  {/* The type, dimmer and one size down. It is here because a
                      column of unreadable values needs it explained — not because
                      the schema is the point. */}
                  {c.type ? (
                    <span className="whitespace-nowrap pl-2 text-[11px] text-ink-3">{c.type}</span>
                  ) : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr className="group" key={i}>
              <td
                className="sticky left-0 z-10 border-b border-r border-border bg-ground px-2.5 py-[5px] text-right tabular-nums text-ink-3 group-hover:bg-tile"
              >
                {offset + i + 1}
              </td>
              {columns.map((c) => {
                const v = fmt(row[c.name]);
                const num = isNumeric(c.type);
                const on = focus?.row === i && focus.column === c.name;
                const isFrozen = c.name === frozen;
                return (
                  <td
                    className={[
                      "max-w-[22rem] cursor-pointer truncate border-b border-r border-border px-2.5 py-[5px] last:border-r-0 group-hover:bg-tile",
                      isFrozen ? "sticky z-10 bg-ground" : "",
                      num ? "text-right tabular-nums" : "text-left",
                      // `null` is dim AND italic. Dim alone reads as a pale
                      // string, and "null" is a value people also store as text.
                      v.dim ? "italic text-ink-3" : "text-ink",
                      on ? "bg-tile ring-1 ring-inset ring-ink-3" : "",
                    ].join(" ")}
                    key={c.name}
                    onClick={() => onFocus(on ? null : { row: i, column: c.name })}
                    style={stick(isFrozen)}
                    title={v.text}
                  >
                    {v.text}
                  </td>
                );
              })}
            </tr>
          ))}
          {rows.length === 0 && pending > 0
            ? Array.from({ length: pending }, (_, i) => (
                <tr key={`p${i}`}>
                  <td className="sticky left-0 z-10 border-b border-r border-border bg-ground px-2.5 py-[5px] text-right text-ink-3">
                    {i + 1}
                  </td>
                  {columns.map((c) => (
                    <td
                      className="border-b border-r border-border px-2.5 py-[5px] last:border-r-0"
                      key={c.name}
                    >
                      <Skeleton className="h-3" style={{ width: `${40 + ((i * 13 + c.name.length * 7) % 45)}%` }} />
                    </td>
                  ))}
                </tr>
              ))
            : null}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One filter: a column, a comparison, and something to compare against.
 *
 * One, not many, because the question this screen answers is "is MY row there"
 * and one clause answers it. Several clauses need an AND/OR tree, which is a
 * query builder, which is what the SQL box is for.
 *
 * Held as a DRAFT until it is applied. Filtering per keystroke would fire a read
 * for every prefix of what somebody is typing, and a half-typed email matches
 * rows that are not theirs — so the grid would answer the question wrongly on the
 * way to answering it right.
 */
function FilterBar({
  columns,
  applied,
  onApply,
}: {
  columns: Column[];
  applied: Filter | null;
  onApply: (f: Filter | null) => void;
}) {
  const [column, setColumn] = useState(applied?.column ?? columns[0]?.name ?? "");
  const [op, setOp] = useState<FilterOp>(applied?.op ?? "eq");
  const [value, setValue] = useState(applied?.value ?? "");

  const needsValue = opTakesValue(op);
  const ready = column !== "" && (!needsValue || value !== "");
  const submit = () => { if (ready) onApply({ column, op, value: needsValue ? value : "" }); };

  if (columns.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5">
      <Picker label={column || "column"} mono width="max-h-[280px]">
        {columns.map((c) => (
          <DropdownMenuItem className="font-mono text-[12.5px]" key={c.name} onClick={() => setColumn(c.name)}>
            {c.name}
            <span className="ml-auto pl-3 text-[11px] text-ink-3">{c.type}</span>
          </DropdownMenuItem>
        ))}
      </Picker>

      <Picker label={OP_LABEL[op]}>
        {FILTER_OPS.map((o) => (
          <DropdownMenuItem key={o} onClick={() => setOp(o)}>{OP_LABEL[o]}</DropdownMenuItem>
        ))}
      </Picker>

      {needsValue ? (
        <Input
          aria-label="Value"
          className="h-8 w-[220px] font-mono text-[12.5px]"
          onChange={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="value"
          value={value}
        />
      ) : null}

      <Button className="h-8 px-3 text-[13px]" disabled={!ready} onClick={submit} size="sm">
        Apply
      </Button>
      {applied ? (
        <Button
          className="h-8 px-2 text-[13px] text-ink-2 hover:text-ink"
          onClick={() => onApply(null)}
          size="sm"
          variant="ghost"
        >
          <X className="size-3.5" />
          Clear
        </Button>
      ) : null}
    </div>
  );
}

/** A dropdown that looks like the one in the app list, because it is the same one. */
function Picker({
  label,
  mono,
  width,
  children,
}: {
  label: string;
  mono?: boolean;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className={`h-8 px-2.5 text-[13px] ${mono ? "font-mono text-[12.5px]" : ""}`} size="sm" variant="outline">
          {label}
          <ChevronDown className="size-3.5 text-ink-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={`overflow-auto ${width ?? ""}`}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}


/**
 * One cell, in a modal — and, when it is a cell we can name, changeable.
 *
 * It was a panel under the grid, which meant the values it exists for competed
 * for the page with the rows they came from: opening a 4KB jsonb pushed the
 * footer off screen and left you scrolling between the value and the row. A
 * modal gives the whole width and height to the one thing you asked to see, and
 * closes back to exactly where you were.
 *
 * The rest of the row comes along on the right. The reason to open a cell is
 * almost always to work out which row it belongs to, and each of those fields is
 * itself a button, so reading across a row is clicking down a list rather than
 * closing this and hunting for the next cell.
 *
 * EDITING lives here and nowhere else. `shape` is null for a query's results, and
 * then there is no edit at all — the rows of a join have no identity to write
 * back to, and pretending otherwise would be the most expensive kind of guess. On
 * a table, `editRefusal` decides, and its answer is SHOWN when it is no: "why
 * can't I change this" is a question, and the sentence is the answer to it.
 */
function CellDialog({
  columns,
  column,
  row,
  ordinal,
  shape,
  slug,
  onColumn,
  onClose,
  onSaved,
}: {
  columns: Column[];
  column: string;
  row: Record<string, unknown>;
  ordinal: number;
  /** The table these rows came from, or null for a query's results. */
  shape: TableShape | null;
  slug: string;
  onColumn: (name: string) => void;
  onClose: () => void;
  onSaved?: (row: Record<string, unknown>) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const col = columns.find((c) => c.name === column);
  const v = full(row[column]);
  const refusal = shape && col ? editRefusal(shape, col) : null;
  const canEdit = Boolean(shape && col && onSaved && !refusal);

  // A different cell is a different edit. Leaving a draft behind would offer
  // somebody the last cell's text as this cell's new value.
  useEffect(() => {
    setCopied(false);
    setEditing(false);
    setSaveErr(null);
  }, [column, ordinal]);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(raw(row[column])).then(() => setCopied(true));
  }, [row, column]);

  async function save(to: string | null) {
    if (!shape || !col) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/db/row`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table: shape.name,
          column: col.name,
          // Every key column, from the row we are looking at.
          key: Object.fromEntries(shape.primaryKey.map((k) => [k, row[k]])),
          // The value we were SHOWN, so the write refuses if somebody else got
          // here first. Not the rendered text — the value, as it arrived.
          from: row[col.name] ?? null,
          to,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setSaveErr(String(d.error ?? "That did not save."));
        return;
      }
      onSaved?.(d.row);
      setEditing(false);
    } catch {
      setSaveErr("That did not save. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      onOpenChange={(o) => {
        if (o) return;
        // Escape backs out one step at a time: out of the edit, then out of the
        // modal. Closing on the first press would throw away something typed.
        if (editing) setEditing(false);
        else onClose();
      }}
      open
    >
      <DialogContent className="max-w-3xl gap-0 overflow-hidden rounded-xl p-0">
        <DialogTitle className="sr-only">
          {column}, row {ordinal}
        </DialogTitle>

        <div className="flex items-center gap-2 border-b border-border bg-tile px-4 py-2.5 pr-12">
          {shape ? (
            <span className="shrink-0 truncate font-mono text-[12.5px] text-ink-3">
              {shape.name}.
            </span>
          ) : null}
          <span className="-ml-2 truncate font-mono text-[13px] text-ink">{column}</span>
          {col?.type ? <span className="truncate text-[11.5px] text-ink-3">{col.type}</span> : null}
          <span className="ml-auto shrink-0 text-[12px] tabular-nums text-ink-3">row {ordinal}</span>

          {refusal ? (
            <span className="shrink-0 text-[12px] text-ink-3">{refusal}</span>
          ) : canEdit && !editing ? (
            <Button
              className="h-7 shrink-0 px-2 text-[12.5px] text-ink-2 hover:text-ink"
              onClick={() => { setDraft(raw(row[column])); setEditing(true); }}
              size="sm"
              variant="ghost"
            >
              <Pencil className="size-3" />
              Edit
            </Button>
          ) : null}

          <Button
            aria-label="Copy value"
            className="size-7 shrink-0 text-ink-3 hover:text-ink"
            onClick={copy}
            size="icon-sm"
            variant="ghost"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </div>

        <div className="flex items-stretch">
          <div className="flex min-w-0 flex-1 flex-col">
            {editing ? (
              <>
                <textarea
                  aria-label={`New value for ${column}`}
                  autoFocus
                  className="block max-h-[44vh] min-h-[180px] w-full resize-none bg-card px-4 py-3 font-mono text-[12.5px] leading-[1.6] text-ink outline-none"
                  onChange={(e) => setDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void save(draft); }
                  }}
                  spellCheck={false}
                  value={draft}
                />
                <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
                  <Button className="h-7 px-2.5 text-[13px]" disabled={saving} onClick={() => void save(draft)} size="sm">
                    Save
                  </Button>
                  <span className="text-[12px] text-ink-3">⌘↵</span>
                  {/* An empty box means an empty string. NULL is a different value
                      and gets its own button, offered only where the column admits
                      one — the two are exactly what this screen exists to tell
                      apart. */}
                  {col?.nullable && row[column] !== null ? (
                    <Button
                      className="h-7 px-2.5 text-[13px]"
                      disabled={saving}
                      onClick={() => void save(null)}
                      size="sm"
                      variant="outline"
                    >
                      Set null
                    </Button>
                  ) : null}
                  <Button
                    className="h-7 px-2 text-[13px] text-ink-2 hover:text-ink"
                    disabled={saving}
                    onClick={() => setEditing(false)}
                    size="sm"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                  {saveErr ? <span className="text-[12.5px] text-red">{saveErr}</span> : null}
                </div>
              </>
            ) : (
              <pre
                className={`max-h-[52vh] min-h-[180px] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12.5px] leading-[1.6] ${
                  v.dim ? "italic text-ink-3" : "text-ink"
                }`}
              >
                {v.text}
              </pre>
            )}
          </div>

          <div className="max-h-[52vh] w-[224px] shrink-0 overflow-auto border-l border-border">
            {columns.map((c) => {
              const cell = fmt(row[c.name]);
              const is = c.name === column;
              return (
                <button
                  className={[
                    "flex w-full flex-col items-start gap-px border-b border-border px-3 py-1.5 text-left last:border-b-0",
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
      </DialogContent>
    </Dialog>
  );
}

/**
 * The last few statements somebody ran here.
 *
 * In `localStorage` and not on the server, deliberately. A query is a question
 * about your own data — sometimes it is `SELECT * FROM users WHERE email = …` —
 * and keeping a list of them on our side is retaining something on somebody's
 * behalf that they did not ask us to retain. The browser it was typed in is the
 * right place for it, and clearing site data is the right way to be rid of it.
 */
const HISTORY_MAX = 8;
const historyKey = (slug: string) => `bay:db:sql:${slug}`;

function readHistory(slug: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(historyKey(slug)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, HISTORY_MAX) : [];
  } catch {
    // A corrupt or unavailable store loses a convenience, never the screen.
    return [];
  }
}

function writeHistory(slug: string, sql: string, prev: string[]): string[] {
  const next = [sql, ...prev.filter((s) => s !== sql)].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(historyKey(slug), JSON.stringify(next));
  } catch { /* private mode, or a full quota. Not worth a message. */ }
  return next;
}

/**
 * SQL, as a place rather than an escape hatch.
 *
 * It was one line in a `<details>` at the bottom of the page, results in a
 * cramped table of its own, nothing remembered and nothing shareable. Which meant
 * the answer to "the filter cannot express my question" was a worse version of
 * the screen you were already on.
 *
 * So: a real editor, ⌘↵ to run, the answers in the SAME grid as a table — so a
 * jsonb value still opens and a number is still right-aligned — the statement in
 * the URL so a question can be sent to somebody, and the last few in this
 * browser.
 *
 * The rules did not move. One statement, SELECT only, a bounded timeout, all of
 * them server-side in the route, because that is where a boundary has to be: this
 * component is a convenience in front of it and could be replaced by curl.
 */
function SqlPane({
  slug,
  q,
  setQ,
}: {
  slug: string;
  q: Record<(typeof VIEW_KEYS)[number], string | null>;
  setQ: (patch: Partial<Record<(typeof VIEW_KEYS)[number], string | null>>, mode?: "push" | "replace") => void;
}) {
  const [draft, setDraft] = useState(q.sql ?? "");
  const [out, setOut] = useState<{ columns: Column[]; rows: Record<string, unknown>[]; truncated?: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<{ row: number; column: string } | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  const run = useCallback(
    (sql: string, mode: "push" | "replace" = "push") => {
      const s = sql.trim();
      if (!s) return;
      setBusy(true);
      setErr(null);
      setFocus(null);
      // Pushed, not replaced: the back button walking back through the questions
      // you asked is the right behaviour for a place you explore in. Replaced on
      // arrival, though — a link that ran itself did not navigate anywhere, and
      // pushing there would cost two presses of Back to leave.
      setQ({ pane: "sql", sql: s }, mode);
      setHistory((prev) => writeHistory(slug, s, prev));
      fetch(`/api/apps/${encodeURIComponent(slug)}/db`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: s }),
      })
        .then((r) => r.json())
        .then((d) => (d.error ? setErr(String(d.error)) : setOut(d)))
        .catch((e) => setErr(String(e)))
        .finally(() => setBusy(false));
    },
    [slug, setQ],
  );

  // A statement arriving in the URL is somebody following a link, and a link to a
  // question should show its answer rather than a filled-in box and a Run button.
  // Once, on mount — after that, running is a deliberate act.
  useEffect(() => {
    setHistory(readHistory(slug));
    if (q.sql) run(q.sql, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="overflow-hidden rounded-xl border border-border">
        <textarea
          aria-label="SQL"
          className="block max-h-[240px] min-h-[92px] w-full resize-y bg-card px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] text-ink outline-none placeholder:text-ink-3"
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              run(draft);
            }
          }}
          placeholder="SELECT * FROM orders WHERE total_cents > 5000"
          spellCheck={false}
          value={draft}
        />
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <Button className="h-7 px-2.5 text-[13px]" disabled={busy || draft.trim() === ""} onClick={() => run(draft)} size="sm">
            <Play className="size-3.5" />
            Run
          </Button>
          <span className="text-[12px] text-ink-3">⌘↵</span>
          {history.length > 0 ? (
            <div className="ml-auto">
              <Picker label="Recent" width="max-h-[280px] w-[420px]">
                {history.map((h) => (
                  <DropdownMenuItem
                    className="font-mono text-[12px]"
                    key={h}
                    onClick={() => { setDraft(h); run(h); }}
                  >
                    <span className="truncate">{h}</span>
                  </DropdownMenuItem>
                ))}
              </Picker>
            </div>
          ) : null}
        </div>
      </div>

      {err ? <Empty>{err.slice(0, 400)}</Empty> : null}
      {busy && !out ? <Empty>Running…</Empty> : null}

      {out && !err ? (
        out.rows.length === 0 ? (
          <Empty>0 rows.</Empty>
        ) : (
          <>
            <Grid
              columns={out.columns}
              focus={focus}
              onFocus={setFocus}
              rows={out.rows}
            />
            {focus && out.rows[focus.row] ? (
              <CellDialog
                column={focus.column}
                columns={out.columns}
                onClose={() => setFocus(null)}
                onColumn={(name) => setFocus({ row: focus.row, column: name })}
                ordinal={focus.row + 1}
                row={out.rows[focus.row]}
                // No shape, so no edit. A row of a join or a GROUP BY has no
                // identity to write back to.
                shape={null}
                slug={slug}
              />
            ) : null}
            <span className="text-[13px] tabular-nums text-ink-2">
              {/* Said, because a truncated answer that looks complete is worse
                  than a slow one. The LIMIT is theirs to choose. */}
              {out.truncated
                ? `first ${out.rows.length.toLocaleString()} rows — add a LIMIT to choose`
                : `${out.rows.length.toLocaleString()} ${out.rows.length === 1 ? "row" : "rows"}`}
            </span>
          </>
        )
      ) : null}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3.5 text-[14px] text-ink-2">
      {children}
    </div>
  );
}
