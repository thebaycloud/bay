import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config";
import { lookupApp } from "./registry";
import { page404, page502 } from "./pages";
import { readVisitor, signInRedirect } from "./session";

function slugFromHost(host: string | undefined): string | null {
  if (!host) return null;
  const name = host.split(":")[0].toLowerCase();
  if (!name.endsWith("." + config.rootDomain)) return null;
  const slug = name.slice(0, -(config.rootDomain.length + 1));
  return /^[a-z0-9-]+$/.test(slug) ? slug : null;
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.url === "/_healthz") { res.writeHead(200).end("ok"); return; }

  const slug = slugFromHost(req.headers.host);
  if (!slug) return html(res, 404, page404());

  const app = await lookupApp(slug);
  if (!app) return html(res, 404, page404());
  if (!app.run_url) return html(res, 502, page502(slug));

  const visitor = await readVisitor(req);
  if (!visitor) {
    res.writeHead(302, { Location: signInRedirect(req) });
    res.end();
    return;
  }

  // Access check and forwarding arrive in Tasks 8-9.
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`${visitor.email} -> ${app.run_url}`);
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("internal error");
  });
}).listen(config.port, () => console.log(`proxy listening on :${config.port}`));
