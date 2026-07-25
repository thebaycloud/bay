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
