const http = require("http");
const port = process.env.PORT || 8080;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>rally — live on Supersonic</title>
<style>
  body{font-family:ui-monospace,"SF Mono",Menlo,monospace;background:#0c0c0b;color:#eae8df;
       display:grid;place-items:center;height:100vh;margin:0;
       background-image:linear-gradient(#1b1a17 1px,transparent 1px),linear-gradient(90deg,#1b1a17 1px,transparent 1px);
       background-size:30px 30px}
  .b{border:1px solid #35342e;background:#111110;padding:40px 48px;position:relative}
  .b:before,.b:after{content:"";position:absolute;width:8px;height:8px}
  h1{font-weight:500;letter-spacing:-.03em;margin:0 0 10px}
  small{color:#9c9a8f}
</style>
<div class="b"><h1>⚡ rally is live on Supersonic</h1>
<small>deployed to Cloud Run via the real pipeline · ${new Date().toISOString()}</small></div>`);
}).listen(port, () => console.log("listening on " + port));
