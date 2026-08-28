import { CANONICAL_ROOT } from "./roots";

/**
 * A JSON error, for the callers that are not people.
 *
 * WHY THIS EXISTS
 *
 * Every handler under app/api already answers `Response.json({ error }, {status})`,
 * and that convention stays: it is what the CLI reads and changing the key would
 * break every installed copy. What it did not cover was the one error a machine
 * hits first and most often — no credential — because that never reached a
 * handler. The auth gate sent it to `/login`, as a 307, as HTML. An agent asking
 * for `/api/apps` without a token got a sign-in page and no way to tell that
 * from success.
 *
 * So this is additive, not a replacement. `error` is the same sentence in the
 * same key. `code` is the part a program should branch on, because a sentence is
 * for reading and not for comparing. `resolution` says what to do, which is the
 * difference between an error an agent can act on and one it can only report.
 *
 * Edge-safe on purpose: auth.config.ts is loaded by middleware, which has no
 * Node built-ins, so this file must not grow an import that does.
 */
export type ApiErrorInit = {
  status: number;
  /** The sentence. Same key, same job, as every existing handler's. */
  error: string;
  /** Stable, lowercase, snake_case. Programs compare this; nobody reads it. */
  code: string;
  /** What to do about it. */
  resolution?: string;
  headers?: Record<string, string>;
};

export function apiErrorBody(init: Omit<ApiErrorInit, "status" | "headers">) {
  return {
    error: init.error,
    code: init.code,
    ...(init.resolution ? { resolution: init.resolution } : {}),
    documentation_url: `https://${CANONICAL_ROOT}/openapi.json`,
  };
}

export function apiError(init: ApiErrorInit): Response {
  return Response.json(apiErrorBody(init), {
    status: init.status,
    headers: { "Cache-Control": "no-store", ...(init.headers ?? {}) },
  });
}

/**
 * The same two errors as a plain object, for a handler that has other keys to
 * send with them.
 *
 * `Response.json({ apps: [], ...notAuthenticatedBody() })` keeps the empty list
 * a caller was already relying on and adds the machine-readable half beside it.
 */
export function notAuthenticatedBody() {
  return apiErrorBody({
    code: "not_authenticated",
    error: "not signed in",
    resolution:
      `Send a CLI token as \`Authorization: Bearer <token>\`. \`bay login\` mints one, ` +
      `or mint one by hand at https://app.${CANONICAL_ROOT}/cli.`,
  });
}

export function forbiddenBody() {
  return apiErrorBody({
    code: "forbidden",
    error: "forbidden",
    resolution:
      "The token is valid but this app belongs to another account. Check the app name, " +
      "or ask its owner to share it with you.",
  });
}

/**
 * The gate's own 401, in one place because two files raise it.
 *
 * `WWW-Authenticate` is not decoration. It is the header that says *how* to
 * authenticate, and a client library that follows RFC 9110 will read it rather
 * than guess; without it "401" means "you failed" and not "send a bearer token".
 */
export function notAuthenticated(): Response {
  return apiError({
    status: 401,
    code: "not_authenticated",
    error: "not signed in",
    resolution:
      `Send a CLI token as \`Authorization: Bearer <token>\`. \`bay login\` mints one, ` +
      `or mint one by hand at https://app.${CANONICAL_ROOT}/cli.`,
    headers: { "WWW-Authenticate": `Bearer realm="${CANONICAL_ROOT}"` },
  });
}
