# Handoff — connecting GitHub repositories

Written 20 Aug 2026, at the end of a session that designed this and could not
start it. Repo: `thebaycloud/bay`, everything below is on `main`.

---

## Read this first: what is checked and what is not

The handoff this session inherited contained three false claims, and each cost
hours because it read as fact. So everything here is marked.

**CHECKED** means I ran it and saw the output in this session. **ASSUMED** means
I read it in code and did not run it. Treat ASSUMED as a hypothesis.

---

## The blocker, and it is yours

Nothing can be built or tested until a **GitHub App exists**. Only a human with
admin on the `thebaycloud` org can create it.

In GitHub → org settings → Developer settings → GitHub Apps → New:

- **Repository permissions:** `Contents: Read-only`, `Metadata: Read-only`
- **Subscribe to events:** `Push` (only needed for phase two; harmless now)
- **Webhook URL:** `https://app.supersonic.cv/api/github/webhook` — the route
  does not exist yet, so set the webhook to *inactive* until phase two
- **Where can this be installed:** any account
- Generate a **private key** and keep the `.pem`

Then put the three values in Secret Manager, alongside the platform's other
secrets:

    gh-app-id            the numeric App ID
    gh-app-private-key   the .pem contents
    gh-webhook-secret    a random string you also paste into the App's settings

Until that exists there is nothing to authenticate with, so the first phase
cannot even be exercised locally.

---

## The decision, and why it is not OAuth

**Use a GitHub App.** CHECKED against GitHub's docs and against how Render and
Vercel actually do it — both use a GitHub App, and both keep it SEPARATE from
"log in with GitHub".

That separation is the thing to internalise: **we already have GitHub login and
it works** (CHECKED: `POST /api/auth/signin/github` with a CSRF token redirects
to `github.com/login/oauth/authorize` with client `Ov23ligIqOe5hHq0a2U0`, scope
`read:user user:email`). That scope cannot read code. Login and code access are
two integrations, and only the first exists.

Why not the alternatives:

- **OAuth with `repo` scope** — the token grants access to EVERY repository the
  user can see, with no way to narrow it, and it does not expire until revoked.
  Asking for someone's whole GitHub to deploy one folder is the wrong ask.
  There are also no built-in webhooks; you would create one per repository.
- **Deploy keys** — good scoping, but it is a copy-paste step for the user,
  which is against the product's whole premise, and still no webhooks.

What the App gives: the installer picks WHICH repositories, tokens are
installation-scoped and expire in **1 hour**, webhooks are built in and
centralised, and the rate limit scales with installation size.

Cloning a private repo, from GitHub's docs:

    git clone https://x-access-token:<INSTALLATION_TOKEN>@github.com/owner/repo.git

Requires the `Contents` permission. The token comes from
`POST /app/installations/<id>/access_tokens` authenticated with a JWT signed by
the private key.

---

## What already exists — do not rebuild it

CHECKED by reading the code this session:

- **`git clone --depth 1 <url>`** already runs, in `lib/source.ts`
  (`fetchSource`, origin kind `clone`). Public repos only — no auth is attached
  anywhere today.
- **`apps.repo_url`** exists and is populated, guarded by `redeployableRepo` in
  `lib/repo-source.ts`. Read its docstring before touching it: `null` is a
  meaningful answer ("leave what is there"), because an upload's "url" is a GCS
  object that cannot be cloned again, and a column full of those is worse than
  an empty one.
- **`/new` has three "doors"**: `url`, `github`, `local`. The `github` one is
  NOT an integration — it formats `github.com/<repo>` into the same URL field.
  `app/new/page.tsx`, `type Door`.
- **`cloneToken`** is NOT a GitHub token. It is a handle into the clone cache
  that `/api/detect` fills (`put(dir)` → `takeClone(...)`). Easy to misread.

So the deploy path needs almost nothing: it already takes a repo URL and clones.
What is missing is authentication, a connection record, and a trigger.

---

## Suggested shape, and the order that matters

Phase one — **connect and deploy by button. No webhook.**

1. Store the App credentials; mint installation tokens with a 1-hour cache.
2. An install/callback route that records `installation_id` against the
   workspace.
3. `/new` lists the repositories that installation can see, instead of a text
   field.
4. Deploy the chosen one: clone with `x-access-token`, then the existing
   pipeline unchanged.

Phase two — **auto-deploy on push.** A webhook route with **signature
verification** (`X-Hub-Signature-256`, HMAC over the raw body with
`gh-webhook-secret`). Without it the route is an open door to deploying
arbitrary code as somebody else's app.

The order is deliberate: a webhook that deploys by itself is not a thing to
debug on live users.

**Store the connection as `installation → repository`, not as a token that once
worked.** Render's docs warn about the case we would otherwise miss: when the
person who connected a repository loses access to it, that service's deploys
break. That has to be a repairable state with a message, not a mystery failure.

Vercel ships a whole knowledge-base page for "I can't see my repository" — the
answer is always "the App was installed with a narrower selection than you
think". Put a "Configure GitHub App" link right on the import screen.

---

## Traps this session hit, which will still be there

- **`gcloud` tokens expire constantly.** Several times an hour of work ended in
  `Reauthentication failed`. Fix: `gcloud auth login a@supersonic.cv` — WITH the
  account named. Without it the browser picker offers `ilmak1704@gmail.com`,
  which has no permission on `supersonic-deploy-prod`, and everything keeps
  failing in the same way.
- **Two Postgres instances, two proxies.** Platform on 5433, tenants on 5434:

      cloud-sql-proxy -g --port 5433 …:supersonic-platform-pg
      cloud-sql-proxy -g --port 5434 …:supersonic-shared-pg

- **`test/deploy-pipeline.test.ts` hangs when run alone** and passes in the full
  `npm test` (CHECKED both). Do not chase it while doing something else; do not
  trust a solo run of that file either.
- **Measuring what a closure captures with a regex over the file is wrong** —
  it counts declarations in other functions and words inside comments. It was
  wrong three times in this session, twice by 3×. Strip comments and strings, or
  just read the function.

---

## Platform state as of now

CHECKED:

- Two apps: `l3sgp` (owner `arsenfounder@gmail.com`, live, no database) and
  `zs22g` (owner `ilmak1704@gmail.com`, live, PUBLIC, has a database with a
  `visits` table that grows on every request — it is the `examples/pgapp`
  example, deployed to test the new database view).
- `npm run drift` reports no divergence between what the platform believes and
  what exists. Run it before believing anything about resources.
- 1368 tests pass; `npx tsc --noEmit` is clean; `next build` succeeds.

`zs22g` is disposable. Deleting it is also the third live test of the delete
path that was fixed this session — it lied about success for fifteen databases
before that.
