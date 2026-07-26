# Verified Identity — Design

**Date:** 2026-07-27
**Status:** Approved (blanket approval given; design gates waived by the user)
**Scope:** Replace self-asserted email identity with Google-verified sign-in, gated by an allowlist.

---

## Why

The sharing layer shipped on 2026-07-25 assumes one thing: that an email address proves who
someone is, and that the domain of that address proves which company they belong to. Neither is
true today.

`apps/web/app/login/page.tsx` renders the Google button **disabled** ("soon"), and `auth.ts` only
registers the Google provider when `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` exist — they exist
nowhere: not in `.env.local`, not in Secret Manager, not on the deployed control plane. The live
path is `app/api/signup/route.ts`, which accepts any email with no verification, gated only by an
optional shared `SIGNUP_INVITE_CODE`.

The consequence is direct: register as `boris@acme.com`, get auto-joined to Acme's company
workspace, and open every app whose visibility is `workspace` — plus claim any pending grant for
that address. The final whole-branch review rated this Critical.

A second, quieter consequence: the whole security argument for deferring the deploy-agent sandbox
was "deploying stays invite-only." That barrier is the signup invite code. Remove unverified
signup without replacing the barrier and anyone with a Google account gets arbitrary code
execution in the control plane.

## Goals

- A person can only sign in with an address Google has verified they control.
- A person can only sign in if their address, or its domain, is on an allowlist.
- The allowlist is data, not configuration — adding someone is one row, not a redeploy.
- All nine existing users keep access.
- The migration cannot lock the operators out of their own product.

## Non-goals

- A UI for managing the allowlist. It is SQL for now.
- Non-Google identity (Microsoft, generic OIDC, magic links).
- Email verification for password accounts — passwords are being removed, not fixed.
- Sandboxing the deploy agent. The allowlist preserves the existing trust boundary; it does not
  remove the need for a sandbox before self-serve signup opens.
- Roles, invitations with notification, or anything else from the collaboration backlog.

---

## Identity check

One enforcement point: the `signIn` callback in `apps/web/auth.ts`. It already runs on every
sign-in regardless of provider, and it already owns user creation and workspace assignment, so the
check belongs in front of both.

```
sign-in (Google or, until deploy 2, password)
      |
      v
  signIn callback
      |  1. address present?            -> no:  deny
      |  2. address or its domain allowlisted?
      |        \- no --------------------->  deny -> /login?error=not_invited
      |  3. create the user if new
      |  4. assign a workspace from the domain
      v
   session
```

Because the check sits in front of **both** providers, deploy 1 closes the hole on its own: while
passwords still work, a stranger cannot register, because they are not on the list. Deploy 2 then
removes passwords as cleanup rather than as the fix.

### The decision is a pure function

```ts
// lib/allowlist.ts
export function isAllowed(email: string, entries: AllowEntry[]): boolean
```

No I/O, exhaustively testable, same shape as `decideAccess` in the proxy. The caller resolves the
entries; the function decides. Matching is case-insensitive on both sides, and an address matches
either by its full value or by its domain.

### Denial must be legible

Auth.js's default denial lands the visitor on its generic error page reading `AccessDenied`. For an
invited colleague who mistyped, or who signed in with a personal account instead of a work one,
that is a dead end. Denial redirects to `/login?error=not_invited`, and the login page renders a
sentence naming the address that was rejected and telling them to ask whoever invited them.

Note the address is echoed back to the person who just supplied it, so it discloses nothing they
did not already know.

---

## Data model

```
allowed_signins
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid()
  email     text UNIQUE           -- exactly one of email/domain is set
  domain    text UNIQUE
  note      text                  -- who added it and why, free text
  added_at  timestamptz NOT NULL DEFAULT now()
  CONSTRAINT one_of CHECK (num_nonnulls(email, domain) = 1)
```

`email` and `domain` are both nullable and both unique; the CHECK enforces that exactly one is
present. Postgres treats NULLs as distinct in a unique index, so many domain rows coexist with many
email rows.

**Seeding is part of the migration, not a follow-up.** The seed contains every existing user's
address plus `luwo.ai` and `supersonic.cv`, both confirmed Google Workspace domains (MX -> Google).
Without the seed in place before the check reaches production, the first deploy locks everyone out
including the operators.

The one address that cannot be rescued is `inv1784822118963@t.co` — a synthetic invite-test account
on a domain with no MX record. It is seeded anyway for consistency; it simply will never have a
Google account to sign in with.

---

## Migration: two deploys

Removing passwords and enabling Google in one step risks a locked door: a wrong redirect URI, an
unpublished consent screen, or the wrong client type means nobody can sign in, and the fix requires
a deploy that cannot be verified without signing in.

**Deploy 1 — add.** The `allowed_signins` table with its seed, the check in `signIn`, the denial
page, and the Google provider enabled. Passwords keep working. The operator signs in with Google
for real and confirms they land in their own account with their own apps.

**Deploy 2 — remove.** Delete the credentials provider, `app/api/signup/route.ts`, the signup page,
and `SIGNUP_INVITE_CODE`.

`users.password_hash` is deliberately **kept**. Dropping a column is irreversible and buys nothing;
the code stops reading it.

### What only a human can do

These three steps need a browser and cannot be scripted:

1. Create an OAuth 2.0 Client ID (type: Web application) in the Cloud Console for
   `supersonic-deploy-prod`.
2. Add the authorized redirect URI: `https://<control-plane-host>/api/auth/callback/google`.
   The host must match `AUTH_URL` on the deployed service exactly, scheme included.
3. Put the client ID and secret in Secret Manager and redeploy the control plane with them
   wired to `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

Until step 3 lands, `auth.ts` simply does not register the Google provider — the code is inert, not
broken.

---

## Error handling

| Situation | Behavior |
|---|---|
| Address not on the list | Redirect to `/login?error=not_invited`, page names the address |
| Google returns no email | Deny — there is nothing to check against |
| Allowlist query fails | Deny, and log. A database outage must not become an open door |
| Address on the list, first sign-in | Normal: user created, workspace assigned from the domain |
| Address on the list, personal provider (gmail) | Normal: personal workspace, as today |

The failure-closed rule for a database error is deliberate. The alternative — allowing sign-in when
the check cannot run — turns a transient outage into an authentication bypass.

---

## Testing

`isAllowed` is pure, so it carries the load:

1. exact email match, including differing case and surrounding whitespace
2. domain match for an address whose email is not listed individually
3. an address on an unlisted domain is denied
4. an empty or malformed address is denied
5. a domain entry does not match an address that merely *contains* it
   (`evil-luwo.ai` must not match `luwo.ai`)
6. every one of the nine existing addresses is allowed by the seeded list

Case 5 is the same boundary bug the proxy's `slugFromHost` had to avoid, and it is the one an
implementation using `endsWith` gets wrong.

Beyond the unit tests, one manual check after deploy 1: sign in with Google as an operator, confirm
the session lands on the existing user row rather than creating a duplicate, and confirm a
non-allowlisted Google account is refused with the readable page.

---

## Out of scope, but adjacent

Two items from the final whole-branch review remain open and are **not** addressed here:

- Sealing is unconditional while the `apps` row write is conditional, so a deployer without a
  workspace can produce a sealed app that is absent from `apps` and therefore unreachable. Latent
  today because `SEAL_APPS` is off; it fires at cutover.
- Chunked session cookies (`<name>.0`, `<name>.1`, emitted above 4096 bytes) bypass the proxy's
  cookie stripping and reach tenant apps.
