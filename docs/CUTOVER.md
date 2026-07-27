# Sharing layer — cutover checklist

Everything below the line is **built, deployed, and verified against production**.
What remains is the DNS switch, which is deliberately not done: it reroutes every
hosted app through the proxy in one step.

## Already done and proven

- `supersonic-proxy` runs on Cloud Run (`min-instances=1`), as its own service
  account, with Cloud SQL attached and secrets from Secret Manager.
- A global external load balancer fronts it: serverless NEG →
  `supersonic-proxy-backend` → `supersonic-lb` → HTTP frontend on **8.233.7.157**.
- Five pre-existing apps are recorded in `apps`, all `private`
  (`cursor-meetup`, `ss-mt-df8y2z`, `subio`, `subio-2`, `zs73v`).
- Verified through the load balancer with a real session:
  | Case | Result |
  |---|---|
  | owner of `subio` | 200, the app's own HTML |
  | a different signed-in user | 403, "you don't have access" |
  | garbage session cookie | 302 to sign-in |
  | unknown slug / off-domain Host | 404 |
- New deploys are sealed: `--no-allow-unauthenticated`, invoker granted only to
  the proxy and the control plane. Proven: a fresh service returns 403 anonymously
  while an app deployed by the old code still returns 200.

## The switch

Both routing models live in the code and are selected by one environment variable
on the control plane:

| `SEAL_APPS` | Deploy behaviour | Routing |
|---|---|---|
| unset (today) | `--allow-unauthenticated` + per-app domain mapping | `<slug>.supersonic.cv` -> Cloud Run directly |
| `1` (after cutover) | `--no-allow-unauthenticated` + invoker granted to the proxy | `*.supersonic.cv` -> load balancer -> proxy -> app |

They are mutually exclusive. Setting `SEAL_APPS=1` before DNS moves makes every
new app unreachable: the domain mapping still points straight at Cloud Run, which
now refuses anonymous callers. Flip it in step 5 below, not earlier.

The `apps` row is written either way, so the proxy is ready the moment DNS moves.

## Remaining, in this order

1. **Wildcard certificate.** Classic managed certs reject `*.supersonic.cv`
   ("Wildcard domains not supported"). Use Certificate Manager — see the commented
   block in `docs/superpowers/plans/2026-07-25-sharing-layer.md` Task 11 Step 4.
   The DNS authorization record it asks for reroutes nothing; it is safe to add early.

2. **Set `COOKIE_DOMAIN=.supersonic.cv`** on the control plane and redeploy.
   Without it the session cookie stays host-only and the proxy will bounce every
   visitor to sign-in in a loop.

3. **Re-run the backfill** (`node --import tsx apps/web/db/backfill-apps.ts`) so any
   app deployed since is present. An app missing from `apps` returns 404 the moment
   DNS moves.

4. **Point `*.supersonic.cv` at 8.233.7.157.** This is the irreversible step.
   Today the record points at `ghs.googlehosted.com` (per-app domain mappings).

5. **Set `SEAL_APPS=1`** on the control plane and redeploy. New deploys are sealed
   from this point; existing apps are unaffected until step 7.

6. **Decide the public-app story before sealing anything.** `landing`,
   `supersonic-landing`, and `supersonic-control-plane` are public on purpose and are
   excluded from the backfill. The sharing model has no "public" visibility — adding
   one is a product decision, not a migration step.

7. **Seal the remaining apps** once the proxy path is confirmed live:
   remove `allUsers` invoker, add the proxy service account.

## Rollback

Point DNS back at `ghs.googlehosted.com`. The per-app domain mappings were deleted
from the deploy path but existing mappings were never removed, so previously
deployed apps keep resolving. Nothing in the database needs undoing — the proxy is
the only thing that reads `apps`.

---

# Turning on Google sign-in

Three steps that need a browser and cannot be scripted. Everything else is done:
the allowlist table is seeded, the gate is live in `signIn`, and the button is wired.

1. **Create the OAuth client.** Cloud Console → APIs & Services → Credentials →
   Create credentials → OAuth client ID → **Web application**, in project
   `supersonic-deploy-prod`. Configure the consent screen first if prompted;
   `External` is required because two operators sign in with personal gmail addresses.

2. **Add the redirect URI**, exactly, scheme included:
   `https://<control-plane-host>/api/auth/callback/google`
   The host must match `AUTH_URL` on the deployed control plane. A mismatch is the
   single most common cause of `redirect_uri_mismatch`.

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

**Verify before removing passwords:** sign in with Google as an operator and confirm
you land on your existing account with your existing apps — not a duplicate. Then sign
in with a Google account that is not on the allowlist and confirm the readable
"isn't on the invite list" message. Only then run Task 5 of
`docs/superpowers/plans/2026-07-27-verified-identity.md`.

## Managing the allowlist

Adding someone is one row, no redeploy:

```sql
INSERT INTO allowed_signins(email, note)  VALUES ('boris@acme.com', 'invited by arsen');
INSERT INTO allowed_signins(domain, note) VALUES ('acme.com',       'partner company');
```

Removing access is a DELETE — but it does **not** revoke anything already issued:

| What they hold | Does DELETE stop it? |
|---|---|
| A browser session | No — it survives until it expires. Rotating `AUTH_SECRET` signs everyone out. |
| A CLI token (`cli_tokens`) | **No.** These are database-backed bearer tokens, unaffected by `AUTH_SECRET`, and nothing re-checks them against the allowlist. Delete the person's rows from `cli_tokens` too. |

So a full revocation today is three steps: delete from `allowed_signins`, delete their
rows from `cli_tokens`, and rotate `AUTH_SECRET` if the session must die immediately.
Re-checking the allowlist on CLI token use is a known gap, not yet built.

---

# Fast deploys — infrastructure to create

The code for the three-lane pipeline is merged and **inert until these exist**. Every
new setting is read from an environment variable that defaults to today's behaviour,
so the control plane runs unchanged with none of them set. Turn them on in this order.

## 1. The static assets bucket

```bash
gcloud storage buckets create gs://supersonic-static-assets \
  --location us-central1 --project supersonic-deploy-prod \
  --uniform-bucket-level-access
```

## 2. The static server's identity

Least privilege from the start: read on one bucket, nothing else. This is deliberate —
an audit on 2026-07-27 found every hosted app inheriting the default compute account
with `run.admin`, `storage.admin` and `artifactregistry.writer`, and new services are
not going to repeat that.

```bash
gcloud iam service-accounts create supersonic-static \
  --display-name "Supersonic static server" --project supersonic-deploy-prod

gcloud storage buckets add-iam-policy-binding gs://supersonic-static-assets \
  --member "serviceAccount:supersonic-static@supersonic-deploy-prod.iam.gserviceaccount.com" \
  --role roles/storage.objectViewer --project supersonic-deploy-prod
```

## 3. Deploy the static server

```bash
cd services/static
gcloud run deploy supersonic-static \
  --source . --region us-central1 --project supersonic-deploy-prod \
  --service-account supersonic-static@supersonic-deploy-prod.iam.gserviceaccount.com \
  --set-env-vars ASSETS_BUCKET=supersonic-static-assets,ROOT_DOMAIN=supersonic.cv \
  --allow-unauthenticated --quiet
```

`--allow-unauthenticated` matches the apps it fronts while `SEAL_APPS` is off. When
sealing happens, this service seals with everything else — it is an ordinary Cloud Run
service, which is exactly why the proxy and the visibility rules already cover it.

## 4. The regional npm mirror — created, deliberately NOT switched on

```bash
gcloud artifacts repositories create npm-mirror \
  --repository-format npm --mode remote-repository \
  --remote-repo-config-desc "npmjs" --remote-npm-repo NPMJS \
  --location us-central1 --project supersonic-deploy-prod
```

The repository exists. **`NPM_REGISTRY` is not set, and must not be set as-is.**

Artifact Registry npm repositories refuse anonymous reads — verified against the
live mirror, which answers `401` to an unauthenticated GET. Pointing builds at it
without credentials would fail every `npm install` in the platform at once.

Making it work needs an `.npmrc` carrying an access token in the build environment,
and that has a trap: writing a token into a Dockerfile bakes it into an image layer,
where it outlives the build and ships to whoever can pull the image. The static
lane can do this safely because we own its Cloud Build steps and can write `.npmrc`
in a step rather than a layer. The container lanes build with Kaniko from a
customer-visible Dockerfile, so they need a build-arg or a mounted secret instead.

Until that is built, leave `NPM_REGISTRY` unset. The base images below already
carry a warm package cache, which is where most of the cold-start win comes from.

## 5. The base image repository

```bash
gcloud artifacts repositories create bases \
  --repository-format docker --location us-central1 \
  --project supersonic-deploy-prod

infra/bases/refresh.sh
```

`refresh.sh` builds `:candidate`, smoke-tests it, and only then moves `:stable`. Run it
weekly. A failed refresh leaves `:stable` alone and exits non-zero — deploys keep using
the last good base, which is the whole point of the gate.

## 6. Switch the control plane on — done

Applied on 2026-07-27:

```bash
gcloud run services update supersonic-control-plane \
  --region us-central1 --project supersonic-deploy-prod \
  --update-env-vars \
STATIC_SERVICE=supersonic-static,\
ASSETS_BUCKET=supersonic-static-assets,\
NODE_BASE_IMAGE=us-central1-docker.pkg.dev/supersonic-deploy-prod/bases/node22:stable,\
NEXT_BASE_IMAGE=us-central1-docker.pkg.dev/supersonic-deploy-prod/bases/node22-next:stable
```

`NPM_REGISTRY` is deliberately absent — see section 4.

Each variable is independent, and unsetting any one reverts that piece with no
redeploy. Removing `STATIC_SERVICE` and `ASSETS_BUCKET` sends every project back
down the container path.

## How static apps are actually routed

Worth writing down, because the obvious answer is wrong and cost a round of
debugging.

All of `*.supersonic.cv` resolves to one load-balancer IP, so app traffic reaches
the **proxy** — not the per-app Cloud Run domain mappings, which DNS never points
at. Those mappings exist for several apps and are inert.

The proxy routes by looking up `apps.run_url`, so a static app's row points at the
shared static server. And because the proxy drops `Host` and lets the upstream
request set its own, the static server cannot learn which app a request was for
from the hostname — every static app shares that one upstream. The proxy therefore
names the app in `x-supersonic-slug`, which is safe to trust downstream precisely
because the proxy already discards anything a client sends under that prefix.

Consequence: a static deploy creates no domain mapping. There is nothing to map.

## 7. Apply the migration

`004_deploy_stages.sql` creates the per-stage timing table. It is additive and
idempotent like the rest.

```bash
cd apps/web && npx tsx db/migrate.ts
```

Nothing else in this section depends on it, but the lane timings in the design are
projections until this table has data behind them — so it is worth doing first, not last.

## Not done here: the hosted-app runtime account

`APP_RUNTIME_SERVICE_ACCOUNT` is read by the deploy route and unset, so hosted apps still
inherit the default compute account and its project-wide admin roles. Creating a
locked-down account and trimming the default one's roles is a separate, higher-risk
change — Cloud Build and the control plane both lean on those roles, and cutting them
blind will take the platform down. It needs its own careful pass.
