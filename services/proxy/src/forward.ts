import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { buildUpstreamHeaders, scrubSetCookie, allowWorkbenchFraming, stripHopByHop, type VisitorIdentity } from "./headers";
import { mintIdToken } from "./idtoken";
import { isCloudRunTarget } from "./upstream";
import { config } from "./config";
import { injectOverlay, isHtmlDocument, needsBody } from "./inject";
import { page502 } from "./pages";
import { record } from "./xray";
import { publishRequest } from "./publish";

export async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  targetBase: string,
  visitor: VisitorIdentity,
  workspaceDomain: string,
  inject?: { slug: string; owner: boolean; badge: boolean; websiteId?: string | null },
  prefix?: string | null
): Promise<void> {
  const target = new URL(req.url ?? "/", targetBase);
  const headers = buildUpstreamHeaders(req.headers, visitor, config.sessionCookieName, inject?.slug, prefix);
  // Both spellings, for as long as a node provisioned before the rename may
  // be on the other end. See services/fleet/agent/router.go.
  headers["x-bay-workspace"] = workspaceDomain;
  headers["x-supersonic-workspace"] = workspaceDomain;

  /**
   * A page we are going to change cannot be answered with "unchanged".
   *
   * The overlay is added AFTER the app has produced its HTML, so the app's ETag
   * describes a body the browser never receives. Left alone the sequence is:
   * the browser caches the injected page, revalidates with If-None-Match, the
   * app — which knows nothing of any overlay — says 304, and a 304 carries no
   * content-type, so the injection branch below never runs and the 304 goes
   * straight through. The browser then keeps showing the body it already had,
   * for as long as the app's own HTML is unchanged. Which is forever, for a
   * landing page.
   *
   * That is why a deploy could appear to do nothing at all: the panel shipped,
   * the proxy served it, and the only page anyone looked at was one the browser
   * had decided it already knew.
   *
   * So if there is any chance we will inject, ask for the whole thing. The cost
   * is one uncached document on the one request that was going to be buffered
   * anyway; every asset beside it still revalidates normally.
   */
  const mayInject = Boolean(inject) && needsBody(!!inject?.owner, !!inject?.badge, inject?.websiteId);
  if (mayInject) {
    delete headers["if-none-match"];
    delete headers["if-modified-since"];
  }

  // Cloud Run rejects unauthenticated calls; we are the only allowed invoker.
  //
  // In X-Serverless-Authorization, NOT Authorization. There is one Authorization
  // header, and putting our invoker token in it means the visitor's own token
  // never reaches their app. That is not a corner case: FastAPI's
  // OAuth2PasswordBearer, and practically every SPA that holds a JWT, sends
  // credentials exactly there. The observed shape is an app that looks like it
  // logs you out at random — POST /login/access-token succeeds, because logging
  // in needs no token, and then every single authenticated request 403s and the
  // frontend bounces back to the sign-in page.
  //
  // Cloud Run reads this header first when it is present and leaves Authorization
  // untouched for the container, which is the entire reason it exists.
  const cloudRun = isCloudRunTarget(targetBase);

  //
  // No SKIP_ID_TOKEN any more. That was a production branch on this line that
  // existed for a test's benefit, and set in a real environment it would have
  // stripped this header from every Cloud Run upstream at once — every tenant's
  // app 403ing, with nothing here saying why. The test that needed to avoid the
  // metadata server now replaces the minter instead. See idtoken.ts.
  if (cloudRun) {
    headers["x-serverless-authorization"] = `Bearer ${await mintIdToken(new URL(targetBase).origin)}`;
  }

  // The fleet's node router trusts `x-supersonic-slug` to name the app. That
  // trust used to rest on the port being unreachable, and it is not: the fleet
  // load balancer answers the open internet, so without this header anyone could
  // name any slug and reach a placed app around everything above — the session
  // check, decideAccess, app_grants, workspace scoping.
  //
  // Never to a Cloud Run target: that upstream is a tenant's app.
  //
  // The value arrives already trimmed from config, which is the only place this
  // env var is read — see the note there for why a stray newline is a 502 for
  // every fleet app rather than a cosmetic problem.
  if (!cloudRun && config.edgeSecret) {
    headers["x-bay-edge"] = config.edgeSecret;
    headers["x-supersonic-edge"] = config.edgeSecret;
  }

  const doRequest = target.protocol === "https:" ? httpsRequest : httpRequest;

  // What the x-ray panel is made of. Measured here because this is the one place
  // that sees every request to every hosted app — the owner instruments nothing.
  //
  // The clock starts before the upstream call and stops when the response is
  // finished, so it is the number the visitor actually waited, not the app's own
  // idea of how fast it was.
  const startedAt = Date.now();
  let measured = false;
  const measure = (status: number) => {
    if (measured) return;
    measured = true;
    record(inject?.slug ?? "", {
      url: req.url ?? "/",
      status,
      ms: Date.now() - startedAt,
      // Identity only where the platform already knows it. On a public app the
      // visitor is anonymous here and stays anonymous in the panel; the fallback
      // key is per-connection so two anonymous people are two people.
      who: visitor.email ?? "",
      anonId: String(req.socket?.remotePort ?? Math.random()),
    });
    // The same measurement, kept rather than only counted. `record` above is the
    // in-memory aggregate that answers "what is happening"; this is the line that
    // answers "what happened", which nothing kept until now.
    publishRequest({
      slug: inject?.slug ?? "",
      method: req.method ?? "GET",
      url: req.url ?? "/",
      status,
      ms: Date.now() - startedAt,
    });
  };

  await new Promise<void>((resolve) => {
    // This proxy fronts every hosted app, so an unhandled stream 'error' would
    // not fail one request — it would take the process down for every tenant.
    // Every stream gets a handler, and the promise settles exactly once on any
    // outcome, including a client that walks away mid-stream.
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const upstream = doRequest(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
        path: target.pathname + target.search, method: req.method, headers },
      (upRes) => {
        const headers = stripHopByHop(scrubSetCookie({ ...upRes.headers }));

        // The workbench frames this app, so a document has to permit being framed
        // by app.supersonic.cv. Applied to every HTML document and not only to the
        // ones we inject into: a framed request carries Sec-Fetch-Dest: iframe and
        // is deliberately NOT injected, which is exactly the request that needs the
        // header most.
        if (isHtmlDocument(upRes.headers["content-type"])) allowWorkbenchFraming(headers);

        // Whether the overlay reached the page, said out loud — for documents,
        // and only documents.
        //
        // Several deploys were spent arguing about this from response sizes and
        // guesses, and every one of those arguments was wrong, so the decision
        // now states itself: an owner flag, a badge flag, a content type. But it
        // first said so for EVERY response, which on one page load of a Next.js
        // app is a dozen lines about stylesheets and woff2 files and one line
        // that matters. This proxy fronts every tenant, so a log line per
        // subresource is a bill and a haystack. Only the document can carry an
        // overlay; only the document is worth a line.
        if (inject && isHtmlDocument(upRes.headers["content-type"])) {
          console.log(
            JSON.stringify({
              ev: "overlay",
              slug: inject.slug,
              url: req.url ?? "/",
              status: upRes.statusCode ?? 0,
              owner: inject.owner,
              badge: inject.badge,
              site: Boolean(inject.websiteId),
              needsBody: needsBody(inject.owner, inject.badge, inject.websiteId),
              // Forwarded unchanged, and it governs the script we just added to
              // their page: script-src 'self' would permit the tracker, an
              // external same-origin file, while forbidding our inline overlay.
              // Worth one field, because that failure looks from outside exactly
              // like injection half-working.
              csp: upRes.headers["content-security-policy"] ?? null,
            }),
          );
        }

        // HTML documents are buffered so we can inject the Supersonic overlay
        // before </body>. Everything else (assets, JSON, SSE) streams untouched.
        if (inject && needsBody(inject.owner, inject.badge, inject.websiteId) && isHtmlDocument(upRes.headers["content-type"])) {
          const chunks: Buffer[] = [];
          upRes.on("data", (c: Buffer) => chunks.push(c));
          upRes.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const body = injectOverlay(raw, inject.slug, inject.owner, inject.badge, inject.websiteId);
            const buf = Buffer.from(body, "utf8");
            // How much of what the browser received is ours. The only number that
            // settles "did the overlay ship" without reading the page by hand.
            console.log(
              JSON.stringify({
                ev: "injected",
                slug: inject.slug,
                url: req.url ?? "/",
                app: raw.length,
                sent: buf.length,
                added: buf.length - raw.length,
                closedBody: raw.toLowerCase().includes("</body>"),
              }),
            );
            delete headers["content-encoding"];
            headers["content-length"] = String(buf.length);
            // The validators upstream sent describe the body BEFORE the overlay,
            // so keeping them would let the browser revalidate its way back to a
            // page we never served. They have to go with the body they describe.
            delete headers["etag"];
            delete headers["last-modified"];
            // And `private`, because what is in here depends on who asked: the
            // owner gets a toolbar and a panel that a visitor must never receive.
            // A shared cache holding one answer for both is the same bug with a
            // worse blast radius.
            headers["cache-control"] = "private, no-cache";
            res.writeHead(upRes.statusCode ?? 502, headers);
            res.end(buf);
            measure(upRes.statusCode ?? 502);
            done();
          });
          upRes.on("error", (e) => {
            console.error("upstream response error", e);
            res.destroy();
            done();
          });
          return;
        }

        res.writeHead(upRes.statusCode ?? 502, headers);
        upRes.pipe(res);
        upRes.on("end", () => { measure(upRes.statusCode ?? 502); done(); });
        upRes.on("error", (e) => {
          console.error("upstream response error", e);
          res.destroy();
          done();
        });
      }
    );

    upstream.on("error", (e) => {
      console.error("upstream error", e);
      // This is the one case page502 is actually for — an app that HAS a build
      // and is not answering — and until now it went out as the plain text
      // "upstream unavailable" while the page itself sat unused. A person who
      // opened a link deserves to be told which of their apps is down.
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page502(inject?.slug ?? ""));
      // An app that will not answer is the single most useful thing the panel can
      // show, so a failed forward is recorded exactly like a slow one.
      measure(502);
      done();
    });

    // The client hung up (closed a tab, dropped an SSE stream). Stop talking to
    // the app rather than leaving the connection and this promise dangling.
    res.on("close", () => {
      upstream.destroy();
      done();
    });
    req.on("error", (e) => {
      console.error("client request error", e);
      upstream.destroy();
      done();
    });

    req.pipe(upstream);
  });
}
