export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The TENANT instance: this browses an APP's database, not the platform's.
import { getTenantPool, dbNameForSlug } from "@/lib/db";

import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
  const url = new URL(req.url);
  const table = url.searchParams.get("table");
  const db = dbNameForSlug(slug);
  try {
    const pool = getTenantPool(db);
    if (table) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) return Response.json({ error: "invalid table name" }, { status: 400 });
      const r = await pool.query(`SELECT * FROM "${table}" LIMIT 100`);
      return Response.json({ columns: r.fields.map((f) => f.name), rows: r.rows });
    }
    const r = await pool.query(
      `SELECT t.table_name AS name,
        (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS columns,
        COALESCE(s.n_live_tup, 0) AS rows
       FROM information_schema.tables t
       LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name
       WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_name`
    );
    return Response.json({ database: db, tables: r.rows });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) });
  }
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const q = String(body.sql ?? "").trim().replace(/;+\s*$/, "");
  const db = dbNameForSlug(slug);
  if (!/^select\b/i.test(q)) return Response.json({ error: "only SELECT queries are allowed" }, { status: 400 });
  if (q.includes(";")) return Response.json({ error: "one statement only" }, { status: 400 });
  try {
    const pool = getTenantPool(db);
    const r = await pool.query(q);
    return Response.json({ columns: r.fields.map((f) => f.name), rows: r.rows });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) });
  }
}
