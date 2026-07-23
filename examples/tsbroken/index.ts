import * as http from "http";

// Deliberate type error: process.env.PORT is string | undefined, not number.
// `npm run gcp-build` (tsc) fails on this — the repair agent must fix it.
const port: number = process.env.PORT || 8080;

http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<h1>built &amp; running — fixed by the agent</h1>");
}).listen(port, () => console.log("listening on " + port));
