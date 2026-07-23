const http = require("http");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = process.env.PORT || 8080;

http.createServer(async (req, res) => {
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS visits (id serial primary key, at timestamptz default now())");
    await pool.query("INSERT INTO visits DEFAULT VALUES");
    const r = await pool.query("SELECT count(*)::int AS n FROM visits");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>pgapp — live on Supersonic</title>
<style>body{font-family:ui-monospace,Menlo,monospace;background:#0c0c0b;color:#eae8df;display:grid;place-items:center;height:100vh;margin:0}
.b{border:1px solid #35342e;background:#111110;padding:40px 48px}h1{font-weight:500;letter-spacing:-.03em}small{color:#9c9a8f}</style>
<div class="b"><h1>⚡ pgapp is live — Postgres connected</h1>
<small>auto-provisioned DB · visit #${r.rows[0].n}</small></div>`);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("DB error: " + e.message);
  }
}).listen(port, () => console.log("listening on " + port));
