export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The TENANT instance, and its READ-ONLY pool: this browses an app's database,
// and on that connection Postgres itself refuses to write. See lib/db.ts.
import { forbiddenBody } from "@/lib/api-error";
import { getTenantReadPool, dbNameForSlug } from "@/lib/db";
import { allShapes, readStats, shapeOf } from "@/lib/db-catalog";
import { memo } from "@/lib/memo";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { withCors, optionsHandler } from "@/lib/cors";
import {
  orderingFor, describeOrdering, describeSort, pageQuery, countQuery,
  pageSize, pageOffset, parseSort, parseFilter, isSafeIdent,
  type Column, type Filter, type Sort, type TableShape,
} from "@/lib/db-browse";

/**
 * Reading an app's own database, for its owner.
 *
 * The question this answers is "did the data land" — see
 * docs/superpowers/specs/2026-08-20-database-view-design.md. What that costs here
 * is that every number is either exact or LABELLED, and that a fact the database
 * cannot supply is omitted rather than approximated.
 *
 * THREE ANSWERS, NOT ONE, AND WHY
 *
 * A round trip to Cloud SQL through the local proxy measures 196 ms, so the shape
 * of this route is decided by how many of them it takes. It used to take fifteen
 * to open the screen — a transaction, two catalog queries, then a count and a
 * max() per table in a `for` loop with an `await` in it — about four seconds
 * before the grid appeared, and the page read only started once all of that
 * finished.
 *
 *   GET /db              every table's shape          1 round trip
 *   GET /db?stats=1      every table's count + clock   1 round trip
 *   GET /db?table=X      one table's shape, then its page and total  2
 *
 * The client asks for all three AT ONCE, so the slowest of them is the wait
 * rather than the sum. Splitting the counts out is what lets the table list draw
 * before anything has been counted: the list is a switcher first and a summary
 * second, and you can click a table while its number is still arriving.
 *
 * No transaction anywhere. The statement timeout and the read-only guarantee are
 * startup parameters on the pool, which is both free and stronger.
 */

/** Postgres's code for "I gave up on this statement", which is not a failure to hide. */
const TIMEOUT = "57014";
const isTimeout = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === TIMEOUT;

/** How many rows one hand-written statement may hand back. */
const MAX_ROWS = 500;

/**
 * The extra column the page query carries its own total in.
 *
 * A name a real table could still have, which is why the caller checks before
 * using it rather than assuming. Being wrong here would mean silently dropping
 * somebody's column from the grid.
 */
const TOTAL = "__bay_total";

/**
 * The catalog read, shared between the three requests the client fires together.
 *
 * `memo` caches the PROMISE, so the shapes request and the stats request arriving
 * in the same instant become ONE query rather than two — which is the whole
 * reason the split into three endpoints does not cost more round trips than it
 * saves. The page read joins in too, so opening a table is one query.
 *
 * Five seconds, because the thing being cached is a SCHEMA. Somebody watching
 * rows arrive presses refresh for the counts, which are never cached; somebody
 * who has just run a migration waits a moment for the new table to be listed,
 * which is the right way round.
 */
const SHAPE_TTL_MS = 5_000;

function shapes(db: string): Promise<TableShape[]> {
  return memo(`db:shapes:${db}`, SHAPE_TTL_MS, () => allShapes(getTenantReadPool(db)));
}

interface TableSummary {
  name: string;
  columns: Column[];
  primaryKey: string[];
  orderedBy: string;
}

async function listTables(db: string) {
  const all = await shapes(db);
  return {
    database: db,
    tables: all.map((t): TableSummary => ({
      name: t.name,
      // The whole shape, not a count of columns. The client needs it anyway — to
      // know what a filter may name, and which cells can be edited — and sending
      // it here means opening a table does not have to ask again.
      columns: t.columns,
      primaryKey: t.primaryKey,
      orderedBy: describeOrdering(orderingFor(t)),
    })),
  };
}

/**
 * The counts, and when something last arrived.
 *
 * Separate from the shapes because it is the slow half and the list does not need
 * it to be useful. `rowsExact` is false only when the one statement gave up, and
 * then there is no number at all rather than an estimate of a filtered nothing —
 * `pg_stat_user_tables.n_live_tup` reads ZERO for a table autovacuum has not
 * reached, which is exactly the state a fresh app is in when its owner opens this
 * to ask whether the data landed.
 */
async function listStats(db: string) {
  const pool = getTenantReadPool(db);
  const all = await shapes(db);
  try {
    const stats = await readStats(pool, all);
    return { stats: stats.map((s) => ({ ...s, rowsExact: true })) };
  } catch (e) {
    if (!isTimeout(e)) throw e;
    return {
      stats: [],
      error: "counting the rows took too long — the tables are listed without their sizes",
    };
  }
}

interface ViewRequest {
  sort: string | null;
  dir: string | null;
  where: string | null;
  op: string | null;
  value: string | null;
}

async function readTable(db: string, name: string, limit: number, offset: number, want: ViewRequest) {
  const pool = getTenantReadPool(db);

  // From the shared catalog read when it is there, which makes opening a table a
  // single round trip. A MISS is asked again live rather than answered from the
  // cache, so a table created three seconds ago is not reported as missing —
  // "not in a five-second-old list" and "does not exist" are different facts, and
  // this screen exists to keep those apart.
  const t = (await shapes(db)).find((x) => x.name === name) ?? (await shapeOf(pool, name));
  if (!t) return { error: `no table named "${name}" in this database`, status: 404 as const };

  // Checked against THIS table's columns, so the two failures stay apart: a name
  // that could not be an identifier is refused, and a name that is simply not in
  // this table is dropped. See `Parsed` in lib/db-browse.
  const sort = parseSort(t, want.sort, want.dir);
  if (!sort.ok) return { error: sort.error, status: 400 as const };
  const filter = parseFilter(t, want.where, want.op, want.value);
  if (!filter.ok) return { error: filter.error, status: 400 as const };
  const view = { sort: sort.value, filter: filter.value };

  const page = pageQuery(t, orderingFor(t), limit, offset, view);
  const count = countQuery(t, view.filter);

  // Both in one round trip, by carrying the total as an extra column of every
  // row. Two conditions have to hold to merge them, and neither is assumed:
  //
  //  - The table must not already have a column called `__bay_total`. Being
  //    wrong here would silently drop somebody's column from the grid.
  //  - The two statements must bind the SAME values in the same order, so one
  //    array can serve both sets of placeholders. It is true — both get their
  //    parameters from the one filter, through the same function — and it is
  //    checked, because "it happens to be true today" is how a query comes to be
  //    sent with more parameters than it references.
  const mergeable =
    !t.columns.some((c) => c.name === TOTAL) &&
    count.values.length === page.values.length &&
    count.values.every((v, i) => v === page.values[i]);

  let rows: Record<string, unknown>[];
  let total: number | null = null;

  try {
    if (mergeable) {
      const r = await pool.query(
        `WITH p AS (${page.text}) SELECT (${count.text}) AS ${TOTAL}, p.* FROM p`,
        page.values,
      );
      rows = r.rows.map((row) => {
        const { [TOTAL]: _total, ...rest } = row as Record<string, unknown>;
        return rest;
      });
      total = r.rows.length > 0 ? Number((r.rows[0] as Record<string, unknown>)[TOTAL]) : null;
      // An empty page carries no total, so that one case asks.
      if (total === null) {
        total = Number((await pool.query<{ n: string }>(count.text, count.values)).rows[0].n);
      }
    } else {
      rows = (await pool.query(page.text, page.values)).rows;
      total = Number((await pool.query<{ n: string }>(count.text, count.values)).rows[0].n);
    }
  } catch (e) {
    // Null is an answer: "we could not count these". It used to be 0, so a count
    // that gave up was reported as `~0` above fifty visible rows.
    if (!isTimeout(e)) throw e;
    rows = [];
    total = null;
  }

  return {
    table: t.name,
    columns: t.columns,
    primaryKey: t.primaryKey,
    rows,
    total,
    totalExact: total !== null,
    limit,
    offset,
    // What was APPLIED, not what was asked for. The screen renders from these
    // rather than from its own URL, so a stale parameter cannot leave the grid
    // claiming an order or a filter that is not in the SQL above it.
    sort: view.sort as Sort | null,
    filter: view.filter as Filter | null,
    orderedBy: view.sort ? describeSort(view.sort) : describeOrdering(orderingFor(t)),
  };
}

async function getHandler(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json(forbiddenBody(), { status: 403 });

  const url = new URL(req.url);
  const table = url.searchParams.get("table");
  const db = dbNameForSlug(slug);
  try {
    if (url.searchParams.get("stats") === "1") return Response.json(await listStats(db));
    if (table) {
      if (!isSafeIdent(table)) return Response.json({ error: "invalid table name" }, { status: 400 });
      const out = await readTable(
        db, table,
        pageSize(url.searchParams.get("limit")),
        pageOffset(url.searchParams.get("offset")),
        {
          sort: url.searchParams.get("sort"),
          dir: url.searchParams.get("dir"),
          where: url.searchParams.get("where"),
          op: url.searchParams.get("op"),
          value: url.searchParams.get("value"),
        },
      );
      // 404 for a table that is not there, 400 for a parameter that could never
      // have been one. Both were 404, which told an owner their table was missing
      // when the truth was that their link was malformed.
      return "error" in out
        ? Response.json({ error: out.error }, { status: out.status })
        : Response.json(out);
    }
    return Response.json(await listTables(db));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * The escape hatch: one read-only statement, for the person who wants to ask
 * something the view does not.
 *
 * The rules stay HERE, on the server. One statement, SELECT only — and now also
 * a connection Postgres will not let write, which is a second enforcement under
 * the first rather than a replacement for it.
 */
async function postHandler(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json(forbiddenBody(), { status: 403 });
  const body = await req.json().catch(() => ({}));
  const q = String(body.sql ?? "").trim().replace(/;+\s*$/, "");
  const db = dbNameForSlug(slug);
  if (!/^select\b/i.test(q)) return Response.json({ error: "only SELECT queries are allowed" }, { status: 400 });
  if (q.includes(";")) return Response.json({ error: "one statement only" }, { status: 400 });
  try {
    const pool = getTenantReadPool(db);
    const r = await pool.query(q);
    // The grid aligns and sizes columns by TYPE, and a result set arrives
    // carrying type OIDs rather than names. One lookup turns them into `typname`
    // strings so one grid can draw a query's answer and a table alike.
    const oids = [...new Set(r.fields.map((f) => f.dataTypeID))];
    const names = new Map<number, string>();
    if (oids.length > 0) {
      const t = await pool.query<{ oid: number; typname: string }>(
        `SELECT oid::int AS oid, typname FROM pg_type WHERE oid::int = ANY($1::int[])`,
        [oids],
      );
      for (const row of t.rows) names.set(row.oid, row.typname);
    }
    return Response.json({
      columns: r.fields.map((f) => ({ name: f.name, type: names.get(f.dataTypeID) ?? "" })),
      rows: r.rows.slice(0, MAX_ROWS),
      truncated: r.rows.length > MAX_ROWS,
    });
  } catch (e) {
    if (isTimeout(e)) return Response.json({ error: "that query ran too long and was stopped" });
    return Response.json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// Reachable from the app's own X-ray drawer, which runs on the app's own origin.
// See lib/cors.ts: only THAT origin is allowed, never every subdomain. The write
// route beside this one is deliberately not CORS-exposed at all.
export const OPTIONS = optionsHandler;
export const GET = withCors(getHandler);
export const POST = withCors(postHandler);
