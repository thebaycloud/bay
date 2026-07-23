// Uses the `resend` SDK, so the detector flags RESEND_API_KEY as a needed secret.
const http = require("http");
const port = process.env.PORT || 8080;
const key = process.env.RESEND_API_KEY || "";

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>secretapp</title>
<style>body{font-family:ui-monospace,Menlo,monospace;background:#0c0c0b;color:#eae8df;display:grid;place-items:center;height:100vh;margin:0}
.b{border:1px solid #35342e;background:#111110;padding:40px 48px}h1{font-weight:500}small{color:#9c9a8f}</style>
<div class="b"><h1>⚡ secretapp live</h1>
<small>RESEND_API_KEY present: <b>${Boolean(key)}</b> · starts with: <b>${key.slice(0, 6) || "(none)"}</b></small></div>`);
}).listen(port, () => console.log("listening on " + port));
