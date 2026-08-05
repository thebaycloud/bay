import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { buildUpstreamHeaders, scrubSetCookie, stripHopByHop, type VisitorIdentity } from "./headers";
import { mintIdToken } from "./idtoken";
import { isCloudRunTarget } from "./upstream";
import { config } from "./config";
import { injectOverlay, isHtmlDocument } from "./inject";
import { page502 } from "./pages";

export async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  targetBase: string,
  visitor: VisitorIdentity,
  workspaceDomain: string,
  inject?: { slug: string; owner: boolean },
  prefix?: string | null
): Promise<void> {
  const target = new URL(req.url ?? "/", targetBase);
  const headers = buildUpstreamHeaders(req.headers, visitor, config.sessionCookieName, inject?.slug, prefix);
  headers["x-supersonic-workspace"] = workspaceDomain;

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
    headers["x-supersonic-edge"] = config.edgeSecret;
  }

  const doRequest = target.protocol === "https:" ? httpsRequest : httpRequest;

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

        // HTML documents are buffered so we can inject the Supersonic overlay
        // before </body>. Everything else (assets, JSON, SSE) streams untouched.
        if (inject && isHtmlDocument(upRes.headers["content-type"])) {
          const chunks: Buffer[] = [];
          upRes.on("data", (c: Buffer) => chunks.push(c));
          upRes.on("end", () => {
            const body = injectOverlay(Buffer.concat(chunks).toString("utf8"), inject.slug, inject.owner);
            const buf = Buffer.from(body, "utf8");
            delete headers["content-encoding"];
            headers["content-length"] = String(buf.length);
            res.writeHead(upRes.statusCode ?? 502, headers);
            res.end(buf);
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
        upRes.on("end", done);
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
