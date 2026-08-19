export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The TENANT instance: this browses an APP's database, not the platform's.
import { getTenantPool, dbNameForSlug } from "@/lib/db";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { withCors, optionsHandler } from "@/lib/cors";
import {
  recencyColumn, orderingFor, describeOrdering, pageQuery, pageSize, pageOffset,
  isSafeIdent, type TableShape, type Column,
} from "@/lib/db-browse";
import type { PoolClient } from "pg";

/**
 * Reading an app's own database, for its owner.
 *
 * The question this answers is "did the data land" — see
 * docs/superpowers/specs/2026-08-20-database-view-design.md. What that costs
 * here is that every number is either exact or LABELLED, and that a fact the
 * database cannot supply is omitted rather than approximated.
 */

/**
 * How long any one tenant query may run.
 *
 * The tenant pool holds three connections. Three slow queries — a COUNT over a
 * large table, a page deep into an OFFSET — and every owner looking at any app
 * on this instance waits. Set with SET LOCAL inside a transaction so it cannot
 * leak to the next borrower of the same pooled connection.
 */
const STATEMENT_TIMEOUT_MS = 4000;

/** Runs `fn` with a bounded statement timeout, and always releases the client. */
async function bounded<T>(db: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getTenantPool(db).connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Postgres's code for "I gave up on this statement", which is not a failure to hide. */
const TIMEOUT = "57014";
const isTimeout = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === TIMEOUT;

/** Every table in `public`, with its columns and primary key, in one round trip. */
async function shapes(c: PoolClient): Promise<TableShape[]> {
  const cols = await c.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
  );
  const keys = await c.query<{ table_name: string; column_name: string }>(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
  );
  const byTable = new Map<string, TableShape>();
  for (const r of cols.rows) {
    const t = byTable.get(r.table_name) ?? { name: r.table_name, columns: [], primaryKey: [] };
    t.columns.push({ name: r.column_name, type: r.data_type });
    byTable.set(r.table_name, t);
  }
  for (const r of keys.rows) byTable.get(r.table_name)?.primaryKey.push(r.column_name);
  return [...byTable.values()];
}

interface TableSummary {
  name: string;
  columns: number;
  rows: number;
  /** False when `rows` is the stats collector's estimate rather than a count. */
  rowsExact: boolean;
  /** ISO time of the newest row, or null when this table records no arrival time. */
  lastWriteAt: string | null;
  orderedBy: string;
}

/**
 * The count, exact where it can be.
 *
 * `pg_stat_user_tables.n_live_tup` — what this used to report as fact — is the
 * stats collector's estimate, and it is ZERO for a table autovacuum has not
 * reached. That is exactly the state a fresh app is in when its owner opens this
 * to ask whether the data landed, so the panel answered "0 rows" about a table
 * with rows in it.
 */
async function summarise(c: PoolClient, t: TableShape, estimates: Map<string, number>): Promise<TableSummary> {
  const ordering = orderingFor(t);
  const clock = recencyColumn(t);

  let rows = estimates.get(t.name) ?? 0;
  let rowsExact = false;
  try {
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${t.name}"`);
    rows = Number(r.rows[0].n);
    rowsExact = true;
  } catch (e) {
    if (!isTimeout(e)) throw e;
    // Kept as the estimate, and said so — a number nobody can vouch for is what
    // made this wrong the first time.
  }

  let lastWriteAt: string | null = null;
  if (clock) {
    try {
      const r = await c.query<{ t: Date | null }>(`SELECT max("${clock}") AS t FROM "${t.name}"`);
      lastWriteAt = r.rows[0]?.t ? new Date(r.rows[0].t).toISOString() : null;
    } catch (e) {
      if (!isTimeout(e)) throw e;
    }
  }

  return { name: t.name, columns: t.columns.length, rows, rowsExact, lastWriteAt, orderedBy: describeOrdering(ordering) };
}

async function listTables(db: string) {
  return bounded(db, async (c) => {
    const est = await c.query<{ relname: string; n: string }>(
      `SELECT relname, COALESCE(n_live_tup, 0)::text AS n FROM pg_stat_user_tables`,
    );
    const estimates = new Map(est.rows.map((r) => [r.relname, Number(r.n)]));
    const all = await shapes(c);
    const tables: TableSummary[] = [];
    for (const t of all) tables.push(await summarise(c, t, estimates));
    tables.sort((a, b) => a.name.localeCompare(b.name));
    return { database: db, tables };
  });
}

async function readTable(db: string, name: string, limit: number, offset: number) {
  return bounded(db, async (c) => {
    const all = await shapes(c);
    const t = all.find((x) => x.name === name);
    // Existence, not just shape. A name that passes the regex and does not exist
    // should say so rather than producing a Postgres syntax error the owner has
    // no way to read.
    if (!t) return { error: `no table named "${name}" in this database` as const };

    const ordering = orderingFor(t);
    const rows = await c.query(pageQuery(t, ordering, limit, offset));

    let total = 0;
    let totalExact = false;
    try {
      const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${t.name}"`);
      total = Number(r.rows[0].n);
      totalExact = true;
    } catch (e) {
      if (!isTimeout(e)) throw e;
    }

    return {
      table: t.name,
      columns: t.columns as Column[],
      rows: rows.rows,
      total, totalExact,
      limit, offset,
      orderedBy: describeOrdering(ordering),
    };
  });
}

async function getHandler(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const table = url.searchParams.get("table");
  const db = dbNameForSlug(slug);
  try {
    if (table) {
      if (!isSafeIdent(table)) return Response.json({ error: "invalid table name" }, { status: 400 });
      const out = await readTable(db, table, pageSize(url.searchParams.get("limit")), pageOffset(url.searchParams.get("offset")));
      return "error" in out ? Response.json(out, { status: 404 }) : Response.json(out);
    }
    return Response.json(await listTables(db));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * The escape hatch, unchanged: one read-only statement, for the person who wants
 * to ask something the view above does not.
 */
async function postHandler(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const q = String(body.sql ?? "").trim().replace(/;+\s*$/, "");
  const db = dbNameForSlug(slug);
  if (!/^select\b/i.test(q)) return Response.json({ error: "only SELECT queries are allowed" }, { status: 400 });
  if (q.includes(";")) return Response.json({ error: "one statement only" }, { status: 400 });
  try {
    const r = await bounded(db, (c) => c.query(q));
    return Response.json({ columns: r.fields.map((f) => f.name), rows: r.rows });
  } catch (e) {
    if (isTimeout(e)) return Response.json({ error: `the query ran longer than ${STATEMENT_TIMEOUT_MS / 1000}s and was stopped` });
    return Response.json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// Reachable from the app's own X-ray drawer, which runs on the app's own
// origin. See lib/cors.ts: only THAT origin is allowed, never every subdomain.
export const OPTIONS = optionsHandler;
export const GET = withCors(getHandler);
export const POST = withCors(postHandler);
