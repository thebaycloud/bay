const http = require("http");
http.createServer((_, res) => { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify({ok:true,role:"web"})); })
  .listen(process.env.PORT || 8080, () => console.log("web up on", process.env.PORT));
