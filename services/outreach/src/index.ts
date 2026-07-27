import { createServer } from "node:http";
import { authenticate } from "./auth";
import { HttpError, matchPath, readJsonBody, sendJson, type Ctx } from "./http";
import { routes } from "./routes";

const PORT = Number(process.env.PORT ?? 8081);

/**
 * The extension calls this service from a linkedin.com page context, so the
 * browser sends a preflight and requires an explicit origin allowance. The
 * chrome-extension:// origin is stable per install; ALLOWED_ORIGINS is a
 * comma-separated list set at deploy time.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function applyCors(origin: string | undefined, res: import("node:http").ServerResponse) {
  if (!origin) return;
  // No wildcard: this service holds an API key and per-account tokens, so only
  // origins we named at deploy time may talk to it.
  if (!ALLOWED_ORIGINS.includes(origin)) return;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-max-age", "86400");
  res.setHeader("vary", "origin");
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  applyCors(origin, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  try {
    const route = routes.find(
      (r) => r.method === req.method && matchPath(r.path, url.pathname) !== null,
    );
    if (!route) throw new HttpError(404, "not found");

    // Path params ride on searchParams so handlers have one place to read from.
    const params = matchPath(route.path, url.pathname)!;
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const ctx: Ctx = {
      req,
      res,
      url,
      body: req.method === "POST" ? await readJsonBody(req) : {},
    };
    if (!route.public) {
      ctx.account = await authenticate(req.headers.authorization);
    }

    sendJson(res, 200, await route.handler(ctx));
  } catch (e) {
    if (e instanceof HttpError) {
      sendJson(res, e.status, { error: e.message });
      return;
    }
    // Log the detail, return a generic message — handler errors can carry
    // query fragments and connection strings.
    console.error(`${req.method} ${url.pathname} failed`, e);
    sendJson(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`outreach service listening on :${PORT}`);
});
