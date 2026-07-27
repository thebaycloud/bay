import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { buildUpstreamHeaders, scrubSetCookie, stripHopByHop, type VisitorIdentity } from "./headers";
import { idTokenFor } from "./idtoken";
import { config } from "./config";
import { injectOverlay, isHtmlDocument } from "./inject";

export async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  targetBase: string,
  visitor: VisitorIdentity,
  workspaceDomain: string,
  inject?: { slug: string; owner: boolean }
): Promise<void> {
  const target = new URL(req.url ?? "/", targetBase);
  const headers = buildUpstreamHeaders(req.headers, visitor, config.sessionCookieName, inject?.slug);
  headers["x-supersonic-workspace"] = workspaceDomain;

  // Cloud Run rejects unauthenticated calls; we are the only allowed invoker.
  if (!process.env.SKIP_ID_TOKEN) {
    headers.authorization = `Bearer ${await idTokenFor(new URL(targetBase).origin)}`;
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
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("upstream unavailable");
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
