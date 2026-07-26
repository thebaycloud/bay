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
