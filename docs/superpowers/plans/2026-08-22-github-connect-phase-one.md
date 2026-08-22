# GitHub Connect, Phase One — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person connects a GitHub account to their workspace, picks a private repository from a list, and deploys it — with no token ever pasted, stored, or logged.

**Architecture:** A GitHub App mints installation-scoped tokens that live one hour. `lib/github-app.ts` owns the credential and the mint (JWT → installation token, cached). `lib/github-connections.ts` owns the record — `installation → workspace` — and the ownership check every route makes before minting anything. The token reaches exactly one place: the argument to `git clone`. The existing deploy pipeline is unchanged past the clone.

**Tech Stack:** Next.js App Router (`apps/web`), TypeScript, Postgres via `lib/db`, `node:test` + `tsx` as the runner, `node:crypto` for RS256 (no JWT library — signing a fixed header is nine lines and a dependency here is one more thing to audit).

**Spec:** `docs/adr/0005-a-github-connection-is-an-installation-a-workspace-owns.md`

## Global Constraints

- **App identity is fixed and already provisioned.** App ID `4680812`, slug `the-bay-cloud`, owner `thebaycloud`. Do not create, rename, or re-key the App.
- **Env var names, exactly:** `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_WEBHOOK_SECRET`. Already mounted on `supersonic-control-plane`, `supersonic-deploy-worker` and job `supersonic-deploy-job`, and present in `apps/web/.env.local`.
- **Permissions granted are `contents:read` and `metadata:read` only.** Any code that needs more is out of scope — say so, do not widen the App.
- **No webhook in phase one.** Do not create `app/api/github/webhook/route.ts`. `GH_WEBHOOK_SECRET` is read by nothing yet.
- **The token is never persisted and never logged.** Not in `apps.repo_url`, not in a stage row, not in a deploy log line.
- **Migrations are idempotent and untracked** — `db/migrate.ts` reapplies every file on every run. Use `IF NOT EXISTS`. Next free number is `032`.
- **Vocabulary.** `CONTEXT.md` governs. Platform language in tables and code (`installation`, `workspace`); product language in anything a person reads — an **App**, they **ship** it, one attempt is a **Build**. Never write "deployment", "repo" or "OAuth" in front of a person.
- **Run the whole suite, never one file.** `npm test` from `apps/web`. `test/deploy-pipeline.test.ts` hangs when run alone and passes in the full run; a solo run of it proves nothing in either direction.
- **Two proxies for local work:** platform Postgres on 5433, tenants on 5434. `cloud-sql-proxy -g --port 5433 …:supersonic-platform-pg`.
- **gcloud expires constantly.** `gcloud auth login a@supersonic.cv` — with the account named, or the picker offers an account with no permission on `supersonic-deploy-prod`.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/github-app.ts` (create) | The credential. Reads env, signs a JWT, mints and caches installation tokens, classifies GitHub's refusals. Knows nothing about our database. |
| `lib/github-connections.ts` (create) | The record. Reads and writes `github_installations`; answers "does this workspace own this installation?". Knows nothing about HTTP. |
| `lib/github-repos.ts` (create) | Listing what an installation can see, and building the authenticated clone URL. The only module that puts a token in a string. |
| `db/032_github_installations.sql` (create) | `github_installations` + `apps.gh_installation_id`. |
| `app/api/github/setup/route.ts` (create) | Where GitHub sends the installer. Records the installation against the caller's workspace. |
| `app/api/github/repos/route.ts` (create) | The picker's data: installations this workspace owns and the repositories in each. |
| `app/new/page.tsx` (modify) | The `github` door becomes a picker instead of a text field. |
| `app/api/detect/route.ts` (modify) | Accepts an installation id and clones with a token. |
| `app/api/deploy/route.ts` (modify) | Same, and records `gh_installation_id` on the app. |
| `lib/source.ts` (modify) | `SourceOrigin` carries auth beside the URL, never spliced into it. |
| `lib/deploy-pipeline.ts` (modify) | Threads the installation id to `fetchSource`. |

Task order is dependency order. Tasks 1–3 are pure modules with no callers and can be reviewed on their own; 4 is schema; 5–6 are routes; 7–9 wire the clone; 10 is the screen.

---

### Task 1: The credential — JWT and installation tokens

**Files:**
- Create: `apps/web/lib/github-app.ts`
- Test: `apps/web/test/github-app.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `githubAppConfigured(): boolean`
  - `appJwt(now?: number): string`
  - `installationToken(installationId: number, deps?: MintDeps): Promise<string>`
  - `type GithubRefusal = { kind: "no-installation" | "bad-credentials" | "unavailable"; status: number; message: string }`
  - `class GithubError extends Error { readonly refusal: GithubRefusal }`
  - `interface MintDeps { fetch: typeof globalThis.fetch; now: () => number }`
  - `_resetTokenCache(): void`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/github-app.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, createVerify } from "node:crypto";
import {
  appJwt, installationToken, githubAppConfigured,
  GithubError, _resetTokenCache, type MintDeps,
} from "../lib/github-app";

/**
 * The credential.
 *
 * Two things are worth asserting and nothing else is. First, that the JWT we
 * sign is one GitHub's rules accept — RS256, our App ID as issuer, a lifetime
 * inside their ten-minute cap. Second, that a token is minted ONCE per hour and
 * that every way GitHub can say no is told apart, because the three refusals
 * have three different answers and a person acting on the wrong one loses an
 * afternoon.
 *
 * What is NOT tested here is that GitHub honours any of it. That is somebody
 * else's server, and the end-to-end check belongs in a script, not a unit test.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const CONFIGURED = { GH_APP_ID: "4680812", GH_APP_PRIVATE_KEY: PEM };

test("configured only when both the id and the key are present", () => {
  withEnv(CONFIGURED, () => assert.equal(githubAppConfigured(), true));
  withEnv({ ...CONFIGURED, GH_APP_PRIVATE_KEY: undefined }, () => assert.equal(githubAppConfigured(), false));
  withEnv({ ...CONFIGURED, GH_APP_ID: "" }, () => assert.equal(githubAppConfigured(), false));
});

test("the jwt is RS256, issued by the app, and expires inside GitHub's cap", () => {
  const jwt = withEnv(CONFIGURED, () => appJwt(1_000_000));
  const [h, p, s] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(payload.iss, "4680812");
  // Backdated: GitHub rejects a token whose iat is in ITS future, and the two
  // clocks are not the same clock.
  assert.ok(payload.iat <= 1000 - 30, `iat ${payload.iat} not backdated`);
  assert.ok(payload.exp - payload.iat <= 600, "lifetime over GitHub's 10-minute cap");
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, "base64url")), "signature does not verify");
});

test("a private key with escaped newlines is still a usable key", () => {
  // Cloud Run mounts real newlines; a hand-set env var often carries \n. Both
  // have to sign, or the failure is a 401 that looks like a bad App.
  const escaped = PEM.replace(/\n/g, "\\n");
  const jwt = withEnv({ ...CONFIGURED, GH_APP_PRIVATE_KEY: escaped }, () => appJwt(1_000_000));
  const [h, p, s] = jwt.split(".");
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, "base64url")));
});

function mint(status: number, body: unknown, calls: { n: number }): MintDeps {
  return {
    fetch: (async () => {
      calls.n++;
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch,
    now: () => 1_000_000,
  };
}

test("a minted token is reused until it is close to expiring", async () => {
  _resetTokenCache();
  const calls = { n: 0 };
  const deps = mint(201, { token: "ghs_abc", expires_at: new Date(1_000_000 + 3600_000).toISOString() }, calls);
  await withEnv(CONFIGURED, async () => {
    assert.equal(await installationToken(155650459, deps), "ghs_abc");
    assert.equal(await installationToken(155650459, deps), "ghs_abc");
    assert.equal(calls.n, 1, "minted twice for one installation inside the hour");
  });
});

test("a token inside the safety margin is minted again", async () => {
  _resetTokenCache();
  const calls = { n: 0 };
  // Expires in 60s. The margin is 120s, so it is already unusable.
  const deps = mint(201, { token: "ghs_stale", expires_at: new Date(1_000_000 + 60_000).toISOString() }, calls);
  await withEnv(CONFIGURED, async () => {
    await installationToken(155650459, deps);
    await installationToken(155650459, deps);
    assert.equal(calls.n, 2, "a nearly-expired token was reused");
  });
});

test("two installations do not share a cache entry", async () => {
  _resetTokenCache();
  const calls = { n: 0 };
  const deps = mint(201, { token: "ghs_x", expires_at: new Date(1_000_000 + 3600_000).toISOString() }, calls);
  await withEnv(CONFIGURED, async () => {
    await installationToken(1, deps);
    await installationToken(2, deps);
    assert.equal(calls.n, 2);
  });
});

test("404 means the installation is gone — the person reinstalls", async () => {
  _resetTokenCache();
  const deps = mint(404, { message: "Not Found" }, { n: 0 });
  await withEnv(CONFIGURED, async () => {
    const e = await installationToken(999, deps).then(() => null, (x) => x);
    assert.ok(e instanceof GithubError);
    assert.equal(e.refusal.kind, "no-installation");
  });
});

test("401 means our credentials are wrong — nothing the person does helps", async () => {
  _resetTokenCache();
  const deps = mint(401, { message: "Integration must generate a public key" }, { n: 0 });
  await withEnv(CONFIGURED, async () => {
    const e = await installationToken(1, deps).then(() => null, (x) => x);
    assert.ok(e instanceof GithubError);
    assert.equal(e.refusal.kind, "bad-credentials");
  });
});

test("a 500 is neither of those and must not read as one", async () => {
  _resetTokenCache();
  const deps = mint(500, { message: "Server Error" }, { n: 0 });
  await withEnv(CONFIGURED, async () => {
    const e = await installationToken(1, deps).then(() => null, (x) => x);
    assert.ok(e instanceof GithubError);
    assert.equal(e.refusal.kind, "unavailable");
  });
});

test("an unconfigured platform fails before it reaches the network", async () => {
  _resetTokenCache();
  const calls = { n: 0 };
  const deps = mint(201, {}, calls);
  await withEnv({ GH_APP_ID: undefined, GH_APP_PRIVATE_KEY: undefined }, async () => {
    const e = await installationToken(1, deps).then(() => null, (x) => x);
    assert.ok(e instanceof GithubError);
    assert.equal(e.refusal.kind, "bad-credentials");
    assert.equal(calls.n, 0, "asked GitHub without a credential to ask with");
  });
});
```

- [ ] **Step 2: Run the suite to verify it fails**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../lib/github-app'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/lib/github-app.ts
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
```

- [ ] **Step 4: Run the suite to verify it passes**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: PASS, and the total count is 1368 + 9.

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/web && npx tsc --noEmit
git add apps/web/lib/github-app.ts apps/web/test/github-app.test.ts
git commit -m "The App's credential mints installation tokens, and says which no it got"
git push
```

---

### Task 2: The record — installations a workspace owns

**Files:**
- Create: `apps/web/db/032_github_installations.sql`
- Create: `apps/web/lib/github-connections.ts`
- Test: `apps/web/test/github-connections.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `interface Connection { installationId: number; workspaceId: string; accountLogin: string; accountType: string; connectedBy: string | null }`
  - `recordInstallation(c: Omit<Connection, "connectedBy"> & { connectedBy: string | null }, q?: Query): Promise<void>`
  - `connectionsForWorkspace(workspaceId: string, q?: Query): Promise<Connection[]>`
  - `workspaceOwnsInstallation(workspaceId: string, installationId: number, q?: Query): Promise<boolean>`
  - `type Query = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>`

- [ ] **Step 1: Write the migration**

```sql
-- apps/web/db/032_github_installations.sql
--
-- A GitHub connection is an installation a workspace owns.
--
-- Keyed by GitHub's own installation id, because GitHub already guarantees it
-- unique and inventing a second key would mean keeping two in agreement for no
-- gain. Not a column on `workspaces`: a person with a personal account and two
-- orgs has three installations and one workspace, and a column would have made
-- them choose one.
--
-- `account_login` is denormalised on purpose. The import screen has to say
-- "thebaycloud" and asking GitHub who an installation belongs to, to render a
-- list of installations, is a network round trip to redraw a label.
--
-- `connected_by` is nullable and stays nullable. It records who pressed the
-- button, which is useful when a connection breaks and nobody remembers setting
-- it up — but a user row can be deleted and the connection is still the
-- workspace's. ON DELETE SET NULL rather than CASCADE for exactly that: losing
-- the person must not silently take the workspace's connection with them.
CREATE TABLE IF NOT EXISTS github_installations (
  installation_id bigint PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id),
  account_login   text NOT NULL,
  account_type    text NOT NULL DEFAULT 'Organization',
  connected_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS github_installations_workspace_idx
  ON github_installations (workspace_id);

-- Through which grant this app was deployed.
--
-- `apps.repo_url` (028) records WHERE, and stays the record of where. This
-- records through which installation that URL was reachable, which a redeploy
-- needs and cannot derive: the same URL is reachable through one installation
-- and not another, and guessing wrong is a clone that fails for a reason nobody
-- can see.
--
-- NULLABLE and staying that way. Every app deployed before today came from a
-- public URL or an upload and has no installation; a NOT NULL here would be a
-- lie about all of them.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS gh_installation_id bigint;
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/web/test/github-connections.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordInstallation, connectionsForWorkspace, workspaceOwnsInstallation, type Query,
} from "../lib/github-connections";

/**
 * The record, and the one question every route asks it.
 *
 * `workspaceOwnsInstallation` is the security boundary of this whole phase.
 * Without it, an installation id is a bearer token in a request body: anyone
 * who can guess or read one mints a token scoped to somebody else's private
 * code. It is asserted here against the wrong workspace, a missing row, and a
 * junk id, because those are the three ways a check like this is bypassed.
 */

const W = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

/** A fake pool that answers from a list of rows and records what it was asked. */
function db(rows: Record<string, unknown>[] = []) {
  const asked: Array<{ sql: string; params: unknown[] }> = [];
  const q: Query = async (sql, params) => {
    asked.push({ sql, params });
    return { rows };
  };
  return { q, asked };
}

test("recording an installation upserts, so re-installing is not a duplicate", async () => {
  const { q, asked } = db();
  await recordInstallation(
    { installationId: 155650459, workspaceId: W, accountLogin: "thebaycloud", accountType: "Organization", connectedBy: null },
    q,
  );
  assert.equal(asked.length, 1);
  assert.match(asked[0].sql, /ON CONFLICT \(installation_id\) DO UPDATE/);
  assert.deepEqual(asked[0].params, [155650459, W, "thebaycloud", "Organization", null]);
});

test("connections come back typed, with the id as a number", async () => {
  // Postgres returns bigint as a string through node-postgres. A caller that
  // compares it to a number gets false and no error.
  const { q } = db([{
    installation_id: "155650459", workspace_id: W,
    account_login: "thebaycloud", account_type: "Organization", connected_by: null,
  }]);
  const list = await connectionsForWorkspace(W, q);
  assert.equal(list.length, 1);
  assert.strictEqual(list[0].installationId, 155650459);
  assert.equal(list[0].accountLogin, "thebaycloud");
});

test("a workspace owns an installation only when the row says so", async () => {
  const hit = db([{ installation_id: "155650459" }]);
  assert.equal(await workspaceOwnsInstallation(W, 155650459, hit.q), true);
  assert.deepEqual(hit.asked[0].params, [W, 155650459]);

  const miss = db([]);
  assert.equal(await workspaceOwnsInstallation(OTHER, 155650459, miss.q), false);
});

test("a junk installation id is refused without touching the database", async () => {
  const { q, asked } = db([{ installation_id: "1" }]);
  assert.equal(await workspaceOwnsInstallation(W, Number.NaN, q), false);
  assert.equal(await workspaceOwnsInstallation(W, 0, q), false);
  assert.equal(await workspaceOwnsInstallation(W, -5, q), false);
  assert.equal(await workspaceOwnsInstallation(W, 1.5, q), false);
  assert.equal(asked.length, 0, "asked the database about an id that cannot exist");
});

test("no workspace means no ownership, and no query", async () => {
  const { q, asked } = db([{ installation_id: "1" }]);
  assert.equal(await workspaceOwnsInstallation("", 1, q), false);
  assert.equal(asked.length, 0);
});
```

- [ ] **Step 3: Run the suite to verify it fails**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../lib/github-connections'`.

- [ ] **Step 4: Write the implementation**

```ts
// apps/web/lib/github-connections.ts
import { getPool } from "./db";

/**
 * Which GitHub installations a workspace owns.
 *
 * The module is small and one function in it is load-bearing:
 * `workspaceOwnsInstallation` is the only thing standing between an
 * installation id in a request body and a token scoped to somebody's private
 * code. An installation id is not a secret — it is in a redirect URL, in
 * GitHub's own UI, and it is a small integer. So it must never be treated as
 * proof of anything, and every route that mints asks this first.
 */

export type Query = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const pool: Query = (sql, params) => getPool("supersonic_platform").query(sql, params);

export interface Connection {
  installationId: number;
  workspaceId: string;
  accountLogin: string;
  accountType: string;
  connectedBy: string | null;
}

/**
 * Whether a value could be an installation id at all.
 *
 * Cheap, and it runs before the query rather than after: an id that cannot
 * exist should not become a database round trip, and `NaN` reaching a bigint
 * parameter is an error from the driver rather than a false.
 */
function plausible(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

/**
 * Upsert, because installing the App again on the same account is the normal
 * way a person repairs a connection — and it arrives as the same installation
 * id. An INSERT here would fail on the primary key and the repair would read as
 * a bug.
 */
export async function recordInstallation(c: Connection, q: Query = pool): Promise<void> {
  await q(
    `INSERT INTO github_installations
       (installation_id, workspace_id, account_login, account_type, connected_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (installation_id) DO UPDATE SET
       workspace_id  = EXCLUDED.workspace_id,
       account_login = EXCLUDED.account_login,
       account_type  = EXCLUDED.account_type,
       connected_by  = COALESCE(EXCLUDED.connected_by, github_installations.connected_by),
       updated_at    = now()`,
    [c.installationId, c.workspaceId, c.accountLogin, c.accountType, c.connectedBy],
  );
}

export async function connectionsForWorkspace(workspaceId: string, q: Query = pool): Promise<Connection[]> {
  if (!workspaceId) return [];
  const { rows } = await q(
    `SELECT installation_id, workspace_id, account_login, account_type, connected_by
       FROM github_installations
      WHERE workspace_id = $1
      ORDER BY account_login`,
    [workspaceId],
  );
  return rows.map((r) => ({
    // bigint arrives as a string through node-postgres. Coerced here, once, so
    // no caller has to know that and none can forget.
    installationId: Number(r.installation_id),
    workspaceId: String(r.workspace_id),
    accountLogin: String(r.account_login),
    accountType: String(r.account_type),
    connectedBy: r.connected_by == null ? null : String(r.connected_by),
  }));
}

export async function workspaceOwnsInstallation(
  workspaceId: string,
  installationId: number,
  q: Query = pool,
): Promise<boolean> {
  if (!workspaceId || !plausible(installationId)) return false;
  const { rows } = await q(
    `SELECT installation_id FROM github_installations
      WHERE workspace_id = $1 AND installation_id = $2`,
    [workspaceId, installationId],
  );
  return rows.length > 0;
}
```

- [ ] **Step 5: Run the suite and apply the migration**

```bash
cd apps/web && npm test 2>&1 | tail -20
npx tsc --noEmit
# platform Postgres must be proxied on 5433 first
npm run db:migrate 2>&1 | tail -5
```

Expected: tests PASS; `migration 032_github_installations.sql applied`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/db/032_github_installations.sql apps/web/lib/github-connections.ts apps/web/test/github-connections.test.ts
git commit -m "An installation belongs to a workspace, and a route has to ask"
git push
```

---

### Task 3: Listing repositories, and the one string that holds a token

**Files:**
- Create: `apps/web/lib/github-repos.ts`
- Test: `apps/web/test/github-repos.test.ts`

**Interfaces:**
- Consumes: `installationToken`, `GithubError`, `type MintDeps` from Task 1.
- Produces:
  - `interface Repo { fullName: string; private: boolean; defaultBranch: string; pushedAt: string | null }`
  - `listRepos(installationId: number, deps?: ReposDeps): Promise<Repo[]>`
  - `authenticatedCloneUrl(repoUrl: string, token: string): string`
  - `cloneUrlFor(installationId: number, repoUrl: string, deps?: ReposDeps): Promise<string>`
  - `interface ReposDeps { fetch: typeof globalThis.fetch; token: (id: number) => Promise<string> }`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/github-repos.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { listRepos, authenticatedCloneUrl, cloneUrlFor, type ReposDeps } from "../lib/github-repos";

/**
 * What an installation can see, and the single place a token is spliced into a
 * string.
 *
 * `authenticatedCloneUrl` is nine characters of logic and it is tested harder
 * than anything else here, because it is the function whose output must never
 * be logged, stored, or returned to a browser. Everything about keeping the
 * token out of those places depends on it being obvious which value is the
 * dangerous one.
 */

function deps(pages: unknown[][], token = "ghs_tok"): ReposDeps & { calls: string[] } {
  const calls: string[] = [];
  let page = 0;
  return {
    calls,
    token: async () => token,
    fetch: (async (url: string) => {
      calls.push(String(url));
      const repos = pages[page++] ?? [];
      return new Response(JSON.stringify({ total_count: 0, repositories: repos }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch,
  };
}

test("repositories come back with the fields the picker renders", async () => {
  const d = deps([[{
    full_name: "thebaycloud/bay", private: true,
    default_branch: "main", pushed_at: "2026-08-22T10:00:00Z",
  }]]);
  const repos = await listRepos(155650459, d);
  assert.deepEqual(repos, [{
    fullName: "thebaycloud/bay", private: true,
    defaultBranch: "main", pushedAt: "2026-08-22T10:00:00Z",
  }]);
});

test("every page is fetched, not just the first", async () => {
  // An installation with 130 repositories returns 100 then 30. Stopping at the
  // first page is the bug that produces "I can't see my repository" for the
  // people who have the most of them.
  const d = deps([
    Array.from({ length: 100 }, (_, i) => ({ full_name: `o/r${i}`, private: true, default_branch: "main", pushed_at: null })),
    Array.from({ length: 30 }, (_, i) => ({ full_name: `o/s${i}`, private: true, default_branch: "main", pushed_at: null })),
  ]);
  const repos = await listRepos(1, d);
  assert.equal(repos.length, 130);
  assert.match(d.calls[0], /per_page=100&page=1/);
  assert.match(d.calls[1], /per_page=100&page=2/);
});

test("a short page ends the walk", async () => {
  const d = deps([[{ full_name: "o/r", private: false, default_branch: "main", pushed_at: null }]]);
  await listRepos(1, d);
  assert.equal(d.calls.length, 1, "asked for a page after a short one");
});

test("the token goes in as x-access-token and the path is untouched", () => {
  assert.equal(
    authenticatedCloneUrl("https://github.com/thebaycloud/bay.git", "ghs_abc"),
    "https://x-access-token:ghs_abc@github.com/thebaycloud/bay.git",
  );
});

test("a url that already carries credentials has them replaced, not appended", () => {
  // Otherwise a redeploy of an app stored with an old token produces
  // https://x-access-token:new@x-access-token:old@github.com/... which git
  // parses as a host that does not exist.
  assert.equal(
    authenticatedCloneUrl("https://x-access-token:old@github.com/o/r.git", "new"),
    "https://x-access-token:new@github.com/o/r.git",
  );
});

test("a non-https url is returned untouched rather than mangled", () => {
  // An ssh remote reaches this only through a bug, and a token in it would be
  // nonsense. Failing to clone is better than cloning something unexpected.
  assert.equal(authenticatedCloneUrl("git@github.com:o/r.git", "t"), "git@github.com:o/r.git");
});

test("cloneUrlFor mints and splices in one step", async () => {
  const d = deps([], "ghs_minted");
  assert.equal(
    await cloneUrlFor(155650459, "https://github.com/o/r.git", d),
    "https://x-access-token:ghs_minted@github.com/o/r.git",
  );
});
```

- [ ] **Step 2: Run the suite to verify it fails**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../lib/github-repos'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/lib/github-repos.ts
import { installationToken, GithubError } from "./github-app";

/**
 * What an installation can see, and the one function that puts a token in a
 * string.
 *
 * Those two things live together because the second is dangerous and small, and
 * burying it in a module nobody reads is how it ends up called from somewhere
 * that logs its return value. `authenticatedCloneUrl` returns a credential. Every
 * caller of it should be visible from one grep.
 */

const API = "https://api.github.com";
const PER_PAGE = 100;

export interface Repo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
}

export interface ReposDeps {
  fetch: typeof globalThis.fetch;
  token: (installationId: number) => Promise<string>;
}

const live: ReposDeps = {
  fetch: (...a) => globalThis.fetch(...a),
  token: (id) => installationToken(id),
};

/**
 * Every repository the installation was given, across every page.
 *
 * Paginated to exhaustion rather than capped. A cap would silently be the
 * answer to "why can't I see my repository" for exactly the accounts with the
 * most repositories, and a silent cap is indistinguishable from a complete
 * list at the call site.
 */
export async function listRepos(installationId: number, deps: ReposDeps = live): Promise<Repo[]> {
  const token = await deps.token(installationId);
  const out: Repo[] = [];
  for (let page = 1; ; page++) {
    const res = await deps.fetch(`${API}/installation/repositories?per_page=${PER_PAGE}&page=${page}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "supersonic",
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new GithubError({
        kind: res.status === 404 ? "no-installation" : res.status === 401 ? "bad-credentials" : "unavailable",
        status: res.status,
        message: body.message || `GitHub answered ${res.status} listing repositories`,
      });
    }
    const body = (await res.json()) as { repositories?: Array<Record<string, unknown>> };
    const batch = body.repositories ?? [];
    for (const r of batch) {
      out.push({
        fullName: String(r.full_name),
        private: Boolean(r.private),
        defaultBranch: String(r.default_branch ?? "main"),
        pushedAt: r.pushed_at == null ? null : String(r.pushed_at),
      });
    }
    if (batch.length < PER_PAGE) return out;
  }
}

/**
 * GitHub's documented form for cloning with an installation token.
 *
 * THE RETURN VALUE IS A CREDENTIAL. It goes to `git` and nowhere else — not to
 * a log line, not into `apps.repo_url`, not back to a browser.
 *
 * Any existing userinfo is replaced rather than kept, because a stored URL that
 * once carried a token would otherwise produce two sets of credentials and a
 * host git cannot resolve.
 */
export function authenticatedCloneUrl(repoUrl: string, token: string): string {
  const url = repoUrl.trim();
  if (!/^https?:\/\//i.test(url)) return url;
  return url.replace(/^(https?:\/\/)(?:[^@/]*@)?/i, `$1x-access-token:${token}@`);
}

/** Mint for this installation and hand back a URL `git clone` can use. */
export async function cloneUrlFor(installationId: number, repoUrl: string, deps: ReposDeps = live): Promise<string> {
  return authenticatedCloneUrl(repoUrl, await deps.token(installationId));
}
```

- [ ] **Step 4: Run the suite to verify it passes**

```bash
cd apps/web && npm test 2>&1 | tail -20
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/github-repos.ts apps/web/test/github-repos.test.ts
git commit -m "List what an installation can see, and splice the token in one place"
git push
```

---

### Task 4: The clone carries auth beside the URL, never inside it

**Files:**
- Modify: `apps/web/lib/source.ts` (the `SourceOrigin` type and the `clone` branch of `fetchSource`)
- Modify: `apps/web/test/source.test.ts` (add cases; change none)

**Interfaces:**
- Consumes: `authenticatedCloneUrl` from Task 3.
- Produces: `SourceOrigin` gains `{ kind: "clone"; url: string; token?: string }`. `url` stays the clean URL and is what every log line and every stage row shows.

- [ ] **Step 1: Write the failing test**

```ts
// append to apps/web/test/source.test.ts
import { authenticatedCloneUrl } from "../lib/github-repos";

test("a private clone authenticates git and tells the log nothing", async () => {
  const s = spy();
  await fetchSource(
    repo({}),
    { kind: "clone", url: "https://github.com/thebaycloud/bay.git", token: "ghs_secret" },
    s.deps,
  );
  const clone = s.ran.find((r) => r.cmd === "git");
  assert.ok(clone, "git was never run");
  assert.ok(
    clone.args.includes("https://x-access-token:ghs_secret@github.com/thebaycloud/bay.git"),
    `git was not given the authenticated url: ${clone.args.join(" ")}`,
  );
  // The whole point. Every line the logger saw is stored, replayed on
  // reconnect and shown to the person watching their app get built.
  for (const line of s.logs) {
    assert.ok(!line.includes("ghs_secret"), `the token reached a log line: ${line}`);
  }
  assert.ok(s.logs.some((l) => l.includes("https://github.com/thebaycloud/bay.git")),
    "the clean url should still be logged — it is how a person knows what is being pulled");
});

test("a clone without a token is byte-for-byte what it always was", async () => {
  const s = spy();
  await fetchSource(repo({}), { kind: "clone", url: "https://github.com/o/r.git" }, s.deps);
  const clone = s.ran.find((r) => r.cmd === "git");
  assert.deepEqual(clone?.args, ["clone", "--depth", "1", "https://github.com/o/r.git", ...clone!.args.slice(4)]);
});
```

Note: `spy()` in this file already collects `ran` and `logs`; if it does not expose them, widen its return to `{ deps, ran, logs, stages }` and leave every existing assertion untouched.

- [ ] **Step 2: Run the suite to verify it fails**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: FAIL — the token is not in the `git` args (the type does not carry it yet).

- [ ] **Step 3: Change the type and the branch**

```ts
// in apps/web/lib/source.ts — replace the `clone` member of SourceOrigin
  /**
   * A fresh shallow clone.
   *
   * `url` is always the CLEAN url — it is what gets logged, and a log line is
   * stored, replayed and read by a person. When the repository is private,
   * `token` carries the installation token beside it, and the two are joined
   * exactly once, at the call to `git`, by `authenticatedCloneUrl`.
   *
   * They are separate fields rather than one pre-authenticated string because
   * an authenticated string is a credential, and the moment it exists as `url`
   * every existing line that logs `origin.url` starts leaking it.
   */
  | { kind: "clone"; url: string; token?: string };
```

```ts
// in apps/web/lib/source.ts — replace the else branch of fetchSource
  } else {
    await stages.around("clone", async () => {
      log(`Pulling ${origin.url}`);
      const target = origin.token ? authenticatedCloneUrl(origin.url, origin.token) : origin.url;
      await run("git", ["clone", "--depth", "1", target, dir]);
    });
  }
```

```ts
// add to the imports at the top of apps/web/lib/source.ts
import { authenticatedCloneUrl } from "./github-repos";
```

- [ ] **Step 4: Run the suite to verify it passes**

```bash
cd apps/web && npm test 2>&1 | tail -20
npx tsc --noEmit
```

Expected: PASS, including every pre-existing case in `source.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/source.ts apps/web/test/source.test.ts
git commit -m "The clone url a person reads is not the one git is given"
git push
```

---

### Task 5: Where GitHub sends the installer

**Files:**
- Create: `apps/web/app/api/github/setup/route.ts`
- Test: `apps/web/test/github-setup.test.ts`

**Interfaces:**
- Consumes: `recordInstallation` (Task 2), `installationToken` + `GithubError` (Task 1), `currentUserId` from `lib/session`.
- Produces: `GET /api/github/setup?installation_id=<n>&setup_action=install` → 302 to `/new?connected=<login>` on success, 302 to `/new?github_error=<kind>` on refusal, 401 when not signed in.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/github-setup.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { installationFromCallback } from "../app/api/github/setup/route";

/**
 * The callback's decision, extracted from the route so it can be tested without
 * a request, a session or a database.
 *
 * The route itself is four lines of plumbing around this function. What is
 * worth asserting is that a redirect never carries a raw GitHub message into a
 * URL, and that a missing or junk installation_id is a refusal rather than a
 * row.
 */

test("a well-formed callback yields the installation to record", () => {
  const d = installationFromCallback(new URL("https://app.supersonic.cv/api/github/setup?installation_id=155650459&setup_action=install"));
  assert.deepEqual(d, { ok: true, installationId: 155650459 });
});

test("a missing installation_id is refused", () => {
  const d = installationFromCallback(new URL("https://app.supersonic.cv/api/github/setup"));
  assert.deepEqual(d, { ok: false, reason: "no-installation" });
});

test("a junk installation_id is refused rather than coerced", () => {
  for (const raw of ["abc", "-1", "0", "1.5", "1e9999", ""]) {
    const d = installationFromCallback(new URL(`https://x/api/github/setup?installation_id=${encodeURIComponent(raw)}`));
    assert.equal(d.ok, false, `accepted ${JSON.stringify(raw)}`);
  }
});

test("a request-scoped id is not read from anywhere but the query", () => {
  // setup_action varies (install, update) and must not change the outcome:
  // both mean "this installation is now this workspace's".
  const update = installationFromCallback(new URL("https://x/api/github/setup?installation_id=7&setup_action=update"));
  assert.deepEqual(update, { ok: true, installationId: 7 });
});
```

- [ ] **Step 2: Run the suite to verify it fails**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

```ts
// apps/web/app/api/github/setup/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getPool } from "@/lib/db";
import { currentUserId } from "@/lib/session";
import { installationToken, GithubError } from "@/lib/github-app";
import { recordInstallation } from "@/lib/github-connections";

/**
 * Where GitHub sends a person after they install the App.
 *
 * This is the ONLY moment the platform learns an installation id without being
 * told one by a caller it has to distrust, which is why the connection is
 * written here and nowhere else. The id arrives in a query string the person's
 * own browser followed, alongside their session cookie — so "who is
 * connecting" is the session, never the URL.
 *
 * It is not a security boundary on its own: anyone can hit this route with any
 * number. What makes that harmless is that the id is checked against GitHub
 * before it is stored — we mint a token for it, which only succeeds for an
 * installation of OUR App — and that the workspace recorded is the caller's
 * own. A person can therefore claim an installation they know the id of, and
 * what they get is a connection to an installation they must already have been
 * able to see. Phase two's webhook will confirm the account independently.
 */

export type CallbackDecision =
  | { ok: true; installationId: number }
  | { ok: false; reason: "no-installation" };

/**
 * The id, or a refusal. Separated from the request so the decision can be read
 * and tested on its own — `Number()` on a query parameter is exactly the kind
 * of coercion that turns "" into 0 and 0 into a database round trip.
 */
export function installationFromCallback(url: URL): CallbackDecision {
  const raw = (url.searchParams.get("installation_id") ?? "").trim();
  if (!/^\d+$/.test(raw)) return { ok: false, reason: "no-installation" };
  const installationId = Number(raw);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return { ok: false, reason: "no-installation" };
  return { ok: true, installationId };
}

function back(req: Request, params: Record<string, string>): Response {
  const to = new URL("/new", new URL(req.url).origin);
  for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
  return Response.redirect(to.toString(), 302);
}

export async function GET(req: Request): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "not signed in" }, { status: 401 });

  const decision = installationFromCallback(new URL(req.url));
  if (!decision.ok) return back(req, { github_error: decision.reason });

  const workspaceId = (await getPool("supersonic_platform").query(
    `SELECT workspace_id FROM users WHERE id = $1`, [userId],
  )).rows[0]?.workspace_id ?? null;
  if (!workspaceId) return back(req, { github_error: "no-workspace" });

  try {
    // Minting proves the installation is real, is ours, and is reachable —
    // before a row claims all three. The token itself is discarded; it will be
    // minted again, from cache, the moment anything needs it.
    await installationToken(decision.installationId);
    const account = await accountFor(decision.installationId);
    await recordInstallation({
      installationId: decision.installationId,
      workspaceId,
      accountLogin: account.login,
      accountType: account.type,
      connectedBy: userId,
    });
    return back(req, { connected: account.login });
  } catch (e) {
    // Never GitHub's message in a URL: it is attacker-influenced text landing
    // on a page we render. The KIND is ours and is all the screen needs.
    const kind = e instanceof GithubError ? e.refusal.kind : "unavailable";
    return back(req, { github_error: kind });
  }
}

/** Who the installation belongs to, for the label the picker shows. */
async function accountFor(installationId: number): Promise<{ login: string; type: string }> {
  const { appJwt } = await import("@/lib/github-app");
  const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: {
      Authorization: `Bearer ${appJwt()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "supersonic",
    },
  });
  if (!res.ok) throw new GithubError({ kind: "no-installation", status: res.status, message: "installation not found" });
  const body = (await res.json()) as { account?: { login?: string; type?: string } };
  return { login: String(body.account?.login ?? "your account"), type: String(body.account?.type ?? "Organization") };
}
```

- [ ] **Step 4: Run the suite to verify it passes**

```bash
cd apps/web && npm test 2>&1 | tail -20
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/github/setup/route.ts apps/web/test/github-setup.test.ts
git commit -m "The install callback records the connection, after GitHub confirms it"
git push
```

---

### Task 6: The picker's data

**Files:**
- Create: `apps/web/app/api/github/repos/route.ts`
- Test: `apps/web/test/github-repos-route.test.ts`

**Interfaces:**
- Consumes: `connectionsForWorkspace`, `workspaceOwnsInstallation` (Task 2), `listRepos` (Task 3), `GithubError` (Task 1).
- Produces: `GET /api/github/repos` → `{ connections: Array<{ installationId, accountLogin }>, configureUrl: string }`. `GET /api/github/repos?installation_id=<n>` → `{ repos: Repo[] }` or 403 when the workspace does not own it.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/github-repos-route.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reposResponse, INSTALL_URL, CONFIGURE_URL } from "../app/api/github/repos/route";

/**
 * The picker's data, and the refusal that matters.
 *
 * An installation id is not a secret — it sits in a redirect URL and in
 * GitHub's own UI. So the assertion worth making is that asking for one this
 * workspace does not own returns 403 and NOT the repositories, however
 * plausible the id.
 */

const W = "11111111-1111-1111-1111-111111111111";

test("without an installation id, the connections are listed", async () => {
  const r = await reposResponse({
    workspaceId: W,
    installationId: null,
    connections: async () => [
      { installationId: 155650459, workspaceId: W, accountLogin: "thebaycloud", accountType: "Organization", connectedBy: null },
    ],
    owns: async () => true,
    repos: async () => { throw new Error("must not list repositories without an id"); },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    connections: [{ installationId: 155650459, accountLogin: "thebaycloud" }],
    installUrl: INSTALL_URL,
    configureUrl: CONFIGURE_URL,
  });
});

test("an installation this workspace owns lists its repositories", async () => {
  const r = await reposResponse({
    workspaceId: W,
    installationId: 155650459,
    connections: async () => [],
    owns: async () => true,
    repos: async () => [{ fullName: "thebaycloud/bay", private: true, defaultBranch: "main", pushedAt: null }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { repos: [{ fullName: "thebaycloud/bay", private: true, defaultBranch: "main", pushedAt: null }] });
});

test("an installation this workspace does not own is refused, and nothing is listed", async () => {
  let listed = false;
  const r = await reposResponse({
    workspaceId: W,
    installationId: 999,
    connections: async () => [],
    owns: async () => false,
    repos: async () => { listed = true; return []; },
  });
  assert.equal(r.status, 403);
  assert.equal(listed, false, "listed repositories for an installation the workspace does not own");
});

test("a broken connection answers with the kind, not GitHub's prose", async () => {
  const { GithubError } = await import("../lib/github-app");
  const r = await reposResponse({
    workspaceId: W,
    installationId: 1,
    connections: async () => [],
    owns: async () => true,
    repos: async () => { throw new GithubError({ kind: "no-installation", status: 404, message: "Not Found" }); },
  });
  assert.equal(r.status, 409);
  assert.equal((r.body as { reason: string }).reason, "no-installation");
});
```

- [ ] **Step 2: Run the suite to verify it fails**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

```ts
// apps/web/app/api/github/repos/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getPool } from "@/lib/db";
import { currentUserId } from "@/lib/session";
import { GithubError } from "@/lib/github-app";
import { connectionsForWorkspace, workspaceOwnsInstallation, type Connection } from "@/lib/github-connections";
import { listRepos, type Repo } from "@/lib/github-repos";

/**
 * What the import screen draws: which accounts are connected, and what is in
 * one of them.
 *
 * Vercel ships a knowledge-base page for "I can't see my repository" and the
 * answer is always that the App was installed against a narrower selection than
 * the person thinks. So the configure link ships with the LIST, every time,
 * whether or not anything looks wrong — it is not an error state, it is the
 * second half of the answer to a question the list itself provokes.
 */

export const INSTALL_URL = "https://github.com/apps/the-bay-cloud/installations/new";
export const CONFIGURE_URL = "https://github.com/apps/the-bay-cloud/installations/select_target";

interface Deps {
  workspaceId: string;
  installationId: number | null;
  connections: (workspaceId: string) => Promise<Connection[]>;
  owns: (workspaceId: string, installationId: number) => Promise<boolean>;
  repos: (installationId: number) => Promise<Repo[]>;
}

/**
 * The decision, without a request around it.
 *
 * Split out because the only thing here worth testing is the 403, and reaching
 * it through a Request would mean standing up a session and a pool to assert
 * one branch.
 */
export async function reposResponse(d: Deps): Promise<{ status: number; body: unknown }> {
  if (d.installationId === null) {
    const list = await d.connections(d.workspaceId);
    return {
      status: 200,
      body: {
        connections: list.map((c) => ({ installationId: c.installationId, accountLogin: c.accountLogin })),
        installUrl: INSTALL_URL,
        configureUrl: CONFIGURE_URL,
      },
    };
  }
  // Before anything is minted. An installation id in a query string is a claim,
  // and the whole of this phase's security is that we check it against the
  // caller's workspace instead of believing it.
  if (!(await d.owns(d.workspaceId, d.installationId))) {
    return { status: 403, body: { error: "that account is not connected to your workspace" } };
  }
  try {
    return { status: 200, body: { repos: await d.repos(d.installationId) } };
  } catch (e) {
    if (e instanceof GithubError) {
      // 409, not 500: the platform is fine and the connection is not, and the
      // screen has something for the person to do about it.
      return { status: 409, body: { reason: e.refusal.kind, configureUrl: CONFIGURE_URL, installUrl: INSTALL_URL } };
    }
    throw e;
  }
}

export async function GET(req: Request): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "not signed in" }, { status: 401 });
  const workspaceId = (await getPool("supersonic_platform").query(
    `SELECT workspace_id FROM users WHERE id = $1`, [userId],
  )).rows[0]?.workspace_id ?? null;
  if (!workspaceId) return Response.json({ connections: [], installUrl: INSTALL_URL, configureUrl: CONFIGURE_URL });

  const raw = (new URL(req.url).searchParams.get("installation_id") ?? "").trim();
  const installationId = /^\d+$/.test(raw) ? Number(raw) : null;

  const { status, body } = await reposResponse({
    workspaceId,
    installationId,
    connections: connectionsForWorkspace,
    owns: workspaceOwnsInstallation,
    repos: listRepos,
  });
  return Response.json(body, { status });
}
```

- [ ] **Step 4: Run the suite to verify it passes**

```bash
cd apps/web && npm test 2>&1 | tail -20
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/github/repos/route.ts apps/web/test/github-repos-route.test.ts
git commit -m "The import screen's data, and the 403 that makes an id not a key"
git push
```

---

### Task 7: Detect clones a private repository

**Files:**
- Modify: `apps/web/app/api/detect/route.ts`
- Test: `apps/web/test/detect-installation.test.ts`

**Interfaces:**
- Consumes: `workspaceOwnsInstallation` (Task 2), `cloneUrlFor` (Task 3).
- Produces: `POST /api/detect` accepts `{ repo, installationId? }`. The response is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/detect-installation.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cloneTargetFor } from "../app/api/detect/route";

/**
 * Which URL /api/detect hands to git.
 *
 * Extracted from the route because the route itself spawns git and npm, and the
 * question worth asking has nothing to do with either: does an installation id
 * the caller does not own get a token anyway.
 */

const W = "11111111-1111-1111-1111-111111111111";

test("no installation means the url is used as it arrived", async () => {
  const target = await cloneTargetFor({
    url: "https://github.com/o/public.git", workspaceId: W, installationId: null,
    owns: async () => true, cloneUrl: async () => { throw new Error("must not mint"); },
  });
  assert.equal(target, "https://github.com/o/public.git");
});

test("an owned installation produces an authenticated url", async () => {
  const target = await cloneTargetFor({
    url: "https://github.com/thebaycloud/bay.git", workspaceId: W, installationId: 155650459,
    owns: async () => true,
    cloneUrl: async (id, url) => `https://x-access-token:tok-${id}@${url.replace(/^https:\/\//, "")}`,
  });
  assert.equal(target, "https://x-access-token:tok-155650459@github.com/thebaycloud/bay.git");
});

test("an installation the workspace does not own mints nothing and throws", async () => {
  let minted = false;
  await assert.rejects(
    () => cloneTargetFor({
      url: "https://github.com/someone/private.git", workspaceId: W, installationId: 999,
      owns: async () => false,
      cloneUrl: async () => { minted = true; return "x"; },
    }),
    /not connected/,
  );
  assert.equal(minted, false, "minted a token for an installation the workspace does not own");
});
```

- [ ] **Step 2: Run the suite to verify it fails**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: FAIL — `cloneTargetFor` is not exported.

- [ ] **Step 3: Modify the route**

Add the imports:

```ts
import { workspaceOwnsInstallation } from "@/lib/github-connections";
import { cloneUrlFor } from "@/lib/github-repos";
import { getPool } from "@/lib/db";
```

Add the exported decision, above `POST`:

```ts
/**
 * The URL git is actually given.
 *
 * The ownership check is here rather than at the top of the route on purpose:
 * this is the last point before a credential exists, and putting the check
 * anywhere earlier means a later caller can reach the mint without passing it.
 */
export async function cloneTargetFor(d: {
  url: string;
  workspaceId: string | null;
  installationId: number | null;
  owns: (workspaceId: string, installationId: number) => Promise<boolean>;
  cloneUrl: (installationId: number, url: string) => Promise<string>;
}): Promise<string> {
  if (d.installationId === null) return d.url;
  if (!d.workspaceId || !(await d.owns(d.workspaceId, d.installationId))) {
    throw new Error("that account is not connected to your workspace");
  }
  return d.cloneUrl(d.installationId, d.url);
}
```

Replace the body of `POST` between the sign-in check and `sweep()`:

```ts
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "not signed in" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const url = normalizeRepo(String(body.repo ?? ""));
  const rawInstall = String(body.installationId ?? "").trim();
  const installationId = /^\d+$/.test(rawInstall) ? Number(rawInstall) : null;
  const workspaceId = installationId === null ? null : (await getPool("supersonic_platform").query(
    `SELECT workspace_id FROM users WHERE id = $1`, [userId],
  )).rows[0]?.workspace_id ?? null;
  const slug = cloudRunName(url);
```

and change the clone line inside `try`:

```ts
    const target = await cloneTargetFor({
      url, workspaceId, installationId,
      owns: workspaceOwnsInstallation, cloneUrl: cloneUrlFor,
    });
    await run("git", ["clone", "--depth", "1", target, dir]);
```

Note the existing `if (!(await currentUserId()))` line is replaced by the `userId` binding above — the check is the same, the result is now kept.

- [ ] **Step 4: Run the suite to verify it passes**

```bash
cd apps/web && npm test 2>&1 | tail -20
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/detect/route.ts apps/web/test/detect-installation.test.ts
git commit -m "Detect can look inside a private repository the workspace connected"
git push
```

---

### Task 8: Deploy clones a private repository and records the grant

**Files:**
- Modify: `apps/web/app/api/deploy/route.ts`
- Modify: `apps/web/lib/deploy-pipeline.ts` (`DeployInput`, the `fetchSource` call, the `createAppRecord` call)
- Modify: `apps/web/lib/apps.ts` (`createAppRecord` gains `ghInstallationId`)
- Test: `apps/web/test/deploy-installation.test.ts`

**Interfaces:**
- Consumes: `cloneTargetFor`-shaped logic from Task 7 (reimplemented here against the pipeline's own inputs), `installationToken` (Task 1), `workspaceOwnsInstallation` (Task 2).
- Produces: `DeployInput` gains `ghInstallationId: number | null`. `apps.gh_installation_id` is written on create.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/deploy-installation.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cloneAuthFor } from "../lib/deploy-pipeline";

/**
 * Whether the pipeline attaches a credential, and what it refuses to do.
 *
 * The pipeline runs on the worker and in the job as well as in the request, so
 * the ownership check cannot live only in the route: a caller that reaches
 * `runDeploy` some other way must not be able to hand it any installation id
 * and get a token.
 */

const W = "11111111-1111-1111-1111-111111111111";

test("no installation means no token, and the clone is what it always was", async () => {
  const token = await cloneAuthFor({
    workspaceId: W, installationId: null,
    owns: async () => true, mint: async () => { throw new Error("must not mint"); },
  });
  assert.equal(token, undefined);
});

test("an owned installation yields a token", async () => {
  const token = await cloneAuthFor({
    workspaceId: W, installationId: 155650459,
    owns: async () => true, mint: async () => "ghs_minted",
  });
  assert.equal(token, "ghs_minted");
});

test("an installation the workspace does not own yields no token and no mint", async () => {
  let minted = false;
  await assert.rejects(
    () => cloneAuthFor({
      workspaceId: W, installationId: 999,
      owns: async () => false, mint: async () => { minted = true; return "x"; },
    }),
    /not connected/,
  );
  assert.equal(minted, false);
});

test("an installation with no workspace behind it is refused", async () => {
  await assert.rejects(
    () => cloneAuthFor({
      workspaceId: null, installationId: 1,
      owns: async () => true, mint: async () => "x",
    }),
    /not connected/,
  );
});
```

- [ ] **Step 2: Run the suite to verify it fails**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: FAIL — `cloneAuthFor` is not exported from `lib/deploy-pipeline`.

- [ ] **Step 3: Add the helper and thread the id**

In `apps/web/lib/deploy-pipeline.ts`, add near the other exported helpers:

```ts
import { installationToken } from "@/lib/github-app";
import { workspaceOwnsInstallation } from "@/lib/github-connections";

/**
 * The token this deploy clones with, if any.
 *
 * Checked here and not only in the route because `runDeploy` is reached three
 * ways — the request handler, the worker and the job — and a check that lives
 * in one of them is a check two callers do not make.
 */
export async function cloneAuthFor(d: {
  workspaceId: string | null;
  installationId: number | null;
  owns: (workspaceId: string, installationId: number) => Promise<boolean>;
  mint: (installationId: number) => Promise<string>;
}): Promise<string | undefined> {
  if (d.installationId === null) return undefined;
  if (!d.workspaceId || !(await d.owns(d.workspaceId, d.installationId))) {
    throw new Error("that account is not connected to your workspace");
  }
  return d.mint(d.installationId);
}
```

Add to `DeployInput`, after `isUpload`:

```ts
  /**
   * Which GitHub installation this repository is reachable through, or null for
   * a public URL or an upload. Not a credential — an id, checked against the
   * workspace before anything is minted from it.
   */
  ghInstallationId: number | null;
```

Destructure it in `runDeploy` alongside the others, then before the `fetchSource` call:

```ts
    const cloneToken = await cloneAuthFor({
      workspaceId: ownerWorkspace,
      installationId: input.ghInstallationId,
      owns: workspaceOwnsInstallation,
      mint: (id) => installationToken(id),
    });
```

Note: `cloneToken` already names the clone-cache handle in this function. Name this one `gitToken` instead, and use that below.

Change the `fetchSource` call:

```ts
    await fetchSource(
      dir,
      isUpload && archive ? { kind: "upload", archive }
        : reused ? { kind: "cached-clone" }
        : { kind: "clone", url, token: gitToken },
      { run: (cmd, args) => run(cmd, args, () => {}), log, stages },
    );
```

Change the `createAppRecord` call to carry the grant:

```ts
      await createAppRecord({
        slug, workspaceId: ownerWorkspace, ownerId,
        repoUrl: redeployableRepo({ url, isUpload }),
        ghInstallationId: input.ghInstallationId,
      });
```

In `apps/web/lib/apps.ts`, widen `createAppRecord`'s parameter with `ghInstallationId?: number | null` and add the column to its INSERT, defaulting to `null`.

In `apps/web/app/api/deploy/route.ts`, read the id from the body and pass it:

```ts
  const rawInstall = String(body.installationId ?? "").trim();
  const ghInstallationId = /^\d+$/.test(rawInstall) ? Number(rawInstall) : null;
```

and add `ghInstallationId` to the `runDeploy` input object beside `repoUrl: url`.

- [ ] **Step 4: Run the suite to verify it passes**

```bash
cd apps/web && npm test 2>&1 | tail -30
npx tsc --noEmit
```

Expected: PASS. `test/deploy-pipeline.test.ts` runs as part of the suite — do not run it alone.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/deploy-pipeline.ts apps/web/lib/apps.ts apps/web/app/api/deploy/route.ts apps/web/test/deploy-installation.test.ts
git commit -m "A deploy clones through the installation the workspace connected"
git push
```

---

### Task 9: The GitHub door becomes a picker

**Files:**
- Modify: `apps/web/app/new/page.tsx`

**Interfaces:**
- Consumes: `GET /api/github/repos` (Task 6), `POST /api/detect` and `POST /api/deploy` with `installationId` (Tasks 7–8).
- Produces: no exports; the `github` door renders connections and repositories instead of a text field.

- [ ] **Step 1: Add the state and the fetch**

```tsx
// near the other useState calls
interface GhConnection { installationId: number; accountLogin: string }
interface GhRepo { fullName: string; private: boolean; defaultBranch: string; pushedAt: string | null }

const [ghConnections, setGhConnections] = useState<GhConnection[] | null>(null);
const [ghInstallation, setGhInstallation] = useState<number | null>(null);
const [ghRepos, setGhRepos] = useState<GhRepo[] | null>(null);
const [ghLinks, setGhLinks] = useState<{ installUrl: string; configureUrl: string } | null>(null);
const [ghTrouble, setGhTrouble] = useState<string>("");

// Loaded when the door is opened rather than on mount: most people arrive to
// use a different door and this is a network round trip they never needed.
useEffect(() => {
  if (door !== "github" || ghConnections !== null) return;
  fetch("/api/github/repos")
    .then((r) => r.json())
    .then((d) => {
      setGhConnections(d.connections ?? []);
      setGhLinks({ installUrl: d.installUrl, configureUrl: d.configureUrl });
      if (d.connections?.length === 1) setGhInstallation(d.connections[0].installationId);
    })
    .catch(() => setGhConnections([]));
}, [door, ghConnections]);

useEffect(() => {
  if (ghInstallation === null) return;
  setGhRepos(null); setGhTrouble("");
  fetch(`/api/github/repos?installation_id=${ghInstallation}`)
    .then(async (r) => ({ ok: r.ok, d: await r.json() }))
    .then(({ ok, d }) => {
      if (ok) { setGhRepos(d.repos ?? []); return; }
      // Three refusals, three different next actions. Never GitHub's prose.
      setGhRepos([]);
      setGhTrouble(
        d.reason === "no-installation" ? "That account is no longer connected. Connect it again to pick a repository."
        : d.reason === "bad-credentials" ? "We can't reach GitHub right now. This one is on us — nothing you do will fix it."
        : "GitHub isn't answering. Try again in a moment.",
      );
    })
    .catch(() => setGhTrouble("GitHub isn't answering. Try again in a moment."));
}, [ghInstallation]);
```

- [ ] **Step 2: Read the callback's outcome on arrival**

```tsx
// alongside the existing effect that reads ?repo= from the query
useEffect(() => {
  const q = new URLSearchParams(window.location.search);
  if (q.get("connected")) { setDoor("github"); setGhConnections(null); }
  const err = q.get("github_error");
  if (err) {
    setDoor("github");
    setGhTrouble(
      err === "no-installation" ? "That install didn't complete. Try connecting again."
      : err === "no-workspace" ? "Your account isn't set up yet. Ship something once and this will work."
      : "We couldn't finish connecting to GitHub. Try again in a moment.",
    );
  }
}, []);
```

- [ ] **Step 3: Replace the github branch of the door body**

The current JSX renders one `<div className="repo">` for both `github` and `url`. Split it: keep it verbatim for `url`, and render this for `github`.

```tsx
{door === "github" ? (
  <>
    {ghConnections === null ? (
      <p className="lead" style={{ margin: "0 0 14px", fontSize: 13 }}>Looking for your GitHub accounts…</p>
    ) : ghConnections.length === 0 ? (
      <>
        <p className="lead" style={{ margin: "0 0 14px", fontSize: 13 }}>
          Connect GitHub once and your private repositories show up here. We only ever read code — nothing else, and only the repositories you pick.
        </p>
        <div className="deploy-cta">
          <a className="btn primary big" href={ghLinks?.installUrl ?? "#"}>
            <Github size={13} />Connect GitHub<ArrowRight size={13} />
          </a>
        </div>
      </>
    ) : (
      <>
        {ghConnections.length > 1 && (
          <div className="doors" style={{ marginBottom: 10 }}>
            {ghConnections.map((c) => (
              <button
                key={c.installationId}
                className={"door" + (ghInstallation === c.installationId ? " on" : "")}
                onClick={() => setGhInstallation(c.installationId)}
              >{c.accountLogin}</button>
            ))}
          </div>
        )}
        {ghTrouble && <p className="lead" style={{ margin: "0 0 10px", fontSize: 13 }}>{ghTrouble}</p>}
        {ghRepos === null ? (
          <p className="lead" style={{ margin: "0 0 14px", fontSize: 13 }}>Reading what you picked…</p>
        ) : (
          <div className="gh-repos">
            {ghRepos.map((r) => (
              <button key={r.fullName} className="gh-repo" onClick={() => { setRepo(r.fullName); beginGithub(r.fullName); }}>
                <span className="name">{r.fullName}</span>
                {r.private && <span className="tag">private</span>}
              </button>
            ))}
          </div>
        )}
        <p className="lead" style={{ margin: "10px 0 0", fontSize: 12, opacity: 0.7 }}>
          Not seeing one? <a href={ghLinks?.configureUrl ?? "#"}>Choose which repositories we can see</a>.
        </p>
      </>
    )}
  </>
) : (
  /* the existing url door, unchanged */
)}
```

- [ ] **Step 4: Send the installation id through both calls**

```tsx
async function beginGithub(fullName: string) {
  if (ghInstallation === null) return;
  setPhase("detecting"); setError("");
  try {
    const res = await fetch("/api/detect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: `github.com/${fullName}`, installationId: ghInstallation }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "detection failed");
    setDetectMeta({ framework: data.framework, dbEngine: data.dbEngine });
    cloneToken.current = typeof data.cloneToken === "string" ? data.cloneToken : null;
    setIsStatic(data.serve?.mode === "static");
    if (Array.isArray(data.secretsNeeded) && data.secretsNeeded.length) {
      setSecretsNeeded(data.secretsNeeded);
      setSecretVals(Object.fromEntries(data.secretsNeeded.map((s: string) => [s, ""])));
      setPhase("secrets");
    } else {
      runDeploy({});
    }
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    setPhase("error");
  }
}
```

In `runDeploy`, add `installationId: door === "github" ? ghInstallation : null` to the JSON body.

- [ ] **Step 5: Build and commit**

```bash
cd apps/web && npx tsc --noEmit && npm run build 2>&1 | tail -10
git add apps/web/app/new/page.tsx
git commit -m "The GitHub door lists what you connected instead of asking you to type it"
git push
```

---

### Task 10: The end-to-end check, and the handoff

**Files:**
- Create: `apps/web/scripts/github-check.ts`
- Modify: `CONTEXT.md` (add **Connection** to platform language)

**Interfaces:**
- Consumes: everything above.
- Produces: `npm run github:check` — proves the whole chain against the real App, or says which link broke.

- [ ] **Step 1: Write the script**

```ts
// apps/web/scripts/github-check.ts
/**
 * The chain, end to end, against the real GitHub App.
 *
 * Unit tests cover our decisions; this covers the thing they deliberately do
 * not — that GitHub honours any of it. Run after a credential rotation, after a
 * re-install, and any time a deploy from a private repository fails in a way
 * nobody can explain.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { installationToken, appJwt, githubAppConfigured } from "../lib/github-app";
import { listRepos, authenticatedCloneUrl } from "../lib/github-repos";

async function main() {
  if (!githubAppConfigured()) throw new Error("GH_APP_ID / GH_APP_PRIVATE_KEY are not set");

  const res = await fetch("https://api.github.com/app/installations", {
    headers: { Authorization: `Bearer ${appJwt()}`, Accept: "application/vnd.github+json", "User-Agent": "supersonic" },
  });
  if (!res.ok) throw new Error(`listing installations: ${res.status} ${await res.text()}`);
  const installs = (await res.json()) as Array<{ id: number; account: { login: string } }>;
  console.log(`installations: ${installs.length}`);
  if (!installs.length) throw new Error("the App is installed nowhere — install it on an account first");

  for (const i of installs) {
    console.log(`\n${i.account.login} (installation ${i.id})`);
    const token = await installationToken(i.id);
    console.log(`  token: minted, ${token.slice(0, 4)}…`);
    const repos = await listRepos(i.id);
    console.log(`  repositories: ${repos.length}`);
    const target = repos.find((r) => r.private) ?? repos[0];
    if (!target) { console.log("  nothing to clone — the installation sees no repositories"); continue; }
    const dir = mkdtempSync(join(tmpdir(), "ghcheck-"));
    try {
      execFileSync("git", [
        "clone", "--depth", "1",
        authenticatedCloneUrl(`https://github.com/${target.fullName}.git`, token),
        dir,
      ], { stdio: "pipe" });
      console.log(`  clone of ${target.fullName}${target.private ? " (private)" : ""}: ok`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log("\nthe chain works end to end");
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
```

Add to `apps/web/package.json` scripts:

```json
"github:check": "node --import tsx scripts/github-check.ts"
```

- [ ] **Step 2: Run it**

```bash
cd apps/web && npm run github:check
```

Expected: `installations: 1`, a minted token, `repositories: 1`, `clone of thebaycloud/bay (private): ok`, `the chain works end to end`.

- [ ] **Step 3: Add the term to CONTEXT.md**

Under **Platform language**, in alphabetical position:

```markdown
**Connection**:
An **installation** of our GitHub App, owned by one workspace. The record of
what a person granted us — which account, which repositories — and never a
token. A token is minted from a connection and lives an hour; the connection
outlives every token made from it.
_Avoid_: integration, link, OAuth connection, GitHub account.
Product language says *connected account*.
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/scripts/github-check.ts apps/web/package.json CONTEXT.md
git commit -m "One command proves the GitHub chain, and the word for it is written down"
git push
```

---

## What changed during execution

Two things in this plan were wrong and were corrected while building. Recorded
here rather than quietly fixed, because a plan that disagrees with the code is
worse than no plan.

**Route files cannot export helpers.** Tasks 5, 6 and 7 put testable decisions
next to their handlers and exported them. Next validates the exports of a
`route.ts` and rejects anything that is not a handler or a config value, and no
route in this repository does it either. The decisions moved to
`lib/github-setup.ts`, `lib/github-import.ts` and `lib/github-clone.ts`; the
routes are plumbing.

**`cloneTargetFor` and `cloneAuthFor` were one function written twice.** Tasks 7
and 8 each defined a helper that asked the same question — may this workspace
clone through this installation — and differed only in whether the caller wanted
a URL or a token. They became one `cloneTokenFor` in `lib/github-clone.ts`,
because a check written twice disagrees with itself eventually and this one is
the security boundary of the phase.

Two things were added that the plan did not anticipate.

**`redactToken`.** Today's git already strips userinfo from its error messages —
checked against both a missing repository and an unresolvable host — but
`/api/detect` returns git's message straight to a browser, and the ADR's claim
that the token reaches no log line and no response should not rest on another
program's error formatting.

**`installationId == null`, not `=== null`.** A strict check turned "nobody named
an installation" into "that account is not connected to your workspace" for every
caller that simply omits the field, which is every upload and every run row
written before the column existed. It broke 26 deploy-pipeline tests; without
those tests it would have broken every upload deploy in production.

## Self-Review

**Spec coverage.** Every claim in ADR 0005 has a task: the App/login separation is Task 1's credential module and nothing widens the login; `installation → workspace` is Task 2's table; the app naming its grant is Task 2's `apps.gh_installation_id` written in Task 8; the three refusals are Task 1's `GithubRefusal`, surfaced in Task 6's 409 and Task 9's three sentences; no webhook appears anywhere; the token-never-logged claim is Task 4's assertion.

**Placeholder scan.** No TBDs. Every code step is complete code. Task 9's `/* the existing url door, unchanged */` is a deliberate instruction to leave existing JSX in place, not a stub — the surrounding markup is quoted in the file it modifies.

**Type consistency.** `installationId` is a `number` everywhere and is coerced from Postgres's bigint string exactly once, in `connectionsForWorkspace`. `Repo` is defined in Task 3 and used unchanged in Tasks 6 and 9. `GithubError.refusal.kind` has the same three values in Tasks 1, 6 and 9. Task 8 renames its local to `gitToken` because `cloneToken` already means the clone-cache handle in that function — the collision is called out at the step that would otherwise cause it.

**One gap accepted.** Task 5's callback trusts that a person who reaches it with an installation id may claim it. GitHub does not sign the setup redirect, so the check available today is "is this an installation of our App" — which the mint performs. Phase two's `installation` webhook carries the account independently and is where that gets tightened. Written down rather than left implicit.
