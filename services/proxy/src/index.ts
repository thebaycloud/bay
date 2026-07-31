import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config";
import { lookupApp, hasGrant, workspaceOfUser, workspaceDomainOf } from "./registry";
import { page403, page404, pageGate, pageBuilding, pageFailed, pageStalled } from "./pages";
import { readVisitor, authUrls } from "./session";
import { decideAccess } from "./access";
import { decideEdge } from "./edge";
import { pickRoute } from "./routes";
import { forward } from "./forward";
import { attachTunnel, hasTunnel, forwardToTunnel } from "./tunnel";

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

  // What this URL should answer with, argued from the deploy's own record rather
  // than from apps.status alone — which cannot tell a build in progress from one
  // whose process died, since both read 'deploying' forever. See edge.ts.
  //
  // The tunnel/build ordering lives there too. A tunnel exists only while a deploy
  // is running: the CLI opens it and drops it when the build lands, so during that
  // window the URL shows the code being deployed rather than the previous release,
  // which is the point of the live preview. It used to be the other way round, and
  // that made the preview reachable exactly once in an app's life — `run_url` is
  // set on the first successful build and never cleared, so from the second deploy
  // onwards the proxy always had a build to prefer and the connected tunnel was
  // never asked. What edge.ts adds is the other end of that: once the deploy has
  // LANDED, the build wins again, so `--wait` holding its tunnel open does not
  // leave visitors pointed at a developer's laptop.
  const action = decideEdge({
    buildLive: !!app.run_url,
    tunnelUp: hasTunnel(slug),
    status: app.status,
    deploy: app.deploy,
    now: Date.now(),
  });
  if ("page" in action) {
    if (action.page === "building") return html(res, 200, pageBuilding(slug));
    // 503, not 200 and not 502. A URL with nothing behind it must not answer OK —
    // monitoring reads that as healthy and an agent reads it as shipped — and 502
    // ("deployed but not answering") describes a working app having a bad moment,
    // which is not what either of these is.
    if (action.page === "failed") return html(res, 503, pageFailed(slug, action.reason));
    return html(res, 503, pageStalled(slug));
  }

  // Which service gets this request. One-service apps have no routes and land on
  // run_url exactly as before; a two-service app is split by path prefix so the
  // frontend can call `/api/…` on its own origin with no CORS and nothing to bake
  // into its bundle at build time.
  const target = pickRoute(app.routes, req.url ?? "/", app.run_url);
  const serve = (visitorCtx: { userId: string; email: string; name: string }, wd: string, owner: boolean) =>
    action.serve === "tunnel"
      ? Promise.resolve(forwardToTunnel(req, res, slug))
      : forward(req, res, target as string, visitorCtx, wd, { slug, owner });

  // Public apps skip the sign-in wall entirely — anyone with the link gets in.
  if (app.visibility === "public") {
    const wd = (await workspaceDomainOf(app.workspace_id)) ?? "";
    await serve({ userId: "", email: "", name: "" }, wd, false);
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
  await serve(visitor, workspaceDomain, visitor.userId === app.owner_id);
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("internal error");
  });
});
attachTunnel(server);
server.listen(config.port, () => console.log(`proxy listening on :${config.port}`));
