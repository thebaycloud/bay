# Verified Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only a Google-verified address that appears on an allowlist can sign in, closing the hole where registering as `boris@acme.com` joins Acme's workspace.

**Architecture:** One gate in the existing `signIn` callback, in front of every provider, checking a pure `isAllowed(email, entries)` against an `allowed_signins` table of addresses and domains. Because the gate covers the password provider too, deploy 1 closes the hole while passwords still work; deploy 2 deletes them as cleanup.

**Tech Stack:** Node 22, TypeScript, Next.js 14 (App Router), Auth.js v5 (`next-auth@5.0.0-beta.32`, `@auth/core@0.41.3`), `pg`, `node:test` + `tsx`.

**Spec:** `docs/superpowers/specs/2026-07-27-verified-identity-design.md`

## Global Constraints

- Node 22. Test scripts pass a **quoted glob** (`--test 'test/**/*.test.ts'`), never a bare directory.
- Database `supersonic_platform`, reached locally through `cloud-sql-proxy` on `127.0.0.1:5433`. This is the shared **production** database — additive, idempotent SQL only; never DROP, TRUNCATE, or DELETE existing rows.
- `psql` is NOT installed. Use Node with `pg` for database checks.
- Exactly one of `email` / `domain` is set on an `allowed_signins` row.
- Matching is case-insensitive, and a domain entry matches only a **whole** domain — `evil-luwo.ai` must never match `luwo.ai`.
- The gate **fails closed**: if the allowlist cannot be read, sign-in is denied.
- Deploy 2 must not run until an operator has signed in with Google in production.
- Never print the contents of `.env.local` or `.pg.json`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/db/002_allowlist.sql` | Table + seed, idempotent |
| `apps/web/db/migrate.ts` (modify) | Apply every `NNN_*.sql` in order, not just `001` |
| `apps/web/lib/allowlist.ts` | **Pure** `isAllowed` + the one query that loads entries |
| `apps/web/test/allowlist.test.ts` | Tests for `isAllowed` |
| `apps/web/auth.ts` (modify) | The gate, in the existing `signIn` callback |
| `apps/web/app/login/page.tsx` (modify) | Denial message + live Google button |
| `docs/CUTOVER.md` (modify) | The three browser-only operator steps |

---

### Task 1: Allowlist table and seed

**Files:**
- Create: `apps/web/db/002_allowlist.sql`
- Modify: `apps/web/db/migrate.ts` (whole file)

**Interfaces:**
- Produces: table `allowed_signins(id, email, domain, note, added_at)`, seeded from the existing `users` table plus two domains.

- [ ] **Step 1: Write the migration**

Create `apps/web/db/002_allowlist.sql`. The seed reads from `users` rather than hardcoding addresses, so it is exact by construction and cannot drift:

```sql
CREATE TABLE IF NOT EXISTS allowed_signins (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email    text UNIQUE,
  domain   text UNIQUE,
  note     text,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allowed_signins_one_of CHECK (num_nonnulls(email, domain) = 1)
);

-- Both domains are confirmed Google Workspace (MX -> Google), so everyone on
-- them can sign in with a verified address.
INSERT INTO allowed_signins(domain, note) VALUES
  ('luwo.ai',       'seed: Google Workspace domain'),
  ('supersonic.cv', 'seed: Google Workspace domain')
ON CONFLICT (domain) DO NOTHING;

-- Every user who exists at migration time keeps access, whatever their domain.
INSERT INTO allowed_signins(email, note)
SELECT lower(email), 'seed: existing user at migration time' FROM users
ON CONFLICT (email) DO NOTHING;
```

- [ ] **Step 2: Make the runner apply every migration**

Replace the whole of `apps/web/db/migrate.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "../lib/db";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  // Every migration is idempotent, so applying all of them every time is safe
  // and removes the need for a tracking table.
  const files = readdirSync(here)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const pool = getPool("supersonic_platform");
  for (const file of files) {
    await pool.query(readFileSync(join(here, file), "utf8"));
    console.log(`migration ${file} applied`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Apply and verify**

Run from `apps/web`:

```bash
npm run db:migrate
```

Expected: `migration 001_sharing.sql applied` then `migration 002_allowlist.sql applied`.

Then confirm every existing user is covered — this is the check that prevents a lockout:

```bash
node -e '
const pg = require("pg"); const cfg = require("./.pg.json");
const p = new pg.Pool({host:"127.0.0.1",port:5433,user:cfg.user,password:cfg.password,database:"supersonic_platform"});
(async()=>{
  const a = await p.query("SELECT email, domain, note FROM allowed_signins ORDER BY domain NULLS LAST, email");
  console.log("entries:", a.rows.length);
  a.rows.forEach(r=>console.log("  " + (r.domain ? "domain " + r.domain : "email  " + r.email)));
  const gap = await p.query(`
    SELECT u.email FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM allowed_signins a WHERE a.email = lower(u.email))
      AND NOT EXISTS (SELECT 1 FROM allowed_signins a WHERE a.domain = split_part(lower(u.email),$1,2))`, ["@"]);
  console.log(gap.rows.length ? "NOT COVERED: " + gap.rows.map(r=>r.email).join(", ") : "every existing user is covered");
  await p.end();
})().catch(e=>{console.error("ERR:",e.message);process.exit(1);});
'
```

Expected: `every existing user is covered`, and 11 entries (9 emails + 2 domains).

- [ ] **Step 4: Verify idempotency**

Run `npm run db:migrate` a second time. Expected: the same two lines, no error, and re-running the verification above still reports 11 entries — not 22.

- [ ] **Step 5: Commit**

```bash
git add apps/web/db
git commit -m "feat(db): allowlist of addresses and domains permitted to sign in"
```

---

### Task 2: The allow decision

**Files:**
- Create: `apps/web/lib/allowlist.ts`
- Create: `apps/web/test/allowlist.test.ts`

**Interfaces:**
- Consumes: `lib/db.ts` → `getPool`; `lib/workspace.ts` → `domainOf(email: string): string`
- Produces:
  - `interface AllowEntry { email: string | null; domain: string | null }`
  - `isAllowed(email: string, entries: AllowEntry[]): boolean` — **pure**
  - `listAllowEntries(): Promise<AllowEntry[]>`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/allowlist.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed, type AllowEntry } from "../lib/allowlist";

const entries: AllowEntry[] = [
  { email: null, domain: "luwo.ai" },
  { email: null, domain: "supersonic.cv" },
  { email: "arsenfounder@gmail.com", domain: null },
];

test("an individually listed address is allowed", () => {
  assert.equal(isAllowed("arsenfounder@gmail.com", entries), true);
});

test("matching is case-insensitive and tolerates whitespace", () => {
  assert.equal(isAllowed("  ArsenFounder@Gmail.COM  ", entries), true);
  assert.equal(isAllowed("BORIS@LUWO.AI", entries), true);
});

test("any address on a listed domain is allowed", () => {
  assert.equal(isAllowed("anyone@luwo.ai", entries), true);
  assert.equal(isAllowed("someone@supersonic.cv", entries), true);
});

test("an address on an unlisted domain is denied", () => {
  assert.equal(isAllowed("boris@acme.com", entries), false);
});

test("an unlisted gmail address is denied even though another gmail is listed", () => {
  assert.equal(isAllowed("stranger@gmail.com", entries), false);
});

test("a lookalike domain does not match", () => {
  // The bug an endsWith implementation would have.
  assert.equal(isAllowed("boris@evil-luwo.ai", entries), false);
  assert.equal(isAllowed("boris@luwo.ai.evil.com", entries), false);
});

test("malformed addresses are denied", () => {
  for (const bad of ["", "   ", "no-at-sign", "@luwo.ai", "boris@"]) {
    assert.equal(isAllowed(bad, entries), false, `${JSON.stringify(bad)} should be denied`);
  }
});

test("an empty allowlist denies everyone", () => {
  assert.equal(isAllowed("arsenfounder@gmail.com", []), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npm test`
Expected: FAIL — `Cannot find module '../lib/allowlist'`

- [ ] **Step 3: Write the implementation**

Create `apps/web/lib/allowlist.ts`:

```ts
import { getPool } from "./db";
import { domainOf } from "./workspace";

const DB = "supersonic_platform";

export interface AllowEntry {
  email: string | null;
  domain: string | null;
}

/**
 * May this address sign in at all?
 *
 * Pure: the caller supplies the entries. Deny is the default, and a domain
 * entry matches only a whole domain — comparing with endsWith would let
 * evil-luwo.ai through.
 */
export function isAllowed(email: string, entries: AllowEntry[]): boolean {
  const addr = email.trim().toLowerCase();
  const domain = domainOf(addr);
  const local = addr.split("@")[0] ?? "";
  if (!addr || !domain || !local) return false;

  for (const e of entries) {
    if (e.email && e.email.trim().toLowerCase() === addr) return true;
    if (e.domain && e.domain.trim().toLowerCase() === domain) return true;
  }
  return false;
}

export async function listAllowEntries(): Promise<AllowEntry[]> {
  const r = await getPool(DB).query(`SELECT email, domain FROM allowed_signins`);
  return r.rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npm test`
Expected: PASS — 8 allowlist tests plus the 4 pre-existing workspace tests, 12 total.

- [ ] **Step 5: Verify the real seeded list against the real users**

This proves the seed and the function agree — the thing that would cause a production lockout:

```bash
cd apps/web && node --import tsx -e '
import { listAllowEntries, isAllowed } from "./lib/allowlist";
import { getPool } from "./lib/db";
const pool = getPool("supersonic_platform");
const entries = await listAllowEntries();
const users = (await pool.query("SELECT email FROM users ORDER BY email")).rows;
let bad = 0;
for (const u of users) {
  const ok = isAllowed(u.email, entries);
  if (!ok) bad++;
  console.log((ok ? "  allow " : "  DENY  ") + u.email);
}
console.log(bad === 0 ? "all existing users pass the gate" : bad + " EXISTING USERS WOULD BE LOCKED OUT");
console.log("stranger@acme.com:", isAllowed("stranger@acme.com", entries) ? "ALLOWED — BUG" : "denied");
await pool.end();
'
```

Expected: every user prefixed `allow`, then `all existing users pass the gate`, then `denied`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/allowlist.ts apps/web/test/allowlist.test.ts
git commit -m "feat(auth): pure allowlist decision with exhaustive tests"
```

---

### Task 3: The gate

**Files:**
- Modify: `apps/web/auth.ts` — the `signIn` callback
- Modify: `apps/web/app/login/page.tsx` — render the denial

**Interfaces:**
- Consumes: `lib/allowlist.ts` → `isAllowed`, `listAllowEntries`
- Produces: sign-in denied for any address not on the list, redirected to `/login?error=not_invited&email=<address>`

- [ ] **Step 1: Add the gate**

In `apps/web/auth.ts`, add the import:

```ts
import { isAllowed, listAllowEntries } from "@/lib/allowlist";
```

and replace the first two lines of the `signIn` callback body — currently:

```ts
      if (!user.email) return false;
      if (account && account.provider !== "credentials") {
```

with:

```ts
      if (!user.email) return false;

      // The gate. It sits in front of every provider, so it protects the
      // password path too until that path is removed.
      let entries;
      try {
        entries = await listAllowEntries();
      } catch (e) {
        // Fail closed. A database blip must not become an authentication bypass.
        console.error("allowlist lookup failed", e);
        return false;
      }
      if (!isAllowed(user.email, entries)) {
        return `/login?error=not_invited&email=${encodeURIComponent(user.email.toLowerCase())}`;
      }

      if (account && account.provider !== "credentials") {
```

Returning a string from the `signIn` callback makes Auth.js redirect there instead of signing the visitor in.

- [ ] **Step 2: Render the denial**

In `apps/web/app/login/page.tsx`, add to the imports:

```tsx
import { useSearchParams } from "next/navigation";
```

Inside the component, after `const router = useRouter();`, add:

```tsx
  const params = useSearchParams();
  const notInvited = params.get("error") === "not_invited";
  const rejected = params.get("email") ?? "";
```

and replace the existing error line:

```tsx
          {err && <div className="autherr">✕ {err}</div>}
```

with:

```tsx
          {err && <div className="autherr">✕ {err}</div>}
          {notInvited && (
            <div className="autherr">
              ✕ {rejected || "That address"} isn&apos;t on the invite list. Ask whoever invited you to add it.
            </div>
          )}
```

`useSearchParams` requires the page to be inside a Suspense boundary in some Next 14 setups. If `npm run build` reports that, wrap the returned JSX in `<Suspense fallback={null}>…</Suspense>` and import `Suspense` from `react`.

- [ ] **Step 3: Verify it compiles and builds**

Run from `apps/web`:

```bash
npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled successfully|Failed to compile"
```

Expected: no type errors, then `✓ Compiled successfully`.

- [ ] **Step 4: Prove the gate end to end through the password provider**

This is the real test: the password provider is still alive, so it exercises the same `signIn` callback the Google button will use.

Start the dev server (`npm run dev`), then in another shell run this. It creates a throwaway allowed user and a throwaway denied user, tries both, and deletes them:

```bash
cd apps/web && node --import tsx -e '
import bcrypt from "bcryptjs";
import { getPool } from "./lib/db";
const pool = getPool("supersonic_platform");
const hash = await bcrypt.hash("probe-password", 10);
const allowed = "gate-allowed@luwo.ai";      // domain is seeded
const denied  = "gate-denied@acme.example";  // domain is not
for (const e of [allowed, denied]) {
  await pool.query("INSERT INTO users(email,name,password_hash,provider) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash", [e, "probe", hash, "credentials"]);
}
async function tryLogin(email) {
  const csrfRes = await fetch("http://localhost:3000/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const cookie = csrfRes.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const r = await fetch("http://localhost:3000/api/auth/callback/credentials", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({ email, password: "probe-password", csrfToken }).toString(),
  });
  return r.headers.get("location") ?? String(r.status);
}
console.log("  allowed ->", await tryLogin(allowed));
console.log("  denied  ->", await tryLogin(denied));
await pool.query("DELETE FROM users WHERE email = ANY($1)", [[allowed, denied]]);
await pool.query("DELETE FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.workspace_id=w.id) AND NOT EXISTS (SELECT 1 FROM apps a WHERE a.workspace_id=w.id) AND w.kind=$1", ["company"]);
const end = (await pool.query("SELECT (SELECT count(*)::int FROM users) u")).rows[0];
console.log("  cleanup — users:", end.u);
await pool.end();
'
```

Expected: the allowed address redirects somewhere that is **not** `error=not_invited`; the denied address redirects to a URL containing `not_invited`; cleanup reports 9 users.

Stop the dev server afterwards.

- [ ] **Step 5: Commit**

```bash
git add apps/web/auth.ts apps/web/app/login/page.tsx
git commit -m "feat(auth): only allowlisted addresses may sign in

The gate sits in the signIn callback, in front of every provider, so it
protects the password path too until that path is removed. It fails closed:
if the allowlist cannot be read, nobody gets in."
```

---

### Task 4: Turn on Google

**Files:**
- Modify: `apps/web/app/login/page.tsx` — the disabled button
- Modify: `docs/CUTOVER.md` — the operator's browser steps

**Interfaces:**
- Consumes: the gate from Task 3
- Produces: a working "Continue with Google" button, inert until the credentials exist

`auth.ts` already registers the Google provider when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are present, so no change is needed there.

- [ ] **Step 1: Make the button real**

In `apps/web/app/login/page.tsx`, replace:

```tsx
          <button className="btn" disabled>Continue with Google <span className="soon">soon</span></button>
```

with:

```tsx
          <button className="btn" type="button" onClick={() => signIn("google", { callbackUrl: "/" })}>
            Continue with Google
          </button>
```

Leave the GitHub button disabled — it is not part of this work.

- [ ] **Step 2: Verify the build**

Run from `apps/web`:

```bash
npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled successfully|Failed to compile"
```

Expected: `✓ Compiled successfully`.

Note the button will produce a Google error page until Step 3 is done by an operator; that is expected and is not a code defect.

- [ ] **Step 3: Write the operator handover**

Append to `docs/CUTOVER.md`:

```markdown
## Turning on Google sign-in

Three steps that need a browser and cannot be scripted.

1. **Create the OAuth client.** Cloud Console → APIs & Services → Credentials →
   Create credentials → OAuth client ID → **Web application**, in project
   `supersonic-deploy-prod`. Configure the consent screen first if prompted;
   `External` is required if any operator signs in with a personal gmail address.

2. **Add the redirect URI**, exactly, scheme included:
   `https://<control-plane-host>/api/auth/callback/google`
   The host must match `AUTH_URL` on the deployed control plane. A mismatch is
   the single most common cause of `redirect_uri_mismatch`.

3. **Store and wire the credentials:**

   ```bash
   printf %s "<client-id>"     | gcloud secrets create supersonic-google-client-id     --data-file=- --project supersonic-deploy-prod
   printf %s "<client-secret>" | gcloud secrets create supersonic-google-client-secret --data-file=- --project supersonic-deploy-prod

   SA=$(gcloud run services describe supersonic-control-plane --region us-central1 \
        --project supersonic-deploy-prod --format='value(spec.template.spec.serviceAccountName)')
   for s in supersonic-google-client-id supersonic-google-client-secret; do
     gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:${SA}" \
       --role=roles/secretmanager.secretAccessor --project supersonic-deploy-prod
   done

   gcloud run services update supersonic-control-plane --region us-central1 \
     --project supersonic-deploy-prod \
     --update-secrets "GOOGLE_CLIENT_ID=supersonic-google-client-id:latest,GOOGLE_CLIENT_SECRET=supersonic-google-client-secret:latest"
   ```

Until step 3 lands, `auth.ts` does not register the provider and the button leads
nowhere. The code is inert, not broken.

**Then verify before deploy 2:** sign in with Google as an operator and confirm you
land on your existing account with your existing apps — not a duplicate. Then sign in
with a Google account that is not on the allowlist and confirm the readable
"isn't on the invite list" message.
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/login/page.tsx docs/CUTOVER.md
git commit -m "feat(auth): enable the Google sign-in button

Inert until an operator creates the OAuth client and wires the secrets —
auth.ts only registers the provider when both are present."
```

---

### Task 5: Remove passwords — DO NOT RUN YET

**Precondition, not a suggestion:** an operator has signed in with Google **in production** and confirmed they landed on their existing account. Running this task before that leaves a product nobody can sign in to, fixable only by a deploy that cannot be verified.

**Files:**
- Modify: `apps/web/auth.ts` — drop the Credentials provider
- Delete: `apps/web/app/api/signup/route.ts`
- Delete: `apps/web/app/signup/page.tsx`
- Modify: `apps/web/app/login/page.tsx` — drop the password form
- Modify: `docs/CUTOVER.md`

- [ ] **Step 1: Remove the provider**

In `apps/web/auth.ts`, delete the `Credentials({...})` entry from the `providers` array, leaving:

```ts
const providers: any[] = [];
```

and delete the now-unused imports `Credentials` and `bcrypt`. Also simplify the gate's provider test, since every remaining provider is an OAuth one — replace:

```ts
      if (account && account.provider !== "credentials") {
```

with:

```ts
      if (account) {
```

- [ ] **Step 2: Delete the signup surface**

```bash
git rm apps/web/app/api/signup/route.ts apps/web/app/signup/page.tsx
```

- [ ] **Step 3: Strip the password form from the login page**

In `apps/web/app/login/page.tsx`, delete the `<form>…</form>` block, the `email`/`password`/`err`/`busy` state, the `submit` function, the now-unused `signIn("credentials", …)` call, the `useRouter` import and usage, and the "No account? Sign up" line. Keep the brand, the heading, the Google button, and the `not_invited` message.

- [ ] **Step 4: Retire the invite code**

```bash
gcloud run services update supersonic-control-plane --region us-central1 \
  --project supersonic-deploy-prod --remove-env-vars SIGNUP_INVITE_CODE
```

`users.password_hash` is deliberately left in place — dropping a column is irreversible and buys nothing once the code stops reading it.

- [ ] **Step 5: Verify**

```bash
cd apps/web && npx tsc --noEmit && npm test 2>&1 | grep -E "^# (pass|fail)" && npm run build 2>&1 | grep -E "Compiled successfully|Failed to compile"
```

Expected: no type errors, 12 passing tests, `✓ Compiled successfully`. Confirm no reference to the credentials provider survives:

```bash
grep -rn "credentials" apps/web/auth.ts apps/web/app/login/page.tsx || echo "no references remain"
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(auth): remove password sign-in

Identity is now Google-verified only. users.password_hash is left in place —
dropping a column is irreversible and buys nothing once nothing reads it."
```

---

## Self-Review Notes

**Spec coverage:** allowlist table + seed (T1) · pure `isAllowed` with whole-domain matching (T2) · gate in `signIn` in front of every provider (T3) · fail-closed on database error (T3 Step 1) · readable denial page (T3 Step 2) · Google provider enabled (T4) · operator's browser steps (T4 Step 3) · two-deploy sequencing (T5 precondition) · `password_hash` kept (T5 Step 4) · all six spec test cases plus two extra (T2 Step 1).

**Verified end to end without Google:** the gate is exercised through the credentials provider in T3 Step 4 — the same `signIn` callback the Google button will use. What cannot be tested without an OAuth client is Google's handshake itself, which is why T5 is gated on a human confirming it.

**Deliberately deferred:** a UI for managing the allowlist (SQL for now), invitations with notification, roles, and the two open findings from the sharing-layer review (conditional `apps` row write vs unconditional sealing; chunked session cookies bypassing the proxy's cookie stripping).
