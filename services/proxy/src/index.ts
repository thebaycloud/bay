import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config";
import { lookupApp, hasGrant, workspaceOfUser, workspaceDomainOf } from "./registry";
import { page403, page404, pageGate, pageFailed, pageStalled, pageNoWeb } from "./pages";
import { pageRoom } from "./room-page";
import { serveRoomEvents } from "./room";
import { xrayPage } from "./xray-page";
import { assembleReading, liveDeps } from "./reading";
import { wantsHtml } from "./negotiate";
import { readVisitor, authUrls } from "./session";
import { decideAccess } from "./access";
import { decideEdge } from "./edge";
import { pickRoute, pickPrefix } from "./routes";
import { badgeRequired } from "./plan";
import { forward } from "./forward";

function slugFromHost(host: string | undefined): string | null {
  if (!host) return null;
  const name = host.split(":")[0].toLowerCase();
  if (!name.endsWith("." + config.rootDomain)) return null;
  const slug = name.slice(0, -(config.rootDomain.length + 1));
  return /^[a-z0-9-]+$/.test(slug) ? slug : null;
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "Vary": "Accept, Cookie",
  });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.url === "/_healthz") { res.writeHead(200).end("ok"); return; }

  const slug = slugFromHost(req.headers.host);
  if (!slug) return html(res, 404, page404());

  const app = await lookupApp(slug);
  if (!app) return html(res, 404, page404());

  // The x-ray is owner-only, and answered here rather than forwarded, so a
  // visitor cannot learn that the path means anything: to anyone who is not the
  // owner this is an ordinary request and the app answers it however it likes —
  // including with its own /_xray, if it has one. That check is unchanged; only
  // WHEN it is made moved. The session is read for this URL and no other, so an
  // ordinary request to a public app acquires nothing it did not have.
  const wantsXray = (req.url ?? "/") === "/_xray";
  const xrayViewer = wantsXray ? await readVisitor(req) : null;

  // What this URL should answer with, argued from the deploy's own record rather
  // than from apps.status alone — which cannot tell a build in progress from one
  // whose process died, since both read 'deploying' forever. See edge.ts.
  const action = decideEdge({
    xrayForOwner: !!xrayViewer && xrayViewer.userId === app.owner_id,
    buildLive: !!app.run_url,
    status: app.status,
    deploy: app.deploy,
    hasWeb: app.has_web,
    now: Date.now(),
  });
  if ("serve" in action && action.serve === "xray") {
    // One address, two readers. A browser asking for a page gets the panel —
    // which is the only x-ray an API-shaped app can have, since there is no
    // HTML of its own to inject into. Anything else gets the numbers.
    if (wantsHtml(String(req.headers.accept ?? ""))) {
      return html(res, 200, xrayPage(slug));
    }
    const reading = await assembleReading(slug, liveDeps(async () => ({
      door: `${slug}.supersonic.cv`,
      // False for an app that has never once answered for itself, which is a
      // state a reading can now actually be fetched in.
      open: Boolean(app.run_url),
    })));
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Vary": "Accept, Cookie",
    });
    res.end(JSON.stringify(reading));
    return;
  }

  if ("page" in action) {
    // 404, not 503. The app is healthy; this URL just does not exist for it.
    // A 5xx here says the platform is broken, which is what it said about a
    // working bot for two days. Checked before the room, because an app that
    // deployed fine as a worker was never being born — there is nothing to watch.
    if (action.page === "noweb") return html(res, 404, pageNoWeb(slug));

    // The room. An app that has never once come up gets it, whatever state the
    // deploy is in — building, failed, or stopped — because for that app all
    // three are the same event: it is still being born and the owner is watching.
    // `run_url` is the test: it is set on the first successful build and never
    // cleared, so it means "has this address ever answered for itself". Once it
    // has, the plain pages below take over and the room is never shown again.
    if (!app.run_url) {
      // Read even on a public app, where the request path skips the session
      // entirely: the room shows real build lines to the owner and withholds
      // them from everyone else, so it has to know which one this is.
      const visitor = await readVisitor(req);
      const owner = !!visitor && visitor.userId === app.owner_id;
      if ((req.url ?? "/").startsWith("/_room/events")) return serveRoomEvents(req, res, { slug, owner });
      // Same page, different status. A build in progress is a 200 as it always
      // was; a URL whose deploy failed or stopped must not answer OK — monitoring
      // reads that as healthy and an agent reads it as shipped. The visitor sees
      // the same room either way, which is the honest picture; the status line is
      // for the machines.
      return html(res, action.page === "building" ? 200 : 503, pageRoom(slug, { owner }));
    }

    // 503, not 200 and not 502. 502 ("deployed but not answering") describes a
    // working app having a bad moment, which is not what either of these is.
    if (action.page === "failed") return html(res, 503, pageFailed(slug, action.reason));
    return html(res, 503, pageStalled(slug));
  }

  // Which service gets this request. One-service apps have no routes and land on
  // run_url exactly as before; a two-service app is split by path prefix so the
  // frontend can call `/api/…` on its own origin with no CORS and nothing to bake
  // into its bundle at build time.
  const target = pickRoute(app.routes, req.url ?? "/", app.run_url);
  // And where that service thinks it lives. The path is forwarded unstripped, so
  // the sibling at /api has to build its links under /api and cannot know that
  // from the request alone.
  const prefix = pickPrefix(app.routes, req.url ?? "/");
  // Resolved once per request rather than per response: the plan travels on the
  // app row that has already been fetched and cached, so this costs nothing.
  const badge = badgeRequired(app.owner_plan, app.owner_status);
  const serve = (visitorCtx: { userId: string; email: string; name: string }, wd: string, owner: boolean) =>
    forward(req, res, target as string, visitorCtx, wd, { slug, owner, badge }, prefix);

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
server.listen(config.port, () => {
  console.log(`proxy listening on :${config.port}`);
  // Which side of the rollout this revision is on, said once. The silent
  // failure it catches is `FLEET_EDGE_SECRET=` bound with an empty value — a
  // plausible botched rotation — which leaves fleet requests unsigned while
  // everything still answers 200 as long as the node's own gate is also off.
  // The secret itself is never logged, not even a prefix or a length.
  console.log(
    config.edgeSecret
      ? "edge gate: signing fleet requests with x-supersonic-edge"
      : "edge gate: OFF (no FLEET_EDGE_SECRET) — fleet requests go unsigned"
  );
});
