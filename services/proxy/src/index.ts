import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config";
import { lookupApp, hasGrant, workspaceOfUser, workspaceDomainOf } from "./registry";
import { page403, page404, page502, pageGate, pageBuilding } from "./pages";
import { readVisitor, authUrls } from "./session";
import { decideAccess } from "./access";
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

  // Either an open tunnel to the code being deployed, or the published build. With
  // neither, a "building…" page that goes live on its own.
  const buildLive = !!app.run_url;
  const tunnelUp = hasTunnel(slug);
  if (!buildLive && !tunnelUp) {
    if (app.status === "deploying") return html(res, 200, pageBuilding(slug));
    return html(res, 502, page502(slug));
  }

  // An open tunnel wins over the published build — after the app's own access rules,
  // which apply identically to both.
  //
  // A tunnel exists only while a deploy is running: the CLI opens it and drops it when
  // the build lands. So this is the deploy window and nothing else, and during it the
  // URL shows the code being deployed instead of the previous release — which is the
  // point of the live preview.
  //
  // It used to be the other way round, and that made the preview reachable exactly
  // once in an app's life. `run_url` is set on the first successful build and never
  // cleared (a redeploy only flips `status`), so from the second deploy onwards the
  // proxy always had a build to prefer and the tunnel, though connected, was never
  // asked. The preview silently stopped existing the moment an app went live.
  const serve = (visitorCtx: { userId: string; email: string; name: string }, wd: string, owner: boolean) =>
    tunnelUp
      ? Promise.resolve(forwardToTunnel(req, res, slug))
      : forward(req, res, app.run_url as string, visitorCtx, wd, { slug, owner });

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
