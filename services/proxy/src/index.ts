import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config";
import { lookupApp, lookupAppByHost, hasGrant, hasDomainGrant, emailIsVerified, workspaceOfUser, workspaceDomainOf, registryStaleFor } from "./registry";
import { page403, page404, pageGate, pageProve, pageFailed, pageStalled, pageNoWeb } from "./pages";
import { pageRoom } from "./room-page";
import { serveRoomEvents } from "./room";
import { assembleReading, liveDeps } from "./reading";
import { wantsHtml } from "./negotiate";
import { viewerOnce, authUrls, hasCredential } from "./session";
import { decideAccess, domainOf } from "./access";
import { decideEdge } from "./edge";
import { doorFor, mustReturnToPlatform, platformUrl } from "./door";
import { pickRoute, pickPrefix } from "./routes";
import { badgeRequired } from "./plan";
import { forward } from "./forward";
import { serveBay } from "./bay";
import { analyticsDetail } from "./analytics";

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "Vary": "Accept, Cookie",
  });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.url === "/_healthz") {
    // 200 while serving from memory, and saying so. The edge IS serving — the
    // whole point of the last-known state in registry.ts is that a database
    // outage is not an outage out here — so a failing health check would be the
    // wrong report and would take this instance out for doing its job.
    //
    // But an edge running on memory must not look identical to one reading the
    // database. `staleFor` is null when it is healthy and a number of
    // milliseconds when it is not, which is the one fact monitoring needs and
    // the one a person asks first.
    const staleFor = registryStaleFor();
    res.writeHead(200, { "Content-Type": "application/json" })
       .end(JSON.stringify({ ok: true, staleFor }));
    return;
  }

  // Two ways a request can name an app, and only one of them is derivable. An
  // address we issued carries its slug in the name; a domain its owner attached
  // carries nothing and has to be looked up. See door.ts — nothing below this
  // point cares which of the two it was, except the return immediately after it.
  const door = doorFor(req.headers.host, config.rootDomains);
  if (door.kind === "nowhere") return html(res, 404, page404());
  const app = door.kind === "issued" ? await lookupApp(door.slug) : await lookupAppByHost(door.hostname);
  if (!app) return html(res, 404, page404());
  const slug = app.slug;

  // A non-public app cannot be opened on a domain the session cookie does not
  // reach, so it is sent back to the address where it can be. door.ts carries
  // the argument; this is the two lines that act on it.
  if (mustReturnToPlatform(door, app.visibility)) {
    res.writeHead(302, {
      // The canonical root — the only one the session cookie covers.
      Location: platformUrl(slug, config.rootDomains[0], req.url),
      "Cache-Control": "private, no-store",
    });
    res.end();
    return;
  }

  // The app's own analytics, on the app's own address. Answered here, before
  // anything else looks at this request, for two reasons that are both about
  // what the visitor experiences: the tracker has to be same-origin or content
  // blockers eat it, and it must not depend on the app being up — a page that
  // has already rendered goes on reporting while its API is failing.
  //
  // `site` is null for an app with no umami site and for an owner who turned
  // analytics off, and `serveBay` then declines to answer at all, so /_bay
  // reaches the app exactly like any other path it does not know about. See
  // bay.ts for why this is a proxy and not a script tag.
  const site = app.umami_website_id && app.analytics_enabled ? { websiteId: app.umami_website_id } : null;
  if (await serveBay(req, res, site)) return;

  // Who is asking, resolved on demand and only ever once. Three of the branches
  // below need it and no two of them are on the same path, so each asks for it
  // where it is needed; a /_xray request from someone who is not the owner used
  // to ask twice and pay for it twice. Lazy, not up front: an ordinary request
  // to a public app never read the session at all and must not start now.
  const viewer = viewerOnce(req);

  // The x-ray is owner-only, and answered here rather than forwarded, so a
  // visitor cannot learn that the path means anything: to anyone who is not the
  // owner this is an ordinary request and the app answers it however it likes —
  // including with its own /_xray, if it has one. That check is unchanged; only
  // WHEN it is made moved. The session is read for this URL and no other, so an
  // ordinary request to a public app acquires nothing it did not have.
  // Two addresses, one page. `/_dashboard` is what it is called now — the panel
  // stopped being an x-ray the moment it could do things rather than only show
  // them, and the owner reads this name in their address bar and their tab
  // title. `/_xray` stays because it is the address already injected into every
  // served page and typed into agents' scripts; a rename that 404s the old one
  // is a rename that breaks whatever was pointed at it.
  const url0 = req.url ?? "/";
  const wantsXray = url0 === "/_dashboard" || url0 === "/_xray";
  const xrayViewer = wantsXray ? await viewer() : null;

  /**
   * The whole analytics read, for the owner, on demand.
   *
   * Not in the reading, and that is the point. /_xray is polled every three
   * seconds and assembled inline on a request somebody is waiting on, so the
   * audience half carried there is deliberately six numbers and three lists.
   * This is twenty-odd umami queries — every dimension it will answer for, the
   * time series, and who is on the site this second — and it happens once, when
   * the Analytics screen is opened, for the window that screen asked for.
   *
   * Owner-only, and answered here rather than forwarded, exactly as the panel
   * page is: to anyone else this path is nothing and the app answers it however
   * it likes. A visitor must not be able to learn from a 403 that it means
   * something.
   */
  if (url0.split("?")[0] === "/_dashboard/analytics") {
    const who = await viewer();
    /**
     * Why this read was or was not answered.
     *
     * Chat's `analytics` tool fetches this from the control plane with the owner's
     * session forwarded, and it came back 404 — which is this branch declining and
     * the request falling through to the app. Four wrong theories were argued from
     * inference before anyone instrumented the overlay decision; this is the same
     * mistake avoided the same way. Owner-only path, so this is one line per read a
     * person or their agent actually asked for.
     */
    console.log(
      JSON.stringify({
        ev: "analytics-read",
        slug,
        // Present at all? Distinguishes "the cookie was not forwarded" from "it was
        // forwarded and could not be verified", which are different bugs.
        cookie: Boolean(req.headers.cookie),
        named: req.headers.cookie?.includes(config.sessionCookieName) ?? false,
        resolved: Boolean(who),
        owner: Boolean(who && who.userId === app.owner_id),
      }),
    );
    if (who && who.userId === app.owner_id) {
      const url = new URL(url0, "http://x");
      // Windows the panel offers, and nothing else: the range is a number that
      // reaches umami, so it is chosen from a list here rather than parsed.
      const RANGES: Record<string, { ms: number; unit: string }> = {
        "1d": { ms: 24 * 60 * 60 * 1000, unit: "hour" },
        "7d": { ms: 7 * 24 * 60 * 60 * 1000, unit: "day" },
        "30d": { ms: 30 * 24 * 60 * 60 * 1000, unit: "day" },
        "1y": { ms: 365 * 24 * 60 * 60 * 1000, unit: "month" },
      };
      const pick = RANGES[url.searchParams.get("range") ?? "1d"] ?? RANGES["1d"];
      const endAt = Date.now();
      const body = site?.websiteId
        ? await analyticsDetail(site.websiteId, endAt - pick.ms, endAt, pick.unit)
        : null;
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        // Same reason the injected page is private: this is one owner's reading
        // of their own app and no shared cache has any business holding it.
        "Cache-Control": "private, no-store",
        Vary: "Cookie",
      });
      // `null` is a real answer — umami off, or unreachable — and the panel says
      // different things about those. It is never flattened into zeroes.
      res.end(JSON.stringify({ detail: body, on: Boolean(site?.websiteId) }));
      return;
    }
  }

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
    // A browser is sent to the workbench, which is where the panel lives now.
    // `/_xray` and `/_dashboard` keep answering JSON exactly as they did — every
    // page already served carries the address, and agents' scripts have it typed
    // in, so the URL cannot 404 and the JSON cannot change shape. Only the HTML
    // moved, and a 302 says so rather than serving a second copy of the panel.
    if (wantsHtml(String(req.headers.accept ?? ""))) {
      res.writeHead(302, {
        Location: `https://app.${config.rootDomains[0]}/apps/${encodeURIComponent(slug)}`,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }
    const reading = await assembleReading(slug, liveDeps(async () => ({
      door: `${slug}.${config.rootDomains[0]}`,
      // False for an app that has never once answered for itself, which is a
      // state a reading can now actually be fetched in.
      open: Boolean(app.run_url),
    }), site?.websiteId));
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
      const roomViewer = await viewer();
      const owner = !!roomViewer && roomViewer.userId === app.owner_id;
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
  /**
   * The pill is suppressed inside a frame.
   *
   * The workbench renders this app in an iframe, and the pill is a fixed element in
   * the top-right corner that links OUT to the workbench. Inside the frame it draws
   * itself over the app's own header, pointing at the page it is already on — which
   * is what shipped, and it looked exactly as wrong as it sounds.
   *
   * `Sec-Fetch-Dest` is set by the browser and cannot be forged by page script, so a
   * framed document is distinguishable from a top-level one without asking the page
   * anything. Only the OWNER half is suppressed: the badge is a plan obligation and
   * still belongs on a framed page, since framing an app must not be a way to remove
   * it.
   */
  const framed = String(req.headers["sec-fetch-dest"] ?? "") === "iframe";
  const serve = (visitorCtx: { userId: string; email: string; name: string }, wd: string, owner: boolean) =>
    forward(req, res, target as string, visitorCtx, wd, { slug, owner: owner && !framed, badge, websiteId: site?.websiteId ?? null }, prefix);

  // Public apps skip the sign-in wall entirely — anyone with the link gets in.
  //
  // Skipping the WALL is not the same as refusing to know who is there, and this
  // used to pass `false` for ownership unconditionally. The effect was that
  // making an app public deleted the owner's own dashboard from it: they kept
  // full access, saw no toolbar, no badge and no panel, and nothing anywhere
  // said why. It is a quiet way to lose a feature, because the person it
  // happens to has just been changing settings and will blame the settings.
  //
  // The anonymous visitor still pays nothing. `hasCredential` is a header lookup
  // and a cookie parse; the decode only happens for somebody who is actually
  // signed in, so a stranger's request does exactly what it did before.
  if (app.visibility === "public") {
    const wd = (await workspaceDomainOf(app.workspace_id)) ?? "";
    const me = hasCredential(req) ? await viewer() : null;
    const isOwner = !!me && me.userId === app.owner_id;
    // Ownership is learned; identity is not. A signed-in STRANGER on a public
    // app stays anonymous in the x-ray exactly as before — see the note in
    // forward.ts on why the panel must not name people who never signed in here.
    // The owner is the one exception, and only ever to themselves.
    await serve(isOwner ? me : { userId: "", email: "", name: "" }, wd, isOwner);
    return;
  }

  const visitor = await viewer();
  if (!visitor) {
    // Soft gate instead of an abrupt login redirect: offer sign-in or sign-up,
    // both carrying a callback so they land back on this app afterward.
    const { loginUrl, signupUrl } = authUrls(req);
    return html(res, 401, pageGate(loginUrl, signupUrl));
  }

  // A domain rule is only asked about for a `shared` app, and only then is the
  // visitor's own verification read — an app with no rules pays for neither.
  const visitorDomain = app.visibility === "shared" ? domainOf(visitor.email) : "";
  const [visitorWorkspaceId, granted, domainRuleMatches, visitorEmailVerified] = await Promise.all([
    workspaceOfUser(visitor.userId),
    app.visibility === "shared" ? hasGrant(app.id, visitor.email) : Promise.resolve(false),
    visitorDomain ? hasDomainGrant(app.id, visitorDomain) : Promise.resolve(false),
    visitorDomain ? emailIsVerified(visitor.userId) : Promise.resolve(false),
  ]);

  if (!decideAccess({ app, visitor, visitorWorkspaceId, hasGrant: granted, domainRuleMatches, visitorEmailVerified })) {
    // One case is not a refusal so much as an unfinished proof: this app admits
    // everyone at their domain, and they are signed in with a password account,
    // which proves nothing about the address. Saying "request access" there
    // sends them to bother the owner for something they already have — so they
    // are told the one move that opens it.
    if (domainRuleMatches && !visitorEmailVerified) {
      return html(res, 403, pageProve(visitorDomain, authUrls(req).loginUrl));
    }
    return html(res, 403, page403(slug, `https://app.${config.rootDomains[0]}`));
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
