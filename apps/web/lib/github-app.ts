import { createSign } from "node:crypto";

/**
 * The GitHub App's credential, and the only place it is used.
 *
 * Two facts shape this module. The App's private key can sign a JWT that proves
 * we are the App and nothing more — it reads no code and names no repository.
 * What reads code is an INSTALLATION token, bought with that JWT, scoped to one
 * installation's chosen repositories, and dead in an hour.
 *
 * So there are two credentials with two lifetimes, and conflating them is the
 * mistake this module exists to make impossible: nothing outside it sees a JWT,
 * and `installationToken` is the only way to get the other one.
 *
 * It deliberately knows nothing about our database. Whether a workspace is
 * ALLOWED to mint for an installation is a different question with a different
 * answer, and it lives in lib/github-connections.ts. Keeping them apart is what
 * stops "we can mint this" from being mistaken for "this caller may".
 */

/** GitHub caps a JWT at ten minutes. Nine leaves room for a slow request. */
const JWT_LIFETIME_S = 9 * 60;
/**
 * Backdated because GitHub validates `iat` against ITS clock. A control-plane
 * instance thirty seconds fast issues a token from the future and is refused
 * with a message that says nothing about clocks.
 */
const JWT_BACKDATE_S = 60;
/**
 * An installation token lives an hour. Treating it as spent two minutes early
 * costs one extra mint a day and removes the case where a token passes the
 * check here and expires during the clone it was fetched for.
 */
const TOKEN_MARGIN_MS = 120_000;

const API = "https://api.github.com";

export interface MintDeps {
  fetch: typeof globalThis.fetch;
  now: () => number;
}

const live: MintDeps = { fetch: (...a) => globalThis.fetch(...a), now: () => Date.now() };

/**
 * Why GitHub said no, in the terms the person's next action depends on.
 *
 * `no-installation` and `bad-credentials` look identical in a log and could not
 * be more different in a support conversation: the first is repaired by the
 * person in about forty seconds, the second cannot be repaired by them at all.
 */
export type GithubRefusal = {
  kind: "no-installation" | "bad-credentials" | "unavailable";
  status: number;
  message: string;
};

export class GithubError extends Error {
  readonly refusal: GithubRefusal;
  constructor(refusal: GithubRefusal) {
    super(refusal.message);
    this.name = "GithubError";
    this.refusal = refusal;
  }
}

function appId(): string {
  return (process.env.GH_APP_ID ?? "").trim();
}

/**
 * The PEM, however it arrived.
 *
 * Cloud Run mounts the secret with real newlines. A hand-set env var, a CI
 * variable and a `.env` written by a script all tend to carry `\n` instead. Both
 * are the same key and neither is worth a 401 that reads as a broken App.
 */
function privateKey(): string {
  return (process.env.GH_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").trim();
}

export function githubAppConfigured(): boolean {
  return Boolean(appId() && privateKey());
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Proof that we are the App. Reads nothing on its own. */
export function appJwt(nowMs: number = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const head = b64({ alg: "RS256", typ: "JWT" });
  const body = b64({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: appId() });
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(privateKey()).toString("base64url")}`;
}

interface Cached { token: string; expiresAt: number }
const cache = new Map<number, Cached>();

/** Test seam: forget every minted token without touching GitHub. */
export function _resetTokenCache(): void {
  cache.clear();
}

/**
 * A token that can read the repositories this installation chose.
 *
 * Cached per installation until it is nearly spent. The cache is per instance
 * and that is the right size: it is an optimisation against GitHub's rate limit,
 * and a cold instance minting its own copy costs one request.
 */
export async function installationToken(installationId: number, deps: MintDeps = live): Promise<string> {
  if (!githubAppConfigured()) {
    throw new GithubError({
      kind: "bad-credentials",
      status: 0,
      message: "the platform has no GitHub App credentials configured",
    });
  }
  const hit = cache.get(installationId);
  if (hit && hit.expiresAt - deps.now() > TOKEN_MARGIN_MS) return hit.token;

  const res = await deps.fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appJwt(deps.now())}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "supersonic",
    },
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; expires_at?: string; message?: string };
  if (!res.ok || !body.token) throw new GithubError(refusalFor(res.status, body.message));

  const expiresAt = body.expires_at ? Date.parse(body.expires_at) : deps.now() + 3600_000;
  cache.set(installationId, { token: body.token, expiresAt });
  return body.token;
}

/**
 * Status → what the person can do about it.
 *
 * 404 is the interesting one and it is not an accident of GitHub's design: an
 * installation the App cannot see is indistinguishable from one that never
 * existed, so "gone" and "never yours" arrive as the same code. Both mean the
 * same next step, which is why one kind covers them.
 */
function refusalFor(status: number, message?: string): GithubRefusal {
  const msg = message || `GitHub answered ${status}`;
  if (status === 404) return { kind: "no-installation", status, message: msg };
  if (status === 401 || status === 403) return { kind: "bad-credentials", status, message: msg };
  return { kind: "unavailable", status, message: msg };
}
