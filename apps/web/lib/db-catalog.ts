import type { Pool } from "pg";
import { isSafeIdent, recencyColumn, type Column, type TableShape } from "./db-browse";

/**
 * The shape of an app's tables, in one round trip.
 *
 * WHY `pg_catalog` AND NOT `information_schema`
 *
 * Measured on the tenant instance, five tables, twenty-eight columns:
 *
 *     information_schema.columns joined to key_column_usage   1197 ms
 *     the same answer from pg_class / pg_attribute / pg_index   197 ms
 *
 * A bare round trip through the local Cloud SQL proxy is 196 ms, so the second
 * one is network and nothing else, and the first was spending a full second
 * inside Postgres. `information_schema` is a set of views that re-check
 * privileges per row and join through `pg_catalog` anyway; it is the portable
 * answer, not the fast one, and this only ever runs against Postgres.
 *
 * It was also TWO queries — columns, then primary keys — which is another round
 * trip. One `pg_index` subquery folds them together.
 *
 * `format_type` gives what a person would type: "integer", "timestamp with time
 * zone", "numeric(10,2)", "text[]". Close enough to `information_schema`'s
 * `data_type` that everything reading these strings kept working, and better in
 * one respect — an array reads as "text[]" rather than the bare word "ARRAY".
 */

const CATALOG = `
SELECT c.relname AS tbl,
       a.attname AS col,
       format_type(a.atttypid, a.atttypmod) AS typ,
       NOT a.attnotnull AS nullable,
       (a.attgenerated <> '' OR a.attidentity <> '') AS generated,
       -- The column's place in the primary key, or null. \`unnest … WITH
       -- ORDINALITY\` and not \`array_position(i.indkey::int2[], …)\`, which
       -- returned the WRONG COLUMNS: a composite key came back as its second
       -- member alone, and single-column keys came back empty. int2vector does
       -- not behave like an array under a cast.
       (SELECT k.ord
          FROM pg_index i, unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         WHERE i.indrelid = c.oid AND i.indisprimary AND k.attnum = a.attnum) AS pk_pos
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE n.nspname = 'public' AND c.relkind = 'r'`;

interface Row {
  tbl: string;
  col: string;
  typ: string;
  nullable: boolean;
  generated: boolean;
  pk_pos: number | null;
}

function assemble(rows: Row[]): TableShape[] {
  const byTable = new Map<string, TableShape>();
  const keys = new Map<string, string[]>();
  for (const r of rows) {
    const t = byTable.get(r.tbl) ?? { name: r.tbl, columns: [] as Column[], primaryKey: [] as string[] };
    t.columns.push({ name: r.col, type: r.typ, nullable: r.nullable, generated: r.generated });
    byTable.set(r.tbl, t);
    if (r.pk_pos !== null) {
      const k = keys.get(r.tbl) ?? [];
      // By its place in the key, not by the order rows arrived: a composite key
      // matched on the wrong column order matches nothing.
      k[r.pk_pos - 1] = r.col;
      keys.set(r.tbl, k);
    }
  }
  for (const [name, k] of keys) {
    const shape = byTable.get(name);
    if (shape) shape.primaryKey = k.filter((c) => c !== undefined);
  }
  return [...byTable.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every ordinary table in `public`. One query. */
export async function allShapes(pool: Pool): Promise<TableShape[]> {
  const r = await pool.query<Row>(`${CATALOG} ORDER BY c.relname, a.attnum`);
  return assemble(r.rows);
}

/** One table, or null when there is no such table. One query. */
export async function shapeOf(pool: Pool, name: string): Promise<TableShape | null> {
  const r = await pool.query<Row>(`${CATALOG} AND c.relname = $1 ORDER BY a.attnum`, [name]);
  return assemble(r.rows)[0] ?? null;
}

/**
 * Every table's row count and newest arrival, in ONE query.
 *
 * It was two queries per table run in a `for` loop with an `await` in it — for
 * five tables, ten sequential round trips, measured at 1990 ms. As one statement
 * it is 196 ms, which is a single round trip and therefore the floor.
 *
 * Table names are interpolated because a table name has no parameter slot; every
 * one of them came out of `pg_catalog` a moment ago, and `isSafeIdent` is checked
 * again here rather than trusted, because "it came from the catalog" is exactly
 * the kind of reasoning that stops being true when somebody calls this from
 * somewhere else.
 *
 * `to_json` around the clock, not the bare value: tenant pools return temporal
 * types as Postgres's own text, and "2026-08-24 10:42:26.343+00" is not ISO 8601
 * — see `tenantTypes` in lib/db.ts.
 */
export interface TableStats {
  name: string;
  rows: number;
  lastWriteAt: string | null;
}

export async function readStats(pool: Pool, shapes: TableShape[]): Promise<TableStats[]> {
  const usable = shapes.filter((t) => isSafeIdent(t.name));
  if (usable.length === 0) return [];
  const parts = usable.map((t) => {
    const clock = recencyColumn(t);
    const when = clock && isSafeIdent(clock)
      ? `to_json((SELECT max("${clock}") FROM "${t.name}"))`
      : "NULL::json";
    // The name is a literal in the SELECT list, so it is quoted as a string
    // rather than as an identifier. `isSafeIdent` has already ruled out a quote.
    return `SELECT '${t.name}' AS name, (SELECT count(*) FROM "${t.name}")::text AS n, ${when} AS w`;
  });
  const r = await pool.query<{ name: string; n: string; w: string | null }>(parts.join(" UNION ALL "));
  return r.rows.map((x) => ({
    name: x.name,
    rows: Number(x.n),
    lastWriteAt: x.w === null ? null : String(x.w),
  }));
}
