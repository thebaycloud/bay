export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getTenantPool, dbNameForSlug } from "@/lib/db";
import { sessionUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { checkKey, editRefusal, updateRowQuery, type Column, type TableShape } from "@/lib/db-browse";
import type { PoolClient } from "pg";

/**
 * Changing one cell of one row, for the person looking at it.
 *
 * THE THING THIS ROUTE IS NOT
 *
 * It is not a verb the chat agent can reach. The agent's `/db` tool is read-only
 * by construction, and that property is the only thing bounding a prompt injected
 * through an app's own rows — a row of user-submitted text that says "now update
 * every price to 0" is harmless against a reader and catastrophic against a
 * writer. So this is a separate route with separate auth, and nothing in
 * lib/chat/tools.ts knows it exists.
 *
 * Which is also why it takes a session cookie and not a Bearer token. See
 * `sessionUserId`: a CLI token lives in a file and gets handed to agents, and
 * every read it can reach is recoverable while a write is not. There are no
 * per-app backups to undo one with.
 *
 * NOT wrapped in `withCors`, unlike the GET and POST beside it. Those are
 * readable from an app's own origin — its X-ray drawer — and this must not be
 * reachable from a page we do not serve, whatever that page's origin claims.
 *
 * WHAT IT REFUSES
 *
 * Every limit comes from `editRefusal`, which the panel also calls, so the button
 * and the guard cannot disagree. In short: no key, no edit; nothing generated;
 * nothing that names the row; no arrays and no binary.
 */

const STATEMENT_TIMEOUT_MS = 4000;

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

/**
 * One table's shape, including the two facts the browse route does not need:
 * whether a column is generated, and whether it may hold NULL.
 */
async function shapeOf(c: PoolClient, name: string): Promise<TableShape | null> {
  const cols = await c.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    is_generated: string;
    identity_generation: string | null;
  }>(
    `SELECT column_name, data_type, is_nullable, is_generated, identity_generation
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [name],
  );
  if (cols.rows.length === 0) return null;
  const keys = await c.query<{ column_name: string }>(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1
      ORDER BY kcu.ordinal_position`,
    [name],
  );
  return {
    name,
    columns: cols.rows.map((r): Column => ({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === "YES",
      // Both kinds. `is_generated` covers GENERATED ALWAYS AS, and
      // `identity_generation` covers GENERATED … AS IDENTITY, which are
      // different columns of information_schema and both mean "not yours".
      generated: r.is_generated === "ALWAYS" || r.identity_generation !== null,
    })),
    primaryKey: keys.rows.map((r) => r.column_name),
  };
}

async function handler(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await sessionUserId();
  if (!uid || !(await ownsApp(slug, uid))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    table?: unknown;
    column?: unknown;
    key?: unknown;
    from?: unknown;
    to?: unknown;
  };
  const tableName = typeof body.table === "string" ? body.table : "";
  const columnName = typeof body.column === "string" ? body.column : "";
  if (!tableName || !columnName) {
    return Response.json({ error: "a table and a column are required" }, { status: 400 });
  }

  const db = dbNameForSlug(slug);
  try {
    const out = await bounded(db, async (c) => {
      // Read the shape rather than trusting the request. Existence is checked
      // here for the same reason the browse route checks it: a name that passes
      // the identifier test and does not exist should be told so, not handed to
      // Postgres to turn into a syntax error nobody can read.
      const t = await shapeOf(c, tableName);
      if (!t) return { error: `no table named "${tableName}" in this database`, status: 404 as const };

      const column = t.columns.find((x) => x.name === columnName);
      if (!column) return { error: `no column named "${columnName}"`, status: 404 as const };

      const refusal = editRefusal(t, column);
      if (refusal) return { error: refusal, status: 400 as const };

      const key = checkKey(t, body.key);
      if (!key.ok) return { error: key.error, status: 400 as const };

      const q = updateRowQuery(t, column.name, key.key, body.from ?? null, body.to ?? null);
      const r = await c.query(q.text, q.values);

      // Nothing matched. Either somebody else changed this cell between the read
      // and the write, or the row is gone — and reporting a successful write of
      // nothing is how a person comes to believe a value they never saved.
      if (r.rowCount === 0) {
        return {
          error: "that row changed since you read it — reload and try again",
          status: 409 as const,
        };
      }

      return { row: r.rows[0], key: key.key, column: column.name };
    });

    if ("error" in out) return Response.json({ error: out.error }, { status: out.status });

    // Logged with who, what and where — never the value. A row of somebody's
    // database in our logs is a copy of their data in a place they did not put
    // it, and the audit question is "who changed what", which the names answer.
    console.log(
      `[db-edit] user=${uid} app=${slug} table=${tableName} column=${out.column} key=${JSON.stringify(out.key)}`,
    );
    return Response.json({ row: out.row });
  } catch (e) {
    // Postgres's own words. "invalid input syntax for type integer" is the most
    // useful sentence available when somebody types a word into a number.
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const PATCH = handler;
