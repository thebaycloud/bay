/**
 * Which column carries recency, which order rows come back in, and the SQL that
 * expresses both.
 *
 * Pure functions over a DESCRIPTION of a table rather than a connection, because
 * the rules here are the kind that quietly stop being true — "prefer created_at
 * over ts", "never updated_at", "the primary key only counts when it is a single
 * integer" — and a rule nothing can test is a rule nobody can change safely.
 *
 * The view these serve answers one question: did the data land. Not what the
 * schema is. See docs/superpowers/specs/2026-08-20-database-view-design.md.
 */

/** One column, as `information_schema.columns` describes it. */
export interface Column {
  name: string;
  /** `data_type`: "integer", "timestamp with time zone", "text", … */
  type: string;
}

/** Everything the rules below need to know about a table. */
export interface TableShape {
  name: string;
  columns: Column[];
  /** Column names making up the primary key, in order. Empty when there is none. */
  primaryKey: string[];
}

/**
 * Names that mean "when this row ARRIVED", best first.
 *
 * This list DISAMBIGUATES; it does not admit. A table with several clocks needs
 * to be told which one means arrival, and that is all this is for — see
 * `recencyColumn`, where a table with exactly one clock does not consult it.
 */
const RECENCY_NAMES = [
  "created_at", "inserted_at", "created", "inserted",
  "added_at", "at", "ts", "time", "timestamp",
] as const;

/**
 * Names that are timestamps and are NOT arrival, whatever else is in the table.
 *
 * The deny list is what makes "one clock is the clock" safe. Without it, a table
 * whose single temporal column is `expires_at` would report an expiry as the
 * moment data landed — confidently, and in the one screen whose job is telling
 * the truth about data.
 *
 * `updated_at` is the important one and the reason this list exists at all: it
 * answers "when did this row last CHANGE", which reads as arrival and is not. A
 * table whose rows are edited would otherwise report a freshness that has
 * nothing to do with anything landing.
 */
const NOT_ARRIVAL = [
  "updated_at", "modified_at", "changed_at", "edited_at",
  "expires_at", "expired_at", "deleted_at", "removed_at", "archived_at",
  "starts_at", "ends_at", "scheduled_at", "due_at", "published_at",
] as const;

const isTemporal = (type: string): boolean =>
  /^(timestamp|date)\b/i.test(type.trim());

const isInteger = (type: string): boolean =>
  /^(integer|bigint|smallint|serial|bigserial|int\d?)\b/i.test(type.trim());

/**
 * The column that says when a row arrived, or null.
 *
 * Null is an answer, not a failure: a table without one gets NO freshness in the
 * view rather than an invented one.
 *
 * The TYPE does the admitting and the NAME only disambiguates, which is the
 * opposite of how this started. It began as a name list, and the platform's own
 * `pgapp` example — deployed to production to check this very thing — has a
 * `timestamptz` column called `at`. It was the only clock in the table and the
 * view stayed silent about time, correctly by the old rule and uselessly. Adding
 * "at" to a list would have fixed that one case and left the next name to be
 * discovered the same way.
 *
 * So: with exactly ONE temporal column there is nothing to disambiguate, and it
 * is the clock — unless its name says otherwise, which is what `NOT_ARRIVAL` is
 * for. With several, the name list picks; if none of them match, silence,
 * because guessing between two clocks is worse than admitting we cannot tell.
 */
export function recencyColumn(table: TableShape): string | null {
  const temporal = table.columns.filter((c) => isTemporal(c.type));
  const candidates = temporal.filter((c) => !NOT_ARRIVAL.includes(c.name.toLowerCase() as never));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].name;

  for (const wanted of RECENCY_NAMES) {
    const hit = candidates.find((c) => c.name.toLowerCase() === wanted);
    if (hit) return hit.name;
  }
  return null;
}

/** How the rows in a table are ordered, and how honest that ordering is. */
export type Ordering =
  /** By a column that records arrival. The strongest claim available. */
  | { by: "recency"; column: string }
  /**
   * By a single integer primary key, descending.
   *
   * Monotonic for anything backed by a sequence, which is what a generated app
   * uses. A composite key is skipped — its parts have no combined order that
   * means anything — and so is a uuid, which is random.
   */
  | { by: "key"; column: string }
  /**
   * Whatever Postgres returns.
   *
   * Roughly insertion order for an append-only table, and NOT after an update or
   * a vacuum. The view says so rather than presenting it as time.
   */
  | { by: "physical" };

export function orderingFor(table: TableShape): Ordering {
  const recency = recencyColumn(table);
  if (recency) return { by: "recency", column: recency };

  if (table.primaryKey.length === 1) {
    const pk = table.columns.find((c) => c.name === table.primaryKey[0]);
    if (pk && isInteger(pk.type)) return { by: "key", column: pk.name };
  }
  return { by: "physical" };
}

/** What to tell the user the order means. Their words, not Postgres's. */
export function describeOrdering(o: Ordering): string {
  switch (o.by) {
    case "recency": return `newest first, by ${o.column}`;
    case "key": return `newest first, by ${o.column}`;
    // Never "newest first": it usually is, and usually is not a claim to make.
    case "physical": return "in table order — this table records no arrival time";
  }
}

/**
 * Identifiers are interpolated, not bound
 *
 * The caller checks EXISTENCE separately. This says a name is safe to
 * interpolate, never that it is real.
 */
export const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isSafeIdent(name: string): boolean {
  return SAFE_IDENT.test(name);
}

/** How many rows a single page may hold, whatever the caller asks for. */
export const MAX_PAGE = 200;
export const DEFAULT_PAGE = 50;

export function pageSize(requested: unknown): number {
  const n = typeof requested === "string" ? Number(requested) : Number(requested ?? NaN);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
  return Math.min(Math.floor(n), MAX_PAGE);
}

export function pageOffset(requested: unknown): number {
  const n = typeof requested === "string" ? Number(requested) : Number(requested ?? NaN);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/* -------------------------------------------------------------------------- */
/*  What the person asked to see: an order of their own, and one filter.       */
/* -------------------------------------------------------------------------- */

/**
 * A sort the PERSON chose, as opposed to the `Ordering` this module chooses for
 * them. Both end up in the same ORDER BY; they are separate types because only
 * one of them is a claim we make ("newest first") and the other is an instruction
 * we were given.
 */
export type SortDir = "asc" | "desc";
export interface Sort {
  column: string;
  dir: SortDir;
}

/**
 * The comparisons a filter may make. An ALLOW LIST, and the only place operators
 * are named — the SQL below maps from this and nothing else, so an operator that
 * is not on this list has no path into a statement.
 *
 * `contains` and `starts` cast to text before matching, because the commonest
 * question on this screen is "is MY row there" and the answer is usually part of
 * an id or an email. Casting means those work on a uuid and an integer too.
 *
 * `null` and `notnull` take no value, which is why `opTakesValue` exists: an
 * empty box means "not filtering yet" for every other operator and means the
 * filter itself for these two.
 */
export const FILTER_OPS = [
  "eq", "neq", "gt", "gte", "lt", "lte", "contains", "starts", "null", "notnull",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface Filter {
  column: string;
  op: FilterOp;
  value: string;
}

export function opTakesValue(op: FilterOp): boolean {
  return op !== "null" && op !== "notnull";
}

/** What the person asked for, once it has been checked. */
export interface View {
  sort?: Sort | null;
  filter?: Filter | null;
}

/**
 * The outcome of reading one of these out of a query string.
 *
 * Three outcomes, not two, and the difference between the second and the third
 * is the whole point:
 *
 *   `{ok: true, value: <it>}`   — asked for, and applied.
 *   `{ok: true, value: null}`   — not asked for, OR asked for on a column this
 *                                 table does not have. A link made before a
 *                                 migration is STALE, not hostile, and the right
 *                                 answer to it is the table's own ordering
 *                                 rather than an error page.
 *   `{ok: false, error}`        — the name could not be an identifier at all.
 *                                 That is a bug or an attack, and it is REFUSED
 *                                 here rather than passed to Postgres to refuse.
 */
export type Parsed<T> = { ok: true; value: T | null } | { ok: false; error: string };

function checkedColumn(t: TableShape, raw: unknown): Parsed<string> {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  const name = String(raw);
  // Shape first: this is the check standing between a query string and an
  // interpolated identifier, so it runs before anything else looks at the name.
  if (!isSafeIdent(name)) return { ok: false, error: `invalid column name: ${name}` };
  // Existence second, and deliberately not an error.
  if (!t.columns.some((c) => c.name === name)) return { ok: true, value: null };
  return { ok: true, value: name };
}

export function parseSort(t: TableShape, column: unknown, dir: unknown): Parsed<Sort> {
  const col = checkedColumn(t, column);
  if (!col.ok) return col;
  if (col.value === null) return { ok: true, value: null };
  // Anything that is not "asc" is descending. A direction is not worth a 400:
  // the column is the part that could carry an injection, and this cannot.
  const d = String(dir ?? "desc").toLowerCase() === "asc" ? "asc" : "desc";
  return { ok: true, value: { column: col.value, dir: d } };
}

export function parseFilter(
  t: TableShape,
  column: unknown,
  op: unknown,
  value: unknown,
): Parsed<Filter> {
  const col = checkedColumn(t, column);
  if (!col.ok) return col;
  if (col.value === null) return { ok: true, value: null };

  const o = String(op ?? "eq").toLowerCase();
  if (!(FILTER_OPS as readonly string[]).includes(o)) {
    return { ok: false, error: `unknown operator: ${o}` };
  }
  const f = o as FilterOp;

  const v = value === null || value === undefined ? "" : String(value);
  // Mid-typing is not a filter. No rows are hidden on the strength of an empty
  // box — except for the two operators whose whole meaning is emptiness.
  if (opTakesValue(f) && v === "") return { ok: true, value: null };

  return { ok: true, value: { column: col.value, op: f, value: v } };
}

/* -------------------------------------------------------------------------- */
/*  The SQL.                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A statement and the values bound into it.
 *
 * Identifiers are interpolated because Postgres has no parameter slot for a
 * column name; VALUES never are. That split is the reason this returns a pair
 * instead of a string — a builder that returned only a string would have had to
 * put the person's search text inside it.
 */
export interface Sql {
  text: string;
  values: unknown[];
}

const CMP: Record<"eq" | "neq" | "gt" | "gte" | "lt" | "lte", string> = {
  eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=",
};

/**
 * `%` and `_` are wildcards to LIKE and characters to everybody else.
 *
 * Somebody searching for `order_id` means an underscore. Unescaped it matches any
 * character, so the filter quietly returns more rows than asked for — which on
 * this screen means answering "is my row there" with somebody else's row.
 */
function likeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function whereClause(f: Filter | null | undefined, values: unknown[]): string {
  if (!f) return "";
  const col = `"${assertIdent(f.column)}"`;
  if (f.op === "null") return ` WHERE ${col} IS NULL`;
  if (f.op === "notnull") return ` WHERE ${col} IS NOT NULL`;
  if (f.op === "contains" || f.op === "starts") {
    const pattern = likeLiteral(f.value);
    values.push(f.op === "contains" ? `%${pattern}%` : `${pattern}%`);
    return ` WHERE ${col}::text ILIKE $${values.length}`;
  }
  values.push(f.value);
  return ` WHERE ${col} ${CMP[f.op]} $${values.length}`;
}

function orderClause(o: Ordering, sort: Sort | null | undefined): string {
  // The person's choice wins over ours, and is stated as theirs — see
  // `describeSort`, so the line above the grid never claims "newest first" about
  // a column they sorted alphabetically.
  if (sort) {
    return ` ORDER BY "${assertIdent(sort.column)}" ${sort.dir === "asc" ? "ASC" : "DESC"} NULLS LAST`;
  }
  return o.by === "physical" ? "" : ` ORDER BY "${assertIdent(o.column)}" DESC NULLS LAST`;
}

/**
 * The rows of one page, newest first where that means anything.
 *
 * Ordering is chosen by `orderingFor` and stated by `describeOrdering`, so the
 * SQL and the sentence shown above it cannot disagree — which they would, given
 * two places to decide the same thing.
 */
export function pageQuery(
  table: TableShape,
  o: Ordering,
  limit: number,
  offset: number,
  view: View = {},
): Sql {
  if (!isSafeIdent(table.name)) throw new Error(`unsafe table name: ${table.name}`);
  const values: unknown[] = [];
  const where = whereClause(view.filter, values);
  const order = orderClause(o, view.sort);
  return {
    text: `SELECT * FROM "${table.name}"${where}${order} LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)}`,
    values,
  };
}

/**
 * How many rows the page is a page OF.
 *
 * Takes the same filter as `pageQuery` and for the same reason the ordering is
 * shared: a total counted without the filter is a total of a different thing, and
 * the footer would page past the end of what it is showing.
 */
export function countQuery(table: TableShape, filter?: Filter | null): Sql {
  if (!isSafeIdent(table.name)) throw new Error(`unsafe table name: ${table.name}`);
  const values: unknown[] = [];
  const where = whereClause(filter, values);
  return { text: `SELECT count(*)::text AS n FROM "${table.name}"${where}`, values };
}

/** Their order, in their words — never "newest first", which is our claim. */
export function describeSort(s: Sort): string {
  return `by ${s.column}, ${s.dir === "desc" ? "descending" : "ascending"}`;
}

function assertIdent(name: string): string {
  if (!isSafeIdent(name)) throw new Error(`unsafe column name: ${name}`);
  return name;
}
