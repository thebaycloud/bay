# Sharing Layer — Design

**Date:** 2026-07-25
**Status:** Approved, ready for implementation planning
**Scope:** Dogfood slice — one real tool, deployed private, shared with one colleague, end to end.

---

## Why

Supersonic today deploys **public** apps for **individual** builders. Every app ships with
`--allow-unauthenticated`, tenancy is a single Cloud Run label (`supersonic-owner`), and there is
no way to share an app with a colleague.

The product we're building is **team-internal tools**: purpose-built software with one or a handful
of users, private by default, shared with colleagues the way a Google Doc is. The deploy pipeline
already works and becomes plumbing; the sharing layer becomes the product.

Google Doc sharing feels effortless because identity is already solved — everyone is signed into a
Google account. We take the same shortcut: **Google sign-in, workspace derived from email domain.**

### The trust boundary

Executing an untrusted repo in the control plane is a real vulnerability (see Out of Scope), but it
is triggered by **deploying**, not by **viewing**. Keeping deploy invite-only while opening viewing
to anyone at a colleague's company delivers this product without sandboxing first. Sandboxing
becomes blocking on the day self-serve deploy signup opens — not before.

## Goals

- An app is private to its deployer by default.
- Its owner can open it to the whole workspace, or grant access to named colleagues by email.
- A granted colleague opens `<slug>.supersonic.cv`, signs in with Google, and is in — no invite code,
  no Supersonic-specific signup step.
- The app learns who the visitor is without implementing any authentication itself.
- An app is unreachable except through the proxy.

## Non-goals (this slice)

- Workspace administration UI, member lists, app settings screens.
- Roles (viewer/editor/admin). Access is binary: you can open the app or you cannot.
- Public-on-the-internet apps. Everything is behind auth; a public toggle can come later.
- Non-Google identity (Microsoft, SSO/OIDC, magic links).
- Sandboxing the deploy agent.

---

## Architecture

One wildcard front door replaces per-app domain mappings.

```
Boris → sprint.supersonic.cv
          │
   [ Global External LB — wildcard cert *.supersonic.cv, serverless NEG ]
          │
          ▼
   [ supersonic-proxy — Cloud Run, min-instances=1 ]
          │  1. slug  = Host.split('.')[0]
          │  2. session cookie on .supersonic.cv? → else redirect to Google sign-in
          │  3. access check (owner | workspace | grant)
          │  4. strip inbound X-Supersonic-* and the session cookie
          │  5. inject real identity headers
          │  6. mint ID token, audience = app's run.app URL
          ▼
   [ sprint-xxxx.run.app — --no-allow-unauthenticated, invoker = proxy SA only ]
```

New service lives at `services/proxy`.

### Consequences

**Per-app domain mappings are deleted.** One wildcard certificate on the load balancer covers every
slug, so `createDomainMapping()` in `app/api/deploy/route.ts` goes away along with its ~15-minute SSL
provisioning wait. Apps are reachable at their subdomain the moment the deploy finishes.

**Single sign-on across tools comes free.** The session cookie is set on the parent domain
`.supersonic.cv`, so signing in at one tool authenticates the visitor at all of them.

**The shared cookie is the primary hazard.** Because every tool sits under `.supersonic.cv`, the
session cookie would otherwise be sent to each of them. The proxy therefore:

- **strips the Supersonic session cookie before forwarding** to the tenant app — otherwise a hosted
  tool could read a visitor's session and impersonate them against every other app in the workspace;
- **re-scopes `Set-Cookie` headers coming back from apps to host-only**, so a tool cannot set a
  `.supersonic.cv`-scoped cookie that leaks into, or collides with, other tools.

**Routing data comes from Postgres, not the Cloud Run API.** The proxy resolves `slug → run_url` from
the control-plane database, cached in memory, refreshed on miss. A Cloud Run API call per request
would add latency to every page load.

**The proxy must not buffer responses.** Deploy logs stream over SSE and hosted tools may use
WebSockets; a buffering proxy breaks both, and the failure presents as an unexplained hang.

---

## Data model

Apps currently exist only as Cloud Run services filtered by the `supersonic-owner` label. The proxy
needs fast, authoritative lookups, so apps move into Postgres (database `supersonic_platform`,
alongside the existing `users` table).

```
workspaces
  id           uuid pk
  domain       text unique null   -- 'acme.com'; NULL for personal workspaces
  kind         text               -- 'company' | 'personal'
  name         text
  created_at   timestamptz

users                             -- existing table
  + workspace_id  uuid references workspaces(id)

apps
  id           uuid pk
  slug         text unique        -- Cloud Run service name, also the subdomain
  workspace_id uuid references workspaces(id)
  owner_id     uuid references users(id)
  run_url      text               -- resolved target for the proxy
  visibility   text               -- 'private' | 'shared' | 'workspace'
  status       text               -- 'deploying' | 'live' | 'failed'
  created_at   timestamptz

app_grants
  app_id       uuid references apps(id) on delete cascade
  email        text
  created_at   timestamptz
  primary key (app_id, email)
```

**Grants key on email, not `user_id`.** You invite a colleague who has never signed in and therefore
has no user row yet. Email makes the invitation effective immediately; it binds to a user on their
first sign-in.

**Public email domains do not form shared workspaces.** Mapping domain → workspace without a filter
would put every `gmail.com` address on earth into one workspace with access to each other's tools.
Addresses on a maintained public-provider list (gmail.com, yandex.ru, mail.ru, outlook.com, icloud.com,
proton.me, …) get a `kind = 'personal'` workspace containing only themselves, with `domain = NULL` —
so the unique constraint on `domain` continues to hold across many personal workspaces. Only
`kind = 'company'` workspaces are joinable by domain match.

### Access check

Pure function, no I/O, evaluated on every proxied request:

```
isOwner(user, app)                              → allow
app.visibility = 'workspace'
  && user.workspace_id = app.workspace_id       → allow
app.visibility = 'shared'
  && grant exists for user.email                → allow
otherwise                                       → deny
```

`private` grants access to the owner only. Workspace comparison is by `workspace_id`, never by
re-deriving the domain from the email at request time.

---

## Deploy path changes

In `app/api/deploy/route.ts`:

1. **Seal the app.** `--allow-unauthenticated` → `--no-allow-unauthenticated`, and grant
   `roles/run.invoker` on the service to the proxy's service account only. This closes the
   `*.run.app` bypass, through which any deployed app is currently readable by anyone who guesses
   the URL.
2. **Delete `createDomainMapping()`** and its call site. The wildcard certificate already covers the
   new slug.
3. **Record the app.** Insert the `apps` row with `status = 'deploying'` **before** invoking
   `gcloud run deploy`, then update `run_url` and `status` on completion. Writing after the deploy
   risks a live-but-unroutable app if the insert fails. `visibility` defaults to `'private'`.
4. **Fix `probeApp()`.** It currently issues a plain `fetch(url)` to catch apps that start but reject
   real requests. Against a sealed app that fetch receives a 403 from Google — not a 5xx, and with no
   recognizable phrase in the body — so the function returns `{ ok: true }` for every app and the
   check silently stops working. `probeApp` must send an ID token, exactly as the proxy does.
5. **Close existing apps.** Every app deployed to date is public. There are no external users yet, so
   all existing services are switched to `--no-allow-unauthenticated` and backfilled into `apps` with
   `visibility = 'private'`, owned by their `supersonic-owner` label value.

`lib/gcloud.ts:listServices()` keeps working as-is for the cockpit; it is not on the request path.

---

## Identity headers

The proxy injects four headers into every forwarded request:

```
X-Supersonic-Email       boris@acme.com
X-Supersonic-Name        Boris
X-Supersonic-User-Id     usr_...
X-Supersonic-Workspace   acme.com
```

This is the payoff for the tool author: the app implements **no authentication at all** — no login,
no password storage, no session handling — and still gets per-user behavior ("my tasks", "my
expenses", "who marked this done"). Someone building a small tool with an agent never hits the auth
wall that normally stops them.

**Inbound `X-Supersonic-*` headers are stripped before injection.** Without this, a visitor sends
`X-Supersonic-Email: ceo@acme.com` and becomes the CEO. Anything arriving from the client with that
prefix is discarded unconditionally, then the real values are set.

Signed JWTs instead of plain headers are deliberately deferred: an app that cannot be reached except
through the proxy has nothing to verify. Add them if a use case demands it.

---

## Error handling

| Situation | Behavior |
|---|---|
| Signed in, no access | Branded 403 naming the app owner to request access from |
| Slug not in `apps` | 404 — tool does not exist |
| App returns 5xx / unreachable | 502 with a link to the owner's cockpit |
| Session expired mid-use | Re-auth, then return to the originally requested URL |
| Deploy succeeded, DB write failed | Prevented by inserting before deploy (see Deploy path) |
| Proxy down | All hosted tools are down — `min-instances=1`, health check, alert |

The proxy is a single point of failure for every hosted app. `min-instances=1` also removes cold
start from the request path.

---

## Testing

The repository currently has no test infrastructure; this work introduces a minimal harness
(`node:test`). Three security-critical behaviors must be covered:

1. **Access check** — pure function, table-driven: owner on private; workspace member on `workspace`;
   non-member on `workspace`; granted email on `shared`; ungranted email on `shared`; public-provider
   address against another user's personal workspace.
2. **Header stripping** — a request carrying `X-Supersonic-Email` reaches the app with the
   authenticated identity, never the supplied one.
3. **Cookie stripping** — the Supersonic session cookie never reaches the tenant app; an app's
   `Set-Cookie` with `Domain=.supersonic.cv` is rewritten host-only.

Plus one manual end-to-end pass: deploy a tool, open it signed out (redirect to Google), open it as a
user without access (403), grant that user, reload (200 with identity headers present).

---

## Out of scope

**Deploy-agent sandboxing.** `lib/agent.ts` runs `run_command` with `shell: true` against an
allowlist that only checks the command prefix, so `npm run build && curl … | sh` passes. Independently,
`npm install` on a cloned repo executes arbitrary `postinstall` scripts. Both run inside the control
plane, which holds the deployer service account. This is a full compromise path and must be closed
**before self-serve deploy signup opens**. It does not block this slice, because deploying stays
invite-only.

**Shared Postgres superuser credentials.** `provisionPostgres()` hands every deployed app the shared
instance's `postgres` superuser URL, so any hosted app can read or drop every other tenant's database.
Unrelated to sharing, but it is the most severe isolation defect in the codebase and should be
scheduled directly after this work.

**Secrets as plaintext env vars.** User secrets and `DATABASE_URL` are passed via `--set-env-vars`,
readable through `gcloud run services describe`, contradicting `ARCHITECTURE.md`'s Secret Manager
claim.
