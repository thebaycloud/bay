"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown, ArrowUp, Check, ChevronDown, Copy, Filter as FilterIcon, KeyRound,
  Play, RefreshCw, Table2, Terminal, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { FILTER_OPS, opTakesValue, type Filter, type FilterOp, type Sort } from "@/lib/db-browse";
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
  // The SQL surface reports Postgres's own `typname`, so the same helper has to
  // recognise `int4` and `float8` as well as "integer" and "double precision".
  "float",
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
  const [q, setQ] = useQueryRecord(VIEW_KEYS);
  // Bumped by the one refresh button, which re-reads the counts AND the open
  // page: the point of this screen is watching data arrive, and it only ever
  // read on mount.
  const [nonce, setNonce] = useState(0);

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
  }, [slug, hasDb, nonce]);

  // The URL is a request, not a fact. `?table=` is only honoured once the listing
  // says such a table exists — otherwise a stale link fires a request that can
  // only come back as an error, and the first table is a better answer than one.
  const open = useMemo(() => {
    if (!tables || tables.length === 0) return null;
    if (q.table && tables.some((t) => t.name === q.table)) return q.table;
    return tables[0].name;
  }, [tables, q.table]);

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

  const sqlPane = q.pane === "sql";

  return (
    <div className="flex items-start gap-3">
      <TableList
        // A sort or a filter belongs to the table it was made on. Carrying
        // `sort=total` into `customers` would either error or, worse, be
        // silently dropped while the URL still claimed it.
        onOpen={(t) =>
          setQ({ table: t, pane: null, sort: null, dir: null, where: null, op: null, value: null })
        }
        // The table state is kept, not cleared: coming back from SQL should land
        // on the table and the filter you left, not on the top of the list.
        onSql={() => setQ({ pane: "sql" })}
        open={sqlPane ? null : open}
        sqlOpen={sqlPane}
        tables={tables}
      />
      <div className="min-w-0 flex-1">
        {sqlPane ? (
          <SqlPane q={q} setQ={setQ} slug={slug} />
        ) : tables.length === 0 ? (
          <Empty>No tables yet — nothing has written to this database.</Empty>
        ) : open ? (
          <TableView
            key={open}
            nonce={nonce}
            onRefresh={() => setNonce((n) => n + 1)}
            q={q}
            setQ={setQ}
            slug={slug}
            table={open}
          />
        ) : null}
      </div>
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
  sqlOpen,
  onOpen,
  onSql,
}: {
  tables: TableSummary[];
  open: string | null;
  sqlOpen: boolean;
  onOpen: (t: string) => void;
  onSql: () => void;
}) {
  return (
    <div className="max-h-[560px] w-[224px] shrink-0 overflow-auto rounded-xl border border-border">
      {/* SQL as a row zero rather than a drawer at the bottom of the page.
          It was a `<details>` summary reading "Ask it something else", which is
          where you put a thing you hope nobody needs — and the whole reason
          somebody opens it is that the filter above could not express their
          question. Here it sits alongside the tables, which is what it is. */}
      <button
        aria-current={sqlOpen ? "true" : undefined}
        className={[
          "flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left",
          sqlOpen ? "bg-tile" : "hover:bg-tile",
        ].join(" ")}
        onClick={onSql}
        type="button"
      >
        <Terminal className="size-3.5 shrink-0 text-ink-3" />
        <span className={`text-[13px] ${sqlOpen ? "text-ink" : "text-ink-2"}`}>SQL</span>
      </button>

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

function TableView({
  slug,
  table,
  q,
  setQ,
  nonce,
  onRefresh,
}: {
  slug: string;
  table: string;
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
  // timed out used to arrive as 0, so the footer read "1–50 of ~0" underneath
  // fifty visible rows.
  const of = !page
    ? ""
    : page.total === null
      ? "many"
      : page.totalExact
        ? page.total.toLocaleString()
        : `~${page.total.toLocaleString()}`;
  const more = page ? (page.total === null ? page.rows.length === page.limit : shownTo < page.total) : false;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex h-7 items-center gap-2.5">
        <Table2 className="size-3.5 shrink-0 text-ink-3" />
        <span className="truncate font-mono text-[14px] text-ink">{table}</span>
        {/* Said, not assumed: the route decides the ordering and reports it, so
            this line and the SQL behind it cannot disagree. */}
        {page ? <span className="truncate text-[13px] text-ink-3">{page.orderedBy}</span> : null}
        <Button
          className={`ml-auto h-7 shrink-0 px-2 text-[13px] ${page?.filter ? "text-ink" : "text-ink-2"}`}
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
          columns={page?.columns ?? []}
          key={page?.filter ? `${page.filter.column}:${page.filter.op}:${page.filter.value}` : "none"}
          onApply={applyFilter}
        />
      ) : null}

      {err ? <Empty>That could not be read. {err.slice(0, 160)}</Empty> : null}
      {!page && !err ? <Empty>Reading…</Empty> : null}

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
 * Extracted so the SQL surface draws its answers the way the table view draws its
 * rows. The alternative — and what it was — is a second, worse table further down
 * the page: no type labels, no right-aligned numbers, no `null` you can tell from
 * an empty string, and no way to open a jsonb value. Somebody who reaches for SQL
 * because a single filter could not express their question should not lose the
 * grid as the price of asking.
 *
 * A data grid, not a layout table. Everything here is one decision: the values
 * are MACHINE data, so they are set the way machine data is read. Mono, because
 * an id and a timestamp are compared character by character and the UI font gives
 * 0 and O the same width but not the same shape. 28px rows, so twice as many fit.
 * Faint vertical rules, so a column can be followed down without losing your
 * place. A sticky header, because scrolling past the names is how you end up
 * guessing which column you are reading.
 *
 * `border-separate` and not `collapse`, which is what it was: a collapsed border
 * is owned by the table rather than the cell, and Chrome drops it entirely on a
 * `position: sticky` cell — so freezing the key column would have erased the
 * grid's own lines. With spacing at zero the two render the same.
 *
 * `onSort` absent means the headers are not buttons. A result set has no column
 * we could reorder without rewriting somebody's statement.
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
}: {
  columns: Column[];
  rows: Record<string, unknown>[];
  offset?: number;
  primaryKey?: string[];
  sort?: Sort | null;
  onSort?: (column: string) => void;
  focus: { row: number; column: string } | null;
  onFocus: (f: { row: number; column: string } | null) => void;
}) {
  // Frozen only when the key is a single LEADING column, which is what a
  // generated schema has. A composite key would need two sticky offsets from
  // measured widths, and a key in the middle of the table would have the columns
  // before it slide underneath — both are worse than not freezing.
  const frozen =
    primaryKey.length === 1 && columns[0]?.name === primaryKey[0] ? primaryKey[0] : null;
  const pk = new Set(primaryKey);

  return (
    <div className="max-h-[560px] overflow-auto rounded-xl border border-border">
      <table className="w-full border-separate border-spacing-0 font-mono text-[12.5px]">
        <thead>
          <tr>
            {/* The ordinal gutter. Not the primary key and not pretending to be:
                it numbers the rows ON THIS PAGE against the total, which is what
                tells you where you are in 40 rows. */}
            <th className="sticky left-0 top-0 z-20 w-[52px] border-b border-r border-border bg-tile px-2.5 py-2 text-right font-normal text-ink-3">
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
                    isFrozen ? "sticky left-[52px] z-20" : "sticky z-10",
                    isNumeric(c.type) ? "text-right" : "text-left",
                  ].join(" ")}
                  key={c.name}
                  onClick={onSort ? () => onSort(c.name) : undefined}
                  style={{ width: widthFor(c.type) }}
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
              <td className="sticky left-0 z-10 border-b border-r border-border bg-ground px-2.5 py-[5px] text-right tabular-nums text-ink-3 group-hover:bg-tile">
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
                      isFrozen ? "sticky left-[52px] z-10 bg-ground" : "",
                      num ? "text-right tabular-nums" : "text-left",
                      // `null` is dim AND italic. Dim alone reads as a pale
                      // string, and "null" is a value people also store as text.
                      v.dim ? "italic text-ink-3" : "text-ink",
                      on ? "bg-tile ring-1 ring-inset ring-ink-3" : "",
                    ].join(" ")}
                    key={c.name}
                    onClick={() => onFocus(on ? null : { row: i, column: c.name })}
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
              <CellPanel
                column={focus.column}
                columns={out.columns}
                onClose={() => setFocus(null)}
                onColumn={(name) => setFocus({ row: focus.row, column: name })}
                ordinal={focus.row + 1}
                row={out.rows[focus.row]}
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
