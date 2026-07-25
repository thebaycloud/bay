import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { buildUpstreamHeaders, scrubSetCookie, type VisitorIdentity } from "./headers";
import { idTokenFor } from "./idtoken";
import { config } from "./config";

export async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  targetBase: string,
  visitor: VisitorIdentity,
  workspaceDomain: string
): Promise<void> {
  const target = new URL(req.url ?? "/", targetBase);
  const headers = buildUpstreamHeaders(req.headers, visitor, config.sessionCookieName);
  headers["x-supersonic-workspace"] = workspaceDomain;

  // Cloud Run rejects unauthenticated calls; we are the only allowed invoker.
  if (!process.env.SKIP_ID_TOKEN) {
    headers.authorization = `Bearer ${await idTokenFor(new URL(targetBase).origin)}`;
  }

  const doRequest = target.protocol === "https:" ? httpsRequest : httpRequest;

  await new Promise<void>((resolve) => {
    const upstream = doRequest(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
        path: target.pathname + target.search, method: req.method, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, scrubSetCookie({ ...upRes.headers }));
        upRes.pipe(res);
        upRes.on("end", resolve);
      }
    );
    upstream.on("error", (e) => {
      console.error("upstream error", e);
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("upstream unavailable");
      resolve();
    });
    req.pipe(upstream);
  });
}
