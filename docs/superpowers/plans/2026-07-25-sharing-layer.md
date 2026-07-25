# Sharing Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every deployed app private by default and reachable only through a Supersonic auth proxy that signs visitors in with Google, checks access, and hands the app the visitor's identity.

**Architecture:** A new `services/proxy` Cloud Run service sits behind a wildcard-cert load balancer for `*.supersonic.cv`. It resolves the slug from the Host header, validates the Auth.js session cookie (shared across subdomains via `Domain=.supersonic.cv`), evaluates a pure access check against Postgres, then pipes the request to the app's Cloud Run URL using a minted ID token. Apps deploy with `--no-allow-unauthenticated` so the proxy is the only path in.

**Tech Stack:** Node 22, TypeScript, `node:test` + `tsx`, Next.js 14 (App Router), Auth.js v5 (`next-auth@5.0.0-beta.32`, `@auth/core@0.41.3`), `pg`, Google Cloud Run, Cloud SQL Postgres, `gcloud` CLI.

**Spec:** `docs/superpowers/specs/2026-07-25-sharing-layer-design.md`

## Global Constraints

- Node 22. The repo has no test infrastructure; this plan introduces `node:test` run through `tsx`. Test scripts must pass a **quoted glob** (`--test 'test/**/*.test.ts'`), not a bare directory — on Node 22.22.1 `--test test/` resolves the directory as a module specifier and fails without running anything.
- `visibility` is exactly one of `'private' | 'shared' | 'workspace'`. Default on deploy is `'private'`.
- Grants key on **email**, never `user_id` — invitees may not have signed in yet.
- Personal workspaces have `domain = NULL` and `kind = 'personal'`; only `kind = 'company'` workspaces are joinable by domain match.
- The proxy **strips all inbound `X-Supersonic-*` headers** before injecting real ones.
- The proxy **strips the Supersonic session cookie** before forwarding to a tenant app.
- The proxy **re-scopes upstream `Set-Cookie` to host-only** (drops any `Domain=` attribute).
- The proxy **must not buffer** request or response bodies — SSE and WebSockets must pass through.
- The `apps` row is inserted **before** `gcloud run deploy`, updated after.
- GCP project is `supersonic-deploy-prod`, region `us-central1`.
- Session cookie name: `__Secure-authjs.session-token` in production, `authjs.session-token` otherwise. This exact string is also the **salt** passed to `decode()`.

---

## File Structure

**New — `services/proxy/`** (one responsibility per file):

| File | Responsibility |
|---|---|
| `src/config.ts` | Read + validate env vars once |
| `src/registry.ts` | `slug → app row` lookup from Postgres, in-memory cache |
| `src/session.ts` | Decode the Auth.js JWT cookie into a visitor |
| `src/access.ts` | **Pure** access decision — no I/O |
| `src/headers.ts` | **Pure** header scrubbing + identity injection + Set-Cookie re-scoping |
| `src/idtoken.ts` | Mint Cloud Run ID tokens from the metadata server, cached |
| `src/forward.ts` | Stream the request upstream and the response back |
| `src/pages.ts` | 403 / 404 / 502 HTML |
| `src/index.ts` | HTTP server wiring the above together |

**New — `apps/web/`:**

| File | Responsibility |
|---|---|
| `db/001_sharing.sql` | Idempotent schema for workspaces / apps / grants |
| `db/migrate.ts` | Apply the SQL file |
| `db/backfill-apps.ts` | Import pre-existing Cloud Run services into `apps` |
| `lib/workspace.ts` | **Pure** public-provider detection + workspace resolution |
| `lib/apps.ts` | `apps` / `app_grants` data access |
| `app/api/apps/[slug]/share/route.ts` | Read/update visibility and grants |
| `components/SharePanel.tsx` | Minimal sharing UI |

**Modified — `apps/web/`:** `auth.config.ts` (cookie domain, cross-subdomain redirect), `auth.ts` (assign workspace on sign-in), `app/api/deploy/route.ts` (record app, seal deploy, drop domain mapping, fix probe).

---

### Task 1: Database schema

**Files:**
- Create: `apps/web/db/001_sharing.sql`
- Create: `apps/web/db/migrate.ts`
- Modify: `apps/web/package.json` (add `db:migrate` script, add `tsx` devDependency)

**Interfaces:**
- Consumes: `lib/pg-config.ts` → `pgConfig()`, `isCloudRun()` (existing)
- Produces: tables `workspaces`, `apps`, `app_grants`; column `users.workspace_id`

- [ ] **Step 1: Write the schema**

Create `apps/web/db/001_sharing.sql`. All statements are idempotent so re-running is safe — this is why no migration-tracking table is needed.

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain     text UNIQUE,
  kind       text NOT NULL DEFAULT 'company',
  name       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_kind_check CHECK (kind IN ('company', 'personal')),
  CONSTRAINT workspaces_company_has_domain CHECK (kind = 'personal' OR domain IS NOT NULL)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);

CREATE TABLE IF NOT EXISTS apps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  owner_id     uuid NOT NULL REFERENCES users(id),
  run_url      text,
  visibility   text NOT NULL DEFAULT 'private',
  status       text NOT NULL DEFAULT 'deploying',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apps_visibility_check CHECK (visibility IN ('private', 'shared', 'workspace')),
  CONSTRAINT apps_status_check CHECK (status IN ('deploying', 'live', 'failed'))
);

CREATE TABLE IF NOT EXISTS app_grants (
  app_id     uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, email)
);

CREATE INDEX IF NOT EXISTS apps_workspace_idx ON apps(workspace_id);
CREATE INDEX IF NOT EXISTS apps_owner_idx     ON apps(owner_id);
```

- [ ] **Step 2: Write the migration runner**

Create `apps/web/db/migrate.ts`:

```ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "../lib/db";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(here, "001_sharing.sql"), "utf8");
  const pool = getPool("supersonic_platform");
  await pool.query(sql);
  console.log("migration 001_sharing applied");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Add the script and tsx**

In `apps/web/package.json`, add to `scripts`:

```json
"db:migrate": "node --import tsx db/migrate.ts",
"test": "node --import tsx --test test/"
```

And to `devDependencies`:

```json
"tsx": "^4.19.1"
```

Then run: `npm install`

- [ ] **Step 4: Apply and verify**

Start the Cloud SQL proxy on port 5433 first (the local path in `lib/db.ts` expects it), then run:

```bash
cd apps/web && npm run db:migrate
```

Expected output: `migration 001_sharing applied`

Verify the tables landed:

```bash
psql -h 127.0.0.1 -p 5433 -U postgres -d supersonic_platform \
  -c "\dt workspaces apps app_grants" \
  -c "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='workspace_id';"
```

Expected: three tables listed, and one row `workspace_id`.

- [ ] **Step 5: Verify idempotency**

Run `npm run db:migrate` a second time. Expected: same success output, no error. This is what lets the script be re-run safely on every deploy.

- [ ] **Step 6: Commit**

```bash
git add apps/web/db apps/web/package.json apps/web/package-lock.json
git commit -m "feat(db): workspaces, apps, and app_grants schema"
```

---

### Task 2: Workspace resolution

**Files:**
- Create: `apps/web/lib/workspace.ts`
- Create: `apps/web/test/workspace.test.ts`
- Modify: `apps/web/auth.ts:33-40` (the `signIn` callback)

**Interfaces:**
- Consumes: `lib/db.ts` → `getPool(dbName)`
- Produces:
  - `isPublicEmailProvider(domain: string): boolean`
  - `domainOf(email: string): string`
  - `resolveWorkspaceForEmail(email: string): Promise<string>` — returns `workspaces.id`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/workspace.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicEmailProvider, domainOf } from "../lib/workspace";

test("domainOf lowercases and takes the part after @", () => {
  assert.equal(domainOf("Boris@Acme.COM"), "acme.com");
});

test("company domains are not public providers", () => {
  assert.equal(isPublicEmailProvider("acme.com"), false);
  assert.equal(isPublicEmailProvider("supersonic.cv"), false);
});

test("consumer providers are public", () => {
  for (const d of ["gmail.com", "yandex.ru", "mail.ru", "outlook.com", "icloud.com", "proton.me"]) {
    assert.equal(isPublicEmailProvider(d), true, `${d} should be public`);
  }
});

test("public provider matching is case-insensitive", () => {
  assert.equal(isPublicEmailProvider("GMAIL.COM"), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npm test`
Expected: FAIL — `Cannot find module '../lib/workspace'`

- [ ] **Step 3: Write the implementation**

Create `apps/web/lib/workspace.ts`:

```ts
import { getPool } from "./db";

const DB = "supersonic_platform";

/** Consumer mail providers — these must never form a shared workspace. */
const PUBLIC_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "yandex.ru", "yandex.com", "mail.ru",
  "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com",
  "proton.me", "protonmail.com", "aol.com", "gmx.com", "zoho.com",
  "yahoo.com", "inbox.ru", "bk.ru", "list.ru",
]);

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

export function isPublicEmailProvider(domain: string): boolean {
  return PUBLIC_PROVIDERS.has(domain.trim().toLowerCase());
}

/**
 * Find or create the workspace this email belongs to.
 * Company domains share one workspace; consumer addresses get a personal one.
 */
export async function resolveWorkspaceForEmail(email: string): Promise<string> {
  const pool = getPool(DB);
  const domain = domainOf(email);

  if (!domain || isPublicEmailProvider(domain)) {
    const r = await pool.query(
      `INSERT INTO workspaces(domain, kind, name) VALUES(NULL, 'personal', $1) RETURNING id`,
      [email.toLowerCase()]
    );
    return r.rows[0].id;
  }

  const r = await pool.query(
    `INSERT INTO workspaces(domain, kind, name) VALUES($1, 'company', $1)
     ON CONFLICT(domain) DO UPDATE SET domain = EXCLUDED.domain
     RETURNING id`,
    [domain]
  );
  return r.rows[0].id;
}
```

The `DO UPDATE` is a no-op write that exists solely so `RETURNING id` yields a row on conflict; `DO NOTHING` would return zero rows.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npm test`
Expected: PASS — 4 tests.

- [ ] **Step 5: Assign the workspace on sign-in**

In `apps/web/auth.ts`, replace the `signIn` callback (currently lines 33–40) with:

```ts
    async signIn({ user, account }) {
      if (!user.email) return false;
      if (account && account.provider !== "credentials") {
        await createUser(user.email, user.name ?? "", null, account.provider);
      }
      const workspaceId = await resolveWorkspaceForEmail(user.email);
      await getPool("supersonic_platform").query(
        `UPDATE users SET workspace_id = $1 WHERE email = $2 AND workspace_id IS NULL`,
        [workspaceId, user.email.toLowerCase()]
      );
      return true;
    },
```

Add these imports at the top of `auth.ts`:

```ts
import { resolveWorkspaceForEmail } from "@/lib/workspace";
import { getPool } from "@/lib/db";
```

The `AND workspace_id IS NULL` guard means a user is never silently moved between workspaces on a later sign-in.

- [ ] **Step 6: Verify sign-in assigns a workspace**

Run `npm run dev`, sign in with a Google account, then:

```bash
psql -h 127.0.0.1 -p 5433 -U postgres -d supersonic_platform \
  -c "SELECT u.email, w.domain, w.kind FROM users u JOIN workspaces w ON w.id = u.workspace_id;"
```

Expected: one row, `kind = 'company'` with your work domain (or `personal` / `NULL` domain for a gmail address).

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/workspace.ts apps/web/test/workspace.test.ts apps/web/auth.ts
git commit -m "feat(auth): resolve a workspace from the email domain on sign-in"
```

---

### Task 3: Cross-subdomain session cookie

**Files:**
- Modify: `apps/web/auth.config.ts`

**Interfaces:**
- Produces: session cookie readable at every `*.supersonic.cv` host; sign-in redirects permitted across subdomains.

Without this task the proxy can never see a session — the cookie is host-only by default, so `sprint.supersonic.cv` would not receive a cookie set by `app.supersonic.cv`.

- [ ] **Step 1: Add the cookie domain and redirect callback**

Replace the contents of `apps/web/auth.config.ts` with:

```ts
import type { NextAuthConfig } from "next-auth";

const PROD = process.env.NODE_ENV === "production";

/** ".supersonic.cv" in production; unset locally so cookies stay host-only. */
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;

export const SESSION_COOKIE_NAME = PROD
  ? "__Secure-authjs.session-token"
  : "authjs.session-token";

// Edge-safe config (no Node-only imports) — used by middleware.
export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  trustHost: true,
  providers: [],
  cookies: {
    sessionToken: {
      name: SESSION_COOKIE_NAME,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: PROD,
        domain: COOKIE_DOMAIN,
      },
    },
  },
  callbacks: {
    authorized({ auth, request }) {
      const p = request.nextUrl.pathname;
      const isPublic =
        p.startsWith("/login") || p.startsWith("/signup") ||
        p.startsWith("/api/auth") || p.startsWith("/api/signup");
      if (isPublic) return true;
      return !!auth?.user;
    },
    session({ session, token }) {
      if (token.sub && session.user) (session.user as { id?: string }).id = token.sub;
      return session;
    },
    // Allow returning to any *.supersonic.cv host after sign-in, so the proxy
    // can bounce a visitor to /login and get them back to the tool they wanted.
    redirect({ url, baseUrl }) {
      try {
        const target = new URL(url, baseUrl);
        if (target.protocol !== "https:" && target.protocol !== "http:") return baseUrl;
        if (!COOKIE_DOMAIN) return target.origin === new URL(baseUrl).origin ? target.toString() : baseUrl;
        const root = COOKIE_DOMAIN.replace(/^\./, "");
        if (target.hostname === root || target.hostname.endsWith("." + root)) return target.toString();
      } catch { /* fall through */ }
      return baseUrl;
    },
  },
} satisfies NextAuthConfig;
```

The `__Secure-` prefix is required for a cookie that is both `Secure` and carries a `Domain`; `__Host-` would forbid `Domain` and break cross-subdomain sharing.

- [ ] **Step 2: Set the env var**

Add to `apps/web/.env.local` (create if absent — it is gitignored):

```
COOKIE_DOMAIN=
```

Empty locally so cookies stay host-only on `localhost`. In production set `COOKIE_DOMAIN=.supersonic.cv`.

- [ ] **Step 3: Verify sign-in still works locally**

Run `npm run dev`, sign out, sign back in. Expected: sign-in succeeds and the cockpit loads. In DevTools → Application → Cookies, expect a cookie named `authjs.session-token`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/auth.config.ts
git commit -m "feat(auth): share the session cookie across *.supersonic.cv"
```

---

### Task 4: App records data layer

**Files:**
- Create: `apps/web/lib/apps.ts`

**Interfaces:**
- Consumes: `lib/db.ts` → `getPool`
- Produces:
  - `type Visibility = "private" | "shared" | "workspace"`
  - `createAppRecord(o: { slug: string; workspaceId: string; ownerId: string }): Promise<string>`
  - `markAppLive(slug: string, runUrl: string): Promise<void>`
  - `markAppFailed(slug: string): Promise<void>`
  - `getAppBySlug(slug: string): Promise<AppRecord | null>`
  - `setVisibility(slug: string, v: Visibility): Promise<void>`
  - `listGrants(slug: string): Promise<string[]>`
  - `addGrant(slug: string, email: string): Promise<void>`
  - `removeGrant(slug: string, email: string): Promise<void>`

- [ ] **Step 1: Write the data layer**

Create `apps/web/lib/apps.ts`:

```ts
import { getPool } from "./db";

const DB = "supersonic_platform";

export type Visibility = "private" | "shared" | "workspace";

export interface AppRecord {
  id: string;
  slug: string;
  workspace_id: string;
  owner_id: string;
  run_url: string | null;
  visibility: Visibility;
  status: "deploying" | "live" | "failed";
}

/** Insert (or reclaim) the row for a slug. Called BEFORE the deploy runs. */
export async function createAppRecord(o: {
  slug: string; workspaceId: string; ownerId: string;
}): Promise<string> {
  const r = await getPool(DB).query(
    `INSERT INTO apps(slug, workspace_id, owner_id, status)
     VALUES($1, $2, $3, 'deploying')
     ON CONFLICT(slug) DO UPDATE SET status = 'deploying'
     RETURNING id`,
    [o.slug, o.workspaceId, o.ownerId]
  );
  return r.rows[0].id;
}

export async function markAppLive(slug: string, runUrl: string): Promise<void> {
  await getPool(DB).query(
    `UPDATE apps SET run_url = $2, status = 'live' WHERE slug = $1`,
    [slug, runUrl]
  );
}

export async function markAppFailed(slug: string): Promise<void> {
  await getPool(DB).query(`UPDATE apps SET status = 'failed' WHERE slug = $1`, [slug]);
}

export async function getAppBySlug(slug: string): Promise<AppRecord | null> {
  const r = await getPool(DB).query(`SELECT * FROM apps WHERE slug = $1`, [slug]);
  return r.rows[0] ?? null;
}

export async function setVisibility(slug: string, v: Visibility): Promise<void> {
  await getPool(DB).query(`UPDATE apps SET visibility = $2 WHERE slug = $1`, [slug, v]);
}

export async function listGrants(slug: string): Promise<string[]> {
  const r = await getPool(DB).query(
    `SELECT g.email FROM app_grants g JOIN apps a ON a.id = g.app_id
     WHERE a.slug = $1 ORDER BY g.email`,
    [slug]
  );
  return r.rows.map((x: { email: string }) => x.email);
}

export async function addGrant(slug: string, email: string): Promise<void> {
  await getPool(DB).query(
    `INSERT INTO app_grants(app_id, email)
     SELECT a.id, $2 FROM apps a WHERE a.slug = $1
     ON CONFLICT DO NOTHING`,
    [slug, email.trim().toLowerCase()]
  );
}

export async function removeGrant(slug: string, email: string): Promise<void> {
  await getPool(DB).query(
    `DELETE FROM app_grants g USING apps a
     WHERE g.app_id = a.id AND a.slug = $1 AND g.email = $2`,
    [slug, email.trim().toLowerCase()]
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/apps.ts
git commit -m "feat(apps): data layer for app records and grants"
```

---

### Task 5: Seal the deploy path

**Files:**
- Modify: `apps/web/app/api/deploy/route.ts` — lines 112–129 (`probeApp`), 169–180 (`createDomainMapping`), 182–299 (the `POST` handler)

**Interfaces:**
- Consumes: `lib/apps.ts` → `createAppRecord`, `markAppLive`, `markAppFailed`; `lib/session.ts` → `currentUserId`
- Produces: apps deployed with `--no-allow-unauthenticated`, invoker bound to the proxy SA, an `apps` row per deploy

This is the task that closes the `*.run.app` bypass.

- [ ] **Step 1: Replace `probeApp` so it authenticates**

A sealed app returns 403 to an anonymous fetch — not a 5xx, and with no recognizable phrase — so the current probe would report success for every app and silently stop catching broken deploys. Replace lines 112–129 with:

```ts
/** Mint an ID token for a Cloud Run URL so we can call a sealed service. */
async function idTokenFor(audience: string): Promise<string> {
  return (await capture("gcloud", ["auth", "print-identity-token", `--audiences=${audience}`])).trim();
}

// After a deploy passes Cloud Run's health check, actually fetch the app: a
// server can "listen" yet still reject the real request (e.g. Vite preview host
// allowlisting), which we must catch and repair. The app is sealed, so this
// request carries an ID token exactly as the proxy's would.
async function probeApp(url: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const token = await idTokenFor(url);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { Authorization: `Bearer ${token}` } });
    clearTimeout(to);
    const body = (await r.text()).slice(0, 3000);
    if (r.status === 403) return { ok: false, reason: "App is sealed but the deployer identity cannot invoke it — check the run.invoker binding." };
    if (r.status >= 500) return { ok: false, reason: `App is up but returns HTTP ${r.status}: ${body.replace(/\s+/g, " ").slice(0, 240)}` };
    if (/blocked request|allowedhosts|is not allowed|cannot get \/|application error|internal server error/i.test(body))
      return { ok: false, reason: `App started but rejected the request: "${body.replace(/\s+/g, " ").slice(0, 240)}"` };
    return { ok: true };
  } catch {
    return { ok: true }; // network/timeout (likely cold start) — don't false-fail
  }
}
```

- [ ] **Step 2: Delete `createDomainMapping`**

Remove the entire function at lines 169–180. The wildcard certificate on the load balancer covers every slug, so per-app mappings and their ~15-minute SSL wait are obsolete.

- [ ] **Step 3: Replace the deploy flags and add the invoker binding**

In the `POST` handler, replace the `deployArgs` block (currently lines 246–253) with:

```ts
        const deployArgs = [
          "run", "deploy", slug, "--source", dir,
          "--region", REGION, "--no-allow-unauthenticated",
          "--project", PROJECT, "--format=json",
        ];
        if (cloudsql) deployArgs.push(`--set-cloudsql-instances=${cloudsql}`);
        if (extraEnv.length) deployArgs.push(`--set-env-vars=^~~^${extraEnv.join("~~")}`);
        if (ownerId) deployArgs.push(`--update-labels=supersonic-owner=${ownerId}`);
```

Then add this helper next to `provisionStorage`:

```ts
const PROXY_SA = process.env.PROXY_SERVICE_ACCOUNT
  ?? "supersonic-proxy@supersonic-deploy-prod.iam.gserviceaccount.com";

/** Only the proxy may invoke the app. This is what seals the *.run.app bypass. */
async function grantProxyInvoker(slug: string, log: (l: string) => void): Promise<void> {
  try {
    await capture("gcloud", [
      "run", "services", "add-iam-policy-binding", slug,
      "--member", `serviceAccount:${PROXY_SA}`,
      "--role", "roles/run.invoker",
      "--region", REGION, "--project", PROJECT,
    ]);
    log("Sealed — reachable only through Supersonic");
  } catch (e) {
    log(`! could not bind proxy invoker: ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

- [ ] **Step 4: Record the app around the deploy**

Immediately after `const ownerId = await currentUserId();` (line 187), add the workspace lookup:

```ts
  const ownerWorkspace = ownerId
    ? (await getPool("supersonic_platform").query(
        `SELECT workspace_id FROM users WHERE id = $1`, [ownerId]
      )).rows[0]?.workspace_id ?? null
    : null;
```

Inside the stream, right after `send({ type: "start", slug, url });`, insert the row **before** any deploy work:

```ts
        if (ownerId && ownerWorkspace) {
          await createAppRecord({ slug, workspaceId: ownerWorkspace, ownerId });
        }
```

Replace the success tail (currently lines 297–299) with:

```ts
        log(`Live at ${result.url}`);
        await grantProxyInvoker(slug, log);
        if (ownerId && ownerWorkspace) await markAppLive(slug, result.url ?? "");
        log(`Private — open ${slug}.supersonic.cv to share it`);
        send({ type: "done", slug, url: `https://${slug}.supersonic.cv` });
```

And in the failure branch, replace `else { send({ type: "error", message: fixed.summary }); return; }` with:

```ts
          else {
            if (ownerId && ownerWorkspace) await markAppFailed(slug);
            send({ type: "error", message: fixed.summary });
            return;
          }
```

Add the imports at the top of the file:

```ts
import { createAppRecord, markAppLive, markAppFailed } from "@/lib/apps";
import { getPool } from "@/lib/db";
```

- [ ] **Step 5: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors. In particular, no remaining reference to `createDomainMapping`.

- [ ] **Step 6: Deploy a test app and confirm it is sealed**

Deploy `examples/hello` through the UI, then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$(gcloud run services describe hello --region us-central1 --project supersonic-deploy-prod --format='value(status.url)')"
```

Expected: `403` — the raw `run.app` URL no longer serves the app to anonymous callers. Before this task it returned `200`.

Confirm the row exists:

```bash
psql -h 127.0.0.1 -p 5433 -U postgres -d supersonic_platform \
  -c "SELECT slug, status, visibility, run_url FROM apps;"
```

Expected: one row, `status = live`, `visibility = private`, `run_url` populated.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/deploy/route.ts
git commit -m "feat(deploy): seal apps behind the proxy and record them in Postgres"
```

---

### Task 6: Proxy scaffold and registry

**Files:**
- Create: `services/proxy/package.json`, `services/proxy/tsconfig.json`
- Create: `services/proxy/src/config.ts`, `services/proxy/src/registry.ts`, `services/proxy/src/pages.ts`, `services/proxy/src/index.ts`

**Interfaces:**
- Produces:
  - `config` object with `port`, `authSecret`, `sessionCookieName`, `loginUrl`, `rootDomain`
  - `lookupApp(slug: string): Promise<AppRow | null>` with 30s in-memory cache
  - `page403(owner: string)`, `page404()`, `page502(slug: string)` → HTML strings

- [ ] **Step 1: Create the package**

Create `services/proxy/package.json`:

```json
{
  "name": "@supersonic/proxy",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --import tsx --watch src/index.ts",
    "start": "node --import tsx src/index.ts",
    "test": "node --import tsx --test 'src/**/*.test.ts'"
  },
  "dependencies": {
    "@auth/core": "0.41.3",
    "pg": "^8.22.0"
  },
  "devDependencies": {
    "@types/node": "^22.7.5",
    "@types/pg": "^8.20.0",
    "tsx": "^4.19.1",
    "typescript": "^5.6.3"
  }
}
```

Create `services/proxy/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

Run: `cd services/proxy && npm install`

- [ ] **Step 2: Write the config module**

Create `services/proxy/src/config.ts`:

```ts
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

const PROD = process.env.NODE_ENV === "production";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  authSecret: required("AUTH_SECRET"),
  /** Must match apps/web auth.config.ts exactly — it is also the decode salt. */
  sessionCookieName: PROD ? "__Secure-authjs.session-token" : "authjs.session-token",
  loginUrl: process.env.LOGIN_URL ?? "https://app.supersonic.cv/login",
  rootDomain: process.env.ROOT_DOMAIN ?? "supersonic.cv",
};
```

- [ ] **Step 3: Write the registry**

Create `services/proxy/src/registry.ts`:

```ts
import { Pool } from "pg";

export interface AppRow {
  id: string;
  slug: string;
  workspace_id: string;
  owner_id: string;
  owner_email: string;
  run_url: string | null;
  visibility: "private" | "shared" | "workspace";
  status: "deploying" | "live" | "failed";
}

const CACHE_MS = 30_000;
const cache = new Map<string, { row: AppRow | null; at: number }>();

let pool: Pool | null = null;
function db(): Pool {
  if (pool) return pool;
  const connectionName = process.env.PG_CONN ?? "supersonic-deploy-prod:us-central1:supersonic-shared-pg";
  pool = process.env.K_SERVICE
    ? new Pool({ host: `/cloudsql/${connectionName}`, user: process.env.PG_USER ?? "postgres", password: process.env.PG_PASSWORD, database: "supersonic_platform", max: 5 })
    : new Pool({ host: "127.0.0.1", port: 5433, user: process.env.PG_USER ?? "postgres", password: process.env.PG_PASSWORD, database: "supersonic_platform", max: 5 });
  return pool;
}

export async function lookupApp(slug: string): Promise<AppRow | null> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row;

  const r = await db().query(
    `SELECT a.*, u.email AS owner_email
     FROM apps a JOIN users u ON u.id = a.owner_id
     WHERE a.slug = $1`,
    [slug]
  );
  const row = (r.rows[0] as AppRow | undefined) ?? null;
  cache.set(slug, { row, at: Date.now() });
  return row;
}

/** Does this email have an explicit grant on this app? */
export async function hasGrant(appId: string, email: string): Promise<boolean> {
  const r = await db().query(
    `SELECT 1 FROM app_grants WHERE app_id = $1 AND email = $2`,
    [appId, email.toLowerCase()]
  );
  return r.rowCount ? r.rowCount > 0 : false;
}

/** Workspace of a signed-in visitor, or null if they have no user row yet. */
export async function workspaceOfUser(userId: string): Promise<string | null> {
  const r = await db().query(`SELECT workspace_id FROM users WHERE id = $1`, [userId]);
  return r.rows[0]?.workspace_id ?? null;
}
```

- [ ] **Step 4: Write the error pages**

Create `services/proxy/src/pages.ts`:

```ts
function shell(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
body{font:16px/1.6 ui-sans-serif,system-ui,sans-serif;margin:0;min-height:100vh;
display:grid;place-items:center;background:#0b0b0c;color:#e8e8ea}
main{max-width:32rem;padding:2rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#9a9aa2}
code{background:#1a1a1d;padding:.1rem .35rem;border-radius:.25rem}
</style><main>${body}</main>`;
}

export function page403(ownerEmail: string): string {
  return shell("No access", `<h1>You don't have access to this tool</h1>
<p>Ask <code>${escapeHtml(ownerEmail)}</code> to share it with you.</p>`);
}

export function page404(): string {
  return shell("Not found", `<h1>No such tool</h1>
<p>This address isn't pointing at anything.</p>`);
}

export function page502(slug: string): string {
  return shell("Unavailable", `<h1>This tool isn't responding</h1>
<p><code>${escapeHtml(slug)}</code> is deployed but not answering right now.</p>`);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
```

- [ ] **Step 5: Write a minimal server that resolves slugs**

Create `services/proxy/src/index.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config";
import { lookupApp } from "./registry";
import { page404, page502 } from "./pages";

function slugFromHost(host: string | undefined): string | null {
  if (!host) return null;
  const name = host.split(":")[0].toLowerCase();
  if (!name.endsWith("." + config.rootDomain)) return null;
  const slug = name.slice(0, -(config.rootDomain.length + 1));
  return /^[a-z0-9-]+$/.test(slug) ? slug : null;
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.url === "/_healthz") { res.writeHead(200).end("ok"); return; }

  const slug = slugFromHost(req.headers.host);
  if (!slug) return html(res, 404, page404());

  const app = await lookupApp(slug);
  if (!app) return html(res, 404, page404());
  if (!app.run_url) return html(res, 502, page502(slug));

  // Auth and forwarding arrive in Tasks 7-9.
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`resolved ${slug} -> ${app.run_url}`);
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("internal error");
  });
}).listen(config.port, () => console.log(`proxy listening on :${config.port}`));
```

- [ ] **Step 6: Run it and verify slug resolution**

With the Cloud SQL proxy running and a deployed app in the `apps` table:

```bash
cd services/proxy
AUTH_SECRET=dev-secret PG_PASSWORD="$(node -e "console.log(require('../../apps/web/.pg.json').password)")" npm start
```

In another shell:

```bash
curl -s -H "Host: hello.supersonic.cv" http://localhost:8080/
curl -s -H "Host: nosuchapp.supersonic.cv" http://localhost:8080/ | head -3
curl -s http://localhost:8080/_healthz
```

Expected: first prints `resolved hello -> https://hello-….run.app`; second returns the "No such tool" page; third prints `ok`.

- [ ] **Step 7: Commit**

```bash
git add services/proxy
git commit -m "feat(proxy): scaffold with slug resolution and app registry"
```

---

### Task 7: Session decoding

**Files:**
- Create: `services/proxy/src/session.ts`
- Modify: `services/proxy/src/index.ts`

**Interfaces:**
- Consumes: `config.authSecret`, `config.sessionCookieName`, `config.loginUrl`
- Produces:
  - `type Visitor = { userId: string; email: string; name: string }`
  - `readVisitor(req: IncomingMessage): Promise<Visitor | null>`
  - `signInRedirect(req: IncomingMessage): string`

- [ ] **Step 1: Write the session module**

Create `services/proxy/src/session.ts`:

```ts
import type { IncomingMessage } from "node:http";
import { decode } from "@auth/core/jwt";
import { config } from "./config";

export interface Visitor { userId: string; email: string; name: string }

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function readVisitor(req: IncomingMessage): Promise<Visitor | null> {
  const raw = parseCookies(req.headers.cookie)[config.sessionCookieName];
  if (!raw) return null;
  try {
    // In Auth.js v5 the salt is the cookie name.
    const token = await decode({
      token: raw,
      secret: config.authSecret,
      salt: config.sessionCookieName,
    });
    if (!token?.sub || !token.email) return null;
    return { userId: token.sub, email: String(token.email).toLowerCase(), name: String(token.name ?? "") };
  } catch {
    return null;
  }
}

/** Where to send an anonymous visitor, preserving the page they wanted. */
export function signInRedirect(req: IncomingMessage): string {
  const host = (req.headers.host ?? "").split(":")[0];
  const back = `https://${host}${req.url ?? "/"}`;
  return `${config.loginUrl}?callbackUrl=${encodeURIComponent(back)}`;
}
```

- [ ] **Step 2: Wire it into the server**

In `services/proxy/src/index.ts`, add the import:

```ts
import { readVisitor, signInRedirect } from "./session";
```

and replace the placeholder block at the end of `handle` (`// Auth and forwarding arrive in Tasks 7-9.` through `res.end(...)`) with:

```ts
  const visitor = await readVisitor(req);
  if (!visitor) {
    res.writeHead(302, { Location: signInRedirect(req) });
    res.end();
    return;
  }

  // Access check and forwarding arrive in Tasks 8-9.
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`${visitor.email} -> ${app.run_url}`);
```

- [ ] **Step 3: Verify anonymous requests redirect**

Restart the proxy, then:

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" -H "Host: hello.supersonic.cv" http://localhost:8080/
```

Expected: `302 https://app.supersonic.cv/login?callbackUrl=https%3A%2F%2Fhello.supersonic.cv%2F`

- [ ] **Step 4: Verify a real cookie decodes**

Sign in to the local web app, copy the `authjs.session-token` cookie value from DevTools, then — using the same `AUTH_SECRET` the web app uses:

```bash
curl -s -H "Host: hello.supersonic.cv" -H "Cookie: authjs.session-token=<paste>" http://localhost:8080/
```

Expected: `your@email.com -> https://hello-….run.app`

If this returns a 302 instead, `AUTH_SECRET` differs between the two processes — they must match exactly.

- [ ] **Step 5: Commit**

```bash
git add services/proxy/src/session.ts services/proxy/src/index.ts
git commit -m "feat(proxy): decode the Auth.js session and redirect anonymous visitors"
```

---

### Task 8: Access check

**Files:**
- Create: `services/proxy/src/access.ts`
- Create: `services/proxy/src/access.test.ts`
- Modify: `services/proxy/src/index.ts`

**Interfaces:**
- Produces: `decideAccess(input: AccessInput): boolean` — pure, no I/O
  - `AccessInput = { app: { id, owner_id, workspace_id, visibility }, visitor: { userId, email }, visitorWorkspaceId: string | null, hasGrant: boolean }`

Keeping this function pure and I/O-free is what makes the security-critical logic exhaustively testable.

- [ ] **Step 1: Write the failing test**

Create `services/proxy/src/access.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAccess } from "./access";

const app = {
  id: "app-1",
  owner_id: "user-owner",
  workspace_id: "ws-acme",
  visibility: "private" as const,
};
const owner = { userId: "user-owner", email: "anna@acme.com" };
const colleague = { userId: "user-boris", email: "boris@acme.com" };
const outsider = { userId: "user-eve", email: "eve@other.com" };

test("owner can always open their own private app", () => {
  assert.equal(decideAccess({ app, visitor: owner, visitorWorkspaceId: "ws-acme", hasGrant: false }), true);
});

test("colleague cannot open a private app", () => {
  assert.equal(decideAccess({ app, visitor: colleague, visitorWorkspaceId: "ws-acme", hasGrant: false }), false);
});

test("colleague in the same workspace can open a workspace app", () => {
  assert.equal(decideAccess({
    app: { ...app, visibility: "workspace" }, visitor: colleague,
    visitorWorkspaceId: "ws-acme", hasGrant: false,
  }), true);
});

test("outsider cannot open a workspace app", () => {
  assert.equal(decideAccess({
    app: { ...app, visibility: "workspace" }, visitor: outsider,
    visitorWorkspaceId: "ws-other", hasGrant: false,
  }), false);
});

test("granted email can open a shared app", () => {
  assert.equal(decideAccess({
    app: { ...app, visibility: "shared" }, visitor: outsider,
    visitorWorkspaceId: "ws-other", hasGrant: true,
  }), true);
});

test("ungranted email cannot open a shared app", () => {
  assert.equal(decideAccess({
    app: { ...app, visibility: "shared" }, visitor: outsider,
    visitorWorkspaceId: "ws-other", hasGrant: false,
  }), false);
});

test("a null visitor workspace never matches a workspace app", () => {
  assert.equal(decideAccess({
    app: { ...app, visibility: "workspace" }, visitor: colleague,
    visitorWorkspaceId: null, hasGrant: false,
  }), false);
});

test("workspace visibility does not imply grant access for a different workspace", () => {
  assert.equal(decideAccess({
    app: { ...app, visibility: "workspace" }, visitor: outsider,
    visitorWorkspaceId: null, hasGrant: true,
  }), false);
});
```

The last case matters: a stale grant must not leak access once an app is switched to `workspace` visibility.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/proxy && npm test`
Expected: FAIL — `Cannot find module './access'`

- [ ] **Step 3: Write the implementation**

Create `services/proxy/src/access.ts`:

```ts
export interface AccessInput {
  app: {
    id: string;
    owner_id: string;
    workspace_id: string;
    visibility: "private" | "shared" | "workspace";
  };
  visitor: { userId: string; email: string };
  visitorWorkspaceId: string | null;
  hasGrant: boolean;
}

/**
 * The whole access model. Pure: every input is already resolved by the caller.
 * Deny is the default — every allow path must be explicit.
 */
export function decideAccess(i: AccessInput): boolean {
  if (i.visitor.userId === i.app.owner_id) return true;

  switch (i.app.visibility) {
    case "workspace":
      return i.visitorWorkspaceId !== null && i.visitorWorkspaceId === i.app.workspace_id;
    case "shared":
      return i.hasGrant;
    case "private":
      return false;
    default:
      return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/proxy && npm test`
Expected: PASS — 8 tests.

- [ ] **Step 5: Wire it into the server**

In `services/proxy/src/index.ts`, add imports:

```ts
import { decideAccess } from "./access";
import { hasGrant, workspaceOfUser } from "./registry";
import { page403 } from "./pages";
```

Replace the placeholder block (`// Access check and forwarding arrive in Tasks 8-9.` through `res.end(...)`) with:

```ts
  const [visitorWorkspaceId, granted] = await Promise.all([
    workspaceOfUser(visitor.userId),
    app.visibility === "shared" ? hasGrant(app.id, visitor.email) : Promise.resolve(false),
  ]);

  if (!decideAccess({ app, visitor, visitorWorkspaceId, hasGrant: granted })) {
    return html(res, 403, page403(app.owner_email));
  }

  // Forwarding arrives in Task 9.
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`allowed ${visitor.email} -> ${app.run_url}`);
```

- [ ] **Step 6: Verify end to end**

Restart the proxy. With the cookie of the app's owner, expect `allowed …`. Then flip the app to another owner's perspective:

```bash
psql -h 127.0.0.1 -p 5433 -U postgres -d supersonic_platform \
  -c "UPDATE apps SET owner_id = gen_random_uuid() WHERE slug='hello';"
curl -s -H "Host: hello.supersonic.cv" -H "Cookie: authjs.session-token=<paste>" http://localhost:8080/ | grep -o "don't have access"
```

Expected: `don't have access`. Restore your ownership afterwards with the real user id.

- [ ] **Step 7: Commit**

```bash
git add services/proxy/src/access.ts services/proxy/src/access.test.ts services/proxy/src/index.ts
git commit -m "feat(proxy): access decision with exhaustive tests"
```

---

### Task 9: Forwarding with header and cookie hygiene

**Files:**
- Create: `services/proxy/src/headers.ts`, `services/proxy/src/headers.test.ts`
- Create: `services/proxy/src/idtoken.ts`, `services/proxy/src/forward.ts`
- Modify: `services/proxy/src/index.ts`

**Interfaces:**
- Consumes: `Visitor` from `session.ts`
- Produces:
  - `buildUpstreamHeaders(incoming, visitor, sessionCookieName): OutgoingHttpHeaders`
  - `scrubSetCookie(headers): OutgoingHttpHeaders`
  - `idTokenFor(audience: string): Promise<string>`
  - `forward(req, res, targetUrl, visitor): Promise<void>`

This task implements three of the spec's hard security requirements at once.

- [ ] **Step 1: Write the failing test**

Create `services/proxy/src/headers.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpstreamHeaders, scrubSetCookie } from "./headers";

const visitor = { userId: "usr_1", email: "boris@acme.com", name: "Boris" };
const COOKIE = "authjs.session-token";

test("spoofed identity headers are replaced, not trusted", () => {
  const out = buildUpstreamHeaders(
    { "x-supersonic-email": "ceo@acme.com", "x-supersonic-user-id": "usr_boss" },
    visitor, COOKIE
  );
  assert.equal(out["x-supersonic-email"], "boris@acme.com");
  assert.equal(out["x-supersonic-user-id"], "usr_1");
});

test("spoofed headers in any casing are dropped", () => {
  const out = buildUpstreamHeaders({ "X-SuperSonic-Workspace": "evil.com" }, visitor, COOKIE);
  assert.equal(out["x-supersonic-workspace"], undefined);
});

test("the session cookie never reaches the app", () => {
  const out = buildUpstreamHeaders(
    { cookie: `${COOKIE}=secret-jwt; theme=dark` }, visitor, COOKIE
  );
  assert.equal(out.cookie, "theme=dark");
  assert.ok(!String(out.cookie).includes("secret-jwt"));
});

test("a cookie header containing only the session is removed entirely", () => {
  const out = buildUpstreamHeaders({ cookie: `${COOKIE}=secret-jwt` }, visitor, COOKIE);
  assert.equal(out.cookie, undefined);
});

test("identity headers are injected", () => {
  const out = buildUpstreamHeaders({}, visitor, COOKIE);
  assert.equal(out["x-supersonic-email"], "boris@acme.com");
  assert.equal(out["x-supersonic-name"], "Boris");
  assert.equal(out["x-supersonic-user-id"], "usr_1");
});

test("upstream Set-Cookie is re-scoped host-only", () => {
  const out = scrubSetCookie({
    "set-cookie": ["sid=1; Path=/; Domain=.supersonic.cv; HttpOnly", "theme=dark; Path=/"],
  });
  assert.deepEqual(out["set-cookie"], ["sid=1; Path=/; HttpOnly", "theme=dark; Path=/"]);
});

test("hop-by-hop headers are not forwarded", () => {
  const out = buildUpstreamHeaders({ connection: "keep-alive", host: "hello.supersonic.cv" }, visitor, COOKIE);
  assert.equal(out.connection, undefined);
  assert.equal(out.host, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/proxy && npm test`
Expected: FAIL — `Cannot find module './headers'`

- [ ] **Step 3: Write the implementation**

Create `services/proxy/src/headers.ts`:

```ts
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const IDENTITY_PREFIX = "x-supersonic-";
/** Hop-by-hop headers plus Host, which the upstream request sets itself. */
const DROP = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "authorization",
]);

export interface VisitorIdentity { userId: string; email: string; name: string }

/** Remove the Supersonic session cookie from a Cookie header value. */
export function stripSessionCookie(value: string, cookieName: string): string {
  return value
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !p.startsWith(cookieName + "="))
    .join("; ");
}

export function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  visitor: VisitorIdentity,
  sessionCookieName: string
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};

  for (const [rawKey, value] of Object.entries(incoming)) {
    const key = rawKey.toLowerCase();
    if (DROP.has(key)) continue;
    // Anything the client sent under our prefix is discarded unconditionally.
    if (key.startsWith(IDENTITY_PREFIX)) continue;
    if (key === "cookie") {
      const kept = stripSessionCookie(String(value ?? ""), sessionCookieName);
      if (kept) out.cookie = kept;
      continue;
    }
    out[key] = value;
  }

  out["x-supersonic-user-id"] = visitor.userId;
  out["x-supersonic-email"] = visitor.email;
  out["x-supersonic-name"] = visitor.name;
  return out;
}

/** Drop Domain= from upstream cookies so one tool cannot set a cookie for another. */
export function scrubSetCookie(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const raw = headers["set-cookie"];
  if (!raw) return headers;
  const list = Array.isArray(raw) ? raw : [String(raw)];
  headers["set-cookie"] = list.map((c) =>
    c.split(";").map((p) => p.trim()).filter((p) => !/^domain=/i.test(p)).join("; ")
  );
  return headers;
}
```

`buildUpstreamHeaders` does not set the workspace header — that is added in Step 5, where the app record is in scope.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/proxy && npm test`
Expected: PASS — 7 header tests plus the 8 access tests from Task 8.

- [ ] **Step 5: Write the ID token minter**

Create `services/proxy/src/idtoken.ts`:

```ts
const cache = new Map<string, { token: string; exp: number }>();

/**
 * Cloud Run ID token for a given audience, from the metadata server.
 * Tokens last an hour; we refresh five minutes early.
 */
export async function idTokenFor(audience: string): Promise<string> {
  const hit = cache.get(audience);
  if (hit && Date.now() < hit.exp) return hit.token;

  const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
  const r = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error(`metadata identity failed: ${r.status}`);
  const token = (await r.text()).trim();
  cache.set(audience, { token, exp: Date.now() + 55 * 60_000 });
  return token;
}
```

- [ ] **Step 6: Write the forwarder**

Create `services/proxy/src/forward.ts`. Piping streams rather than buffering is what keeps SSE and long responses working:

```ts
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
```

- [ ] **Step 7: Wire forwarding into the server**

In `services/proxy/src/index.ts`, add:

```ts
import { forward } from "./forward";
import { workspaceDomainOf } from "./registry";
```

and replace the Task-8 placeholder (`// Forwarding arrives in Task 9.` through `res.end(...)`) with:

```ts
  const workspaceDomain = (await workspaceDomainOf(app.workspace_id)) ?? "";
  await forward(req, res, app.run_url, visitor, workspaceDomain);
```

Add `workspaceDomainOf` to `services/proxy/src/registry.ts`:

```ts
export async function workspaceDomainOf(workspaceId: string): Promise<string | null> {
  const r = await db().query(`SELECT domain FROM workspaces WHERE id = $1`, [workspaceId]);
  return r.rows[0]?.domain ?? null;
}
```

- [ ] **Step 8: Verify against a local upstream**

Start a fake app that echoes what it received:

```bash
cat > /tmp/echo.mjs <<'EOF'
import { createServer } from "node:http";
createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(req.headers, null, 2));
}).listen(9999, () => console.log("echo on :9999"));
EOF
node /tmp/echo.mjs
```

Point the app row at it and call through the proxy with a spoof attempt:

```bash
psql -h 127.0.0.1 -p 5433 -U postgres -d supersonic_platform \
  -c "UPDATE apps SET run_url='http://localhost:9999' WHERE slug='hello';"

SKIP_ID_TOKEN=1 npm start   # in the proxy shell

curl -s -H "Host: hello.supersonic.cv" \
     -H "Cookie: authjs.session-token=<paste>; theme=dark" \
     -H "X-Supersonic-Email: ceo@acme.com" \
     http://localhost:8080/
```

Expected in the echoed JSON:
- `x-supersonic-email` is **your** address, not `ceo@acme.com`
- `cookie` is `theme=dark` — no `authjs.session-token`
- `x-supersonic-workspace` is your domain

Restore the real `run_url` afterwards.

- [ ] **Step 9: Commit**

```bash
git add services/proxy/src
git commit -m "feat(proxy): forward with identity injection, cookie stripping, and ID tokens"
```

---

### Task 10: Sharing controls

**Files:**
- Create: `apps/web/app/api/apps/[slug]/share/route.ts`
- Create: `apps/web/components/SharePanel.tsx`
- Modify: `apps/web/app/apps/[slug]/page.tsx`

**Interfaces:**
- Consumes: `lib/apps.ts` → `getAppBySlug`, `setVisibility`, `listGrants`, `addGrant`, `removeGrant`; `lib/session.ts` → `currentUserId`
- Produces: `GET /api/apps/:slug/share` → `{ visibility, grants }`; `POST` accepting `{ visibility }` or `{ addEmail }` or `{ removeEmail }`

- [ ] **Step 1: Write the API route**

Create `apps/web/app/api/apps/[slug]/share/route.ts`:

```ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getAppBySlug, setVisibility, listGrants, addGrant, removeGrant, type Visibility } from "@/lib/apps";
import { currentUserId } from "@/lib/session";

const VISIBILITIES: Visibility[] = ["private", "shared", "workspace"];

async function ownedApp(slug: string) {
  const uid = await currentUserId();
  if (!uid) return null;
  const app = await getAppBySlug(slug);
  if (!app || app.owner_id !== uid) return null;
  return app;
}

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const app = await ownedApp(slug);
  if (!app) return Response.json({ error: "forbidden" }, { status: 403 });
  return Response.json({ visibility: app.visibility, grants: await listGrants(slug) });
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const app = await ownedApp(slug);
  if (!app) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));

  if (body.visibility) {
    if (!VISIBILITIES.includes(body.visibility)) {
      return Response.json({ error: "invalid visibility" }, { status: 400 });
    }
    await setVisibility(slug, body.visibility);
  }
  if (body.addEmail) {
    const email = String(body.addEmail).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return Response.json({ error: "invalid email" }, { status: 400 });
    }
    await addGrant(slug, email);
  }
  if (body.removeEmail) await removeGrant(slug, String(body.removeEmail));

  const fresh = await getAppBySlug(slug);
  return Response.json({ visibility: fresh?.visibility, grants: await listGrants(slug) });
}
```

- [ ] **Step 2: Write the panel**

Create `apps/web/components/SharePanel.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

type Visibility = "private" | "shared" | "workspace";

const LABEL: Record<Visibility, string> = {
  private: "Only me",
  shared: "Specific people",
  workspace: "Everyone at my company",
};

export default function SharePanel({ slug }: { slug: string }) {
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [grants, setGrants] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await fetch(`/api/apps/${slug}/share`);
    if (!r.ok) return;
    const j = await r.json();
    setVisibility(j.visibility);
    setGrants(j.grants ?? []);
  }
  useEffect(() => { load(); }, [slug]);

  async function post(body: Record<string, string>) {
    setBusy(true);
    const r = await fetch(`/api/apps/${slug}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const j = await r.json();
      setVisibility(j.visibility);
      setGrants(j.grants ?? []);
    }
    setBusy(false);
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm uppercase tracking-wide opacity-60">Access</h2>

      <select
        value={visibility}
        disabled={busy}
        onChange={(e) => post({ visibility: e.target.value })}
        className="w-full rounded border border-white/15 bg-transparent p-2"
      >
        {(Object.keys(LABEL) as Visibility[]).map((v) => (
          <option key={v} value={v}>{LABEL[v]}</option>
        ))}
      </select>

      {visibility === "shared" && (
        <div className="space-y-2">
          <form
            onSubmit={(e) => { e.preventDefault(); if (email) { post({ addEmail: email }); setEmail(""); } }}
            className="flex gap-2"
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="flex-1 rounded border border-white/15 bg-transparent p-2"
            />
            <button disabled={busy} className="rounded border border-white/15 px-3">Add</button>
          </form>
          <ul className="space-y-1 text-sm">
            {grants.map((g) => (
              <li key={g} className="flex items-center justify-between">
                <span>{g}</span>
                <button onClick={() => post({ removeEmail: g })} disabled={busy} className="opacity-60 hover:opacity-100">remove</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Mount it on the app page**

In `apps/web/app/apps/[slug]/page.tsx`, add the import:

```tsx
import SharePanel from "@/components/SharePanel";
```

and render `<SharePanel slug={slug} />` alongside the existing panels.

- [ ] **Step 4: Verify the flow**

Run `npm run dev`, open an app's page:
- switch access to "Specific people", add `someone@example.com` — it appears in the list
- confirm in the database:

```bash
psql -h 127.0.0.1 -p 5433 -U postgres -d supersonic_platform \
  -c "SELECT a.slug, a.visibility, g.email FROM apps a LEFT JOIN app_grants g ON g.app_id = a.id;"
```

Expected: `visibility = shared` and the granted email present.

- [ ] **Step 5: Verify a non-owner is refused**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/apps/hello/share
```

Expected: `403` (no session cookie on the request).

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/apps apps/web/components/SharePanel.tsx apps/web/app/apps
git commit -m "feat(web): visibility and per-email sharing controls"
```

---

### Task 11: Ship the proxy

**Files:**
- Create: `services/proxy/Dockerfile`
- Create: `apps/web/db/backfill-apps.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above
- Produces: a running `supersonic-proxy` Cloud Run service behind a wildcard load balancer

- [ ] **Step 1: Write the Dockerfile**

Create `services/proxy/Dockerfile`:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npm", "run", "start"]
```

- [ ] **Step 2: Create the service account**

```bash
gcloud iam service-accounts create supersonic-proxy \
  --display-name="Supersonic auth proxy" --project supersonic-deploy-prod

gcloud projects add-iam-policy-binding supersonic-deploy-prod \
  --member="serviceAccount:supersonic-proxy@supersonic-deploy-prod.iam.gserviceaccount.com" \
  --role="roles/cloudsql.client"
```

Expected: both commands report success. This is the identity the deploy route binds as `run.invoker` on every app.

- [ ] **Step 3: Deploy the proxy**

```bash
cd services/proxy
gcloud run deploy supersonic-proxy \
  --source . --region us-central1 --project supersonic-deploy-prod \
  --service-account supersonic-proxy@supersonic-deploy-prod.iam.gserviceaccount.com \
  --allow-unauthenticated --min-instances=1 \
  --set-cloudsql-instances supersonic-deploy-prod:us-central1:supersonic-shared-pg \
  --set-env-vars "NODE_ENV=production,ROOT_DOMAIN=supersonic.cv,LOGIN_URL=https://app.supersonic.cv/login" \
  --set-secrets "AUTH_SECRET=supersonic-auth-secret:latest,PG_PASSWORD=supersonic-pg-password:latest"
```

The proxy itself **is** public — it is the front door. Only tenant apps are sealed.

Verify: `curl -s https://$(gcloud run services describe supersonic-proxy --region us-central1 --project supersonic-deploy-prod --format='value(status.url)' | sed 's|https://||')/_healthz`
Expected: `ok`

- [ ] **Step 4: Put the wildcard load balancer in front**

```bash
gcloud compute network-endpoint-groups create supersonic-proxy-neg \
  --region=us-central1 --network-endpoint-type=serverless \
  --cloud-run-service=supersonic-proxy --project supersonic-deploy-prod

gcloud compute backend-services create supersonic-proxy-backend \
  --global --load-balancing-scheme=EXTERNAL_MANAGED --project supersonic-deploy-prod

gcloud compute backend-services add-backend supersonic-proxy-backend \
  --global --network-endpoint-group=supersonic-proxy-neg \
  --network-endpoint-group-region=us-central1 --project supersonic-deploy-prod

# NOTE: classic managed certificates do NOT support wildcards — the command
# below fails with "Wildcard domains not supported". Use Certificate Manager,
# which does, at the cost of a one-time DNS authorization record:
#
#   gcloud certificate-manager dns-authorizations create supersonic-dns-auth \
#     --domain="supersonic.cv" --project supersonic-deploy-prod
#   # add the CNAME it prints to DNS (this does NOT reroute any traffic)
#   gcloud certificate-manager certificates create supersonic-wildcard \
#     --domains="supersonic.cv,*.supersonic.cv" \
#     --dns-authorizations=supersonic-dns-auth --project supersonic-deploy-prod
#   gcloud certificate-manager maps create supersonic-cert-map --project supersonic-deploy-prod
#   gcloud certificate-manager maps entries create wildcard --map=supersonic-cert-map \
#     --certificates=supersonic-wildcard --hostname="*.supersonic.cv" --project supersonic-deploy-prod
#   # then attach with: gcloud compute target-https-proxies create supersonic-https \
#   #   --url-map=supersonic-lb --certificate-map=supersonic-cert-map --global

gcloud compute url-maps create supersonic-lb \
  --default-service supersonic-proxy-backend --global --project supersonic-deploy-prod

gcloud compute target-https-proxies create supersonic-https \
  --url-map=supersonic-lb --ssl-certificates=supersonic-wildcard --global --project supersonic-deploy-prod

gcloud compute forwarding-rules create supersonic-fr \
  --global --target-https-proxy=supersonic-https --ports=443 --project supersonic-deploy-prod
```

Point the DNS `*.supersonic.cv` A record at the forwarding rule's IP:

```bash
gcloud compute forwarding-rules describe supersonic-fr --global --project supersonic-deploy-prod --format='value(IPAddress)'
```

Managed certificate provisioning takes 15–60 minutes — once, not per app. Check with:

```bash
gcloud compute ssl-certificates describe supersonic-wildcard --global --project supersonic-deploy-prod --format='value(managed.status)'
```

Expected eventually: `ACTIVE`

- [ ] **Step 5: Set the production cookie domain**

Redeploy the web app with `COOKIE_DOMAIN=.supersonic.cv` so the session cookie is visible to the proxy. Without this the proxy will bounce every visitor to sign-in in an infinite loop.

- [ ] **Step 6: Backfill and seal pre-existing apps**

Create `apps/web/db/backfill-apps.ts`:

```ts
import { execFileSync } from "node:child_process";
import { getPool } from "../lib/db";

const PROJECT = "supersonic-deploy-prod";
const REGION = "us-central1";

interface Svc { metadata?: { name?: string; labels?: Record<string, string> }; status?: { url?: string } }

async function main() {
  const raw = execFileSync("gcloud",
    ["run", "services", "list", "--region", REGION, "--project", PROJECT, "--format=json"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const services = JSON.parse(raw) as Svc[];
  const pool = getPool("supersonic_platform");

  for (const s of services) {
    const slug = s.metadata?.name;
    const owner = s.metadata?.labels?.["supersonic-owner"];
    const url = s.status?.url;
    if (!slug || !owner || slug === "supersonic-proxy") continue;

    const u = await pool.query(`SELECT workspace_id FROM users WHERE id = $1`, [owner]);
    const workspaceId = u.rows[0]?.workspace_id;
    if (!workspaceId) { console.log(`skip ${slug}: owner ${owner} has no workspace`); continue; }

    await pool.query(
      `INSERT INTO apps(slug, workspace_id, owner_id, run_url, visibility, status)
       VALUES($1,$2,$3,$4,'private','live') ON CONFLICT(slug) DO NOTHING`,
      [slug, workspaceId, owner, url ?? null]
    );
    console.log(`imported ${slug}`);
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Run it, then seal every imported service:

```bash
cd apps/web && node --import tsx db/backfill-apps.ts

for slug in $(psql -h 127.0.0.1 -p 5433 -U postgres -d supersonic_platform -tAc "SELECT slug FROM apps"); do
  gcloud run services remove-iam-policy-binding "$slug" \
    --member=allUsers --role=roles/run.invoker \
    --region us-central1 --project supersonic-deploy-prod --quiet
  gcloud run services add-iam-policy-binding "$slug" \
    --member="serviceAccount:supersonic-proxy@supersonic-deploy-prod.iam.gserviceaccount.com" \
    --role=roles/run.invoker \
    --region us-central1 --project supersonic-deploy-prod --quiet
done
```

- [ ] **Step 7: Dogfood — the acceptance test for this whole plan**

1. Deploy a tool through the UI. Confirm the log ends with `Private — open <slug>.supersonic.cv to share it`.
2. Open `https://<slug>.supersonic.cv` in a logged-out browser → redirected to Google sign-in.
3. Sign in as the owner → the tool loads.
4. Open the same URL as a colleague who has no access → the 403 page naming the owner.
5. In the cockpit set access to "Specific people" and add that colleague's email.
6. Colleague reloads → the tool loads.
7. Confirm the tool sees them: check its logs, or deploy `examples/hello` modified to echo `req.headers['x-supersonic-email']`.

All seven must pass before this plan is considered done.

- [ ] **Step 8: Update the README**

In `README.md`, replace the `services/control-plane` and `apps/web` rows of the layout table and add:

```markdown
| `services/proxy` | Auth proxy — every app sits behind it; Google sign-in, access checks, identity headers | — |
```

Change the Status section to note that apps deploy private by default and are reachable only via `<slug>.supersonic.cv`.

- [ ] **Step 9: Commit**

```bash
git add services/proxy/Dockerfile apps/web/db/backfill-apps.ts README.md
git commit -m "feat(proxy): ship behind a wildcard load balancer; backfill and seal existing apps"
```

---

## Self-Review Notes

**Spec coverage:** wildcard LB + proxy (T6, T11) · session cookie across subdomains (T3) · cookie stripped inbound (T9) · `Set-Cookie` re-scoped (T9) · registry from Postgres with cache (T6) · no buffering (T9, piping) · schema incl. personal workspaces (T1, T2) · grants by email (T1, T4) · access check + tests (T8) · seal + invoker binding (T5, T11) · drop `createDomainMapping` (T5) · insert-before-deploy (T5) · `probeApp` with ID token (T5) · identity headers + inbound strip (T9) · error pages (T6) · `min-instances=1` (T11) · three security tests (T8, T9) · manual E2E (T11) · close existing apps (T11).

**Deferred deliberately:** signed JWTs instead of headers, WebSocket `upgrade` handling (HTTP piping covers SSE; add when a tool needs sockets), workspace admin UI, roles, deploy-agent sandboxing, per-app Postgres roles.

**Known limitation introduced by Task 9:** the proxy overwrites `Authorization` with the Cloud Run ID token, so a client-supplied `Authorization` header never reaches the app. Browser traffic is unaffected — that is the entire dogfood path — but a tool exposing its own token-authenticated API would not see caller credentials. When that comes up, forward the original value as `X-Supersonic-Forwarded-Authorization` and have the tool read it there.
