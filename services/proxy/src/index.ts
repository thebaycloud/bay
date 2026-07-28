import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config";
import { lookupApp, hasGrant, workspaceOfUser, workspaceDomainOf } from "./registry";
import { page403, page404, page502, pageGate } from "./pages";
import { readVisitor, authUrls } from "./session";
import { decideAccess } from "./access";
import { forward } from "./forward";

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

  // Public apps skip the sign-in wall entirely — anyone with the link gets in.
  if (app.visibility === "public") {
    const wd = (await workspaceDomainOf(app.workspace_id)) ?? "";
    await forward(req, res, app.run_url, { userId: "", email: "", name: "" }, wd, { slug, owner: false });
    return;
  }

  const visitor = await readVisitor(req);
  if (!visitor) {
    // Soft gate instead of an abrupt login redirect: offer sign-in or sign-up,
    // both carrying a callback so they land back on this app afterward.
    const { loginUrl, signupUrl } = authUrls(req);
    return html(res, 401, pageGate(loginUrl, signupUrl));
  }

  const [visitorWorkspaceId, granted] = await Promise.all([
    workspaceOfUser(visitor.userId),
    app.visibility === "shared" ? hasGrant(app.id, visitor.email) : Promise.resolve(false),
  ]);

  if (!decideAccess({ app, visitor, visitorWorkspaceId, hasGrant: granted })) {
    return html(res, 403, page403(slug, "https://app.supersonic.cv"));
  }

  const workspaceDomain = (await workspaceDomainOf(app.workspace_id)) ?? "";
  await forward(req, res, app.run_url, visitor, workspaceDomain, { slug, owner: visitor.userId === app.owner_id });
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("internal error");
  });
}).listen(config.port, () => console.log(`proxy listening on :${config.port}`));
