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
 * `updated_at` is deliberately absent. It answers "when did this row last
 * change", which reads as arrival and is not — a table whose rows are edited
 * would report freshness that has nothing to do with anything landing.
 */
const RECENCY_NAMES = [
  "created_at", "inserted_at", "created", "inserted",
  "added_at", "ts", "time", "timestamp",
] as const;

const isTemporal = (type: string): boolean =>
  /^(timestamp|date)\b/i.test(type.trim());

const isInteger = (type: string): boolean =>
  /^(integer|bigint|smallint|serial|bigserial|int\d?)\b/i.test(type.trim());

/**
 * The column that says when a row arrived, or null.
 *
 * Null is an answer, not a failure: a table without one gets NO freshness in the
 * view rather than an invented one. Matching on name and on type together —
 * a `created_at` holding text is not a clock, and a timestamp called `expires_at`
 * is not an arrival.
 */
export function recencyColumn(table: TableShape): string | null {
  for (const wanted of RECENCY_NAMES) {
    const hit = table.columns.find(
      (c) => c.name.toLowerCase() === wanted && isTemporal(c.type),
    );
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
 * Identifiers are interpolated, not bound: Postgres has no parameter slot for a
 * table or column name. So they are constrained to a shape that cannot carry an
 * injection rather than escaped and hoped over — the same rule, and the same
 * alphabet, `pg-role.ts` uses for role names.
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

/**
 * The rows of one page, newest first where that means anything.
 *
 * Ordering is chosen by `orderingFor` and stated by `describeOrdering`, so the
 * SQL and the sentence shown above it cannot disagree — which they would, given
 * two places to decide the same thing.
 */
export function pageQuery(table: TableShape, o: Ordering, limit: number, offset: number): string {
  if (!isSafeIdent(table.name)) throw new Error(`unsafe table name: ${table.name}`);
  const order = o.by === "physical" ? "" : ` ORDER BY "${assertIdent(o.column)}" DESC NULLS LAST`;
  return `SELECT * FROM "${table.name}"${order} LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)}`;
}

function assertIdent(name: string): string {
  if (!isSafeIdent(name)) throw new Error(`unsafe column name: ${name}`);
  return name;
}
