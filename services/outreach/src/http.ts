import type { IncomingMessage, ServerResponse } from "node:http";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Parsed JSON body; `{}` for requests without one. */
  body: any;
  /** Set by the auth middleware once the bearer token resolves to an account. */
  account?: Account;
}

export interface Account {
  id: string;
  label: string;
  email: string;
  timezone: string;
  daily_invite_cap: number;
  daily_message_cap: number;
  active_hour_start: number;
  active_hour_end: number;
}

export type Handler = (ctx: Ctx) => Promise<unknown>;

export interface Route {
  method: string;
  /** Path pattern; `:name` segments are captured onto ctx.url.searchParams. */
  path: string;
  handler: Handler;
  /** Routes are authenticated unless explicitly marked public. */
  public?: boolean;
}

/** Thrown by handlers to return a specific status instead of a 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // A runaway client should not be able to exhaust memory; a scrape batch of
    // a few thousand prospects is well under this.
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/**
 * Match `pattern` against `pathname`, returning captured `:param` values.
 * Returns null when the route does not match.
 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const a = pathname.split("/").filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) {
      params[p[i].slice(1)] = decodeURIComponent(a[i]);
    } else if (p[i] !== a[i]) {
      return null;
    }
  }
  return params;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
