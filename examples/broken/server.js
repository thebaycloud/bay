// Intentionally broken for Cloud Run: listens on a hardcoded port, ignores $PORT.
// The repair agent should fix this to use process.env.PORT.
const http = require("http");

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<h1>fixed by the agent — listening on $PORT now</h1>");
}).listen(5000, () => console.log("listening on 5000"));
