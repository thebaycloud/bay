# Rate limiting — design

25 Aug 2026. Status: proposed, nothing built.

## What exists today, so the gap is stated exactly

The platform has plenty of limits. None of them bound the rate of requests.

Enforced today, with `GATING_ENABLED=1` in production:

| Mechanism | What it bounds | Where |
|---|---|---|
| `maxApps`, `maxPublicApps` | resources held | `lib/entitlements.ts` |
| `monthlyBuilds`, `monthlyAgentRuns` | spend per calendar month | `lib/usage.ts` |
| `maxConcurrentDeploys` | builds in flight per owner | `app/api/deploy/reserve/route.ts` |
| `MAX_STEPS`, `MAX_REDEPLOYS`, `REPAIR_MAX_CALLS` | cost of one agent run | `lib/agent.ts`, `lib/agents/index.ts` |
| statement timeouts, 64KB beacon cap | one request's blast radius | `db/row/route.ts`, `services/proxy/src/bay.ts` |

What is absent: any limit of the form "N requests per interval". Not per IP, not
per account, not per session, on none of the 55 API routes. `signup` is
unlimited. The login path has no brute-force protection. Cloud Armor has zero
policies in the project.

The monthly meters are, technically, rate limits with a one-month window. They
bound "expensive over a month". They do not bound "a thousand requests in a
minute", and it is the second that takes the service down and scales Cloud Run
to 100 instances.

## The three threats this addresses

Chosen deliberately, and one plausible threat was left out.

1. **Free-tier abuse and cost.** Account farming through `signup`; every free
   account is worth 3 apps and 30 builds a month.
2. **Availability under flood.** Volume that scales the control plane out and
   exhausts connections to a ZONAL Cloud SQL instance.
3. **Password brute force.** The login path is protected by nothing.

Not addressed here: bursts against the agent and build endpoints inside an
already-paid-for monthly quota. Those have per-run cost ceilings already, and
adding a fourth concern would have widened this past one implementable change.

## The architectural constraint that shapes everything

**The control plane is not behind a load balancer.** `app.thebay.cloud` and
`app.supersonic.cv` are Cloud Run domain mappings. The project's two backend
services — `supersonic-proxy-backend` and `fleet-backend` — carry tenant traffic
and the fleet, and both have an empty `securityPolicy`.

Cloud Armor attaches to a backend service on a Google Cloud Load Balancer. So
**Cloud Armor cannot today protect signup or login**, which are the surfaces
threats 1 and 3 live on. Reaching them at the edge means first moving the
control plane behind a load balancer: serverless NEG, backend service, URL map,
certificate, DNS cutover.

That migration is deliberately **not** in this design. `www.supersonic.cv`
currently returns 404 because DNS points it at the load balancer while its
domain mapping expects `ghs.googlehosted.com` — the same two-paths confusion,
already paid for once. Coupling a DNS cutover of a live domain to the delivery
of a limiter means that when something breaks at night, nobody knows which of
the two broke.

## The shape: three layers, delivered separately

**Layer 1 — Cloud Armor on what is already behind the load balancer.**
Policies on `supersonic-proxy-backend` and `fleet-backend`: per-IP volumetric
throttling plus the preconfigured WAF rules. Nothing is migrated; both backends
exist and are unprotected. This covers the whole public tenant surface, which is
the bulk of traffic. Configuration, not code.

**Layer 2 — an application limiter on Postgres.** Covers signup, login, and
account-shaped logic that no edge rule can express ("ten signups per email
domain per hour" is not an IP rule).

**Layer 3 — lower `maxScale` on the control plane.** It is 100 today. Until the
control plane sits behind a load balancer, this is the only thing bounding what
a flood costs. It trades availability for cost and is a knob, not a fix; it is
named here so the trade is explicit rather than discovered on a bill.

Left open: the control plane's move behind the load balancer, and Cloud Armor on
it. Its own plan, its own window.

## Layer 2 in detail

### Storage

A new table in `supersonic_platform`, migration `db/036_rate_limits.sql`:

```sql
CREATE TABLE rate_limits (
  bucket       text        NOT NULL,   -- 'signup:ip:203.0.113.4'
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, window_start)
);
```

**A fixed window, not a sliding one.** A sliding window in Postgres costs either
a row per request — with the cleanup and the write volume that implies — or an
approximation over two adjacent windows. The fixed window is one atomic
statement and nothing else, which is the same thing `countIfUnder` already
chose. Its known weakness is a 2x burst across a boundary: a 10-per-minute limit
tolerates 20 in the two seconds either side of the tick. For refusing brute
force and account farming, 20 is as refused as 10. The simpler mechanism is
enough, and it is worth saying why rather than leaving a reader to assume the
sliding window was forgotten.

### The atomic take

The same trick as `lib/usage.ts:countIfUnder`, and for the same reason it gives
there: the check and the increment cannot be two statements, or concurrent
callers all read "9 of 10" and all pass.

```sql
INSERT INTO rate_limits (bucket, window_start, hits)
VALUES ($1, $2, 1)
ON CONFLICT (bucket, window_start)
DO UPDATE SET hits = rate_limits.hits + 1, updated_at = now()
WHERE rate_limits.hits < $3
RETURNING hits
```

An empty `RETURNING` means the ceiling was reached. The `WHERE` on the
`DO UPDATE` is the whole mechanism.

### Interface

`apps/web/lib/rate-limit.ts`:

```ts
export type Scope = "signup:ip" | "signup:email-domain" | "login:email-ip";

export type Verdict =
  | { ok: true }
  | { ok: false; retryAfterSec: number };

export async function takeToken(scope: Scope, key: string): Promise<Verdict>;
```

`Scope` is a closed union rather than an open string, for the reason `Meter` is
one in `usage.ts`: the scope name reaches a query, and a caller-supplied one
would be an injection.

Ceilings live in one exported table, the way `LIMITS` does in `entitlements.ts`,
so that the number a route enforces and the number a reader looks up cannot
disagree.

### Failing open, and the one place that fails closed

`signup` and everything else fail **open**, mirroring `countIfUnder`: a database
hiccup must not be experienced as "I was refused for no reason". The cost of
letting a few events through during an outage is small.

**Login fails closed.** A database outage must not open a brute-force window.
The asymmetry is the same one `takeFreeFix` already makes and rests on the same
question — what does being wrong cost. Being wrong open on signup costs a few
junk accounts. Being wrong open on login costs an account.

### Cleanup

Old windows must be deleted or the table grows without bound, and unlike
`usage_counters` this one is written on every request to a protected route. A
`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'` on an
existing reconcile job. Named as its own item because a limiter that quietly
fills the platform database is a worse outage than the one it prevents.

### THE HAZARD: which IP do we trust

**No code in the control plane reads the client IP today.** There is no helper
to copy, and getting this wrong produces a limiter that looks like it works and
stops nothing.

`x-forwarded-for` is a list. Cloud Run appends the connecting address, and the
client controls what it sends. Taking the **first** element — the common
implementation — takes an attacker-supplied value: every request carries a fresh
fake IP, every request gets a fresh bucket, and the limit is never reached. The
protection is worth zero and reads as green.

`lib/public-origin.ts:18` already records this lesson for a sibling header:
*"`x-forwarded-host` is set by our proxy and by anybody else who feels like
it."*

**This must be settled by measurement before the limiter ships.** Log the raw
header on one route, compare against `httpRequest.remoteIp` in the Cloud Run
request log — the value Google computes rather than one the request carries —
and only then fix the parsing rule. Reading the documentation is not the check.
This repository's own rule is to run the check rather than read for it, and the
handoff's opening section is three incidents that came from doing the reverse.

Until measured, the parse rule is an open question, not a design decision.

### Connection points

- `app/api/signup/route.ts` — **before** the bcrypt call. bcrypt is deliberately
  expensive, which makes an unlimited signup route a CPU exhaustion surface on
  its own, independent of how many accounts it creates.
- The Credentials `authorize`, before `bcrypt.compare`. Confirmed against the
  installed next-auth rather than assumed: `5.0.0-beta.32`, whose
  `@auth/core/providers/credentials.d.ts` documents the signature as
  `(credentials, request)` — "you have access to the original request as well".
  The request is where the address comes from.

  This function has to move out of `auth.ts` first. That module exports only
  `{ handlers, auth, signIn, signOut }`; the `providers` array is local, so the
  closure is unreachable from a test, and a brute-force gate nobody can test is
  a gate nobody can prove still works after the next edit. It becomes
  `lib/credentials-login.ts:authorizeCredentials`, and `auth.ts` goes back to
  wiring providers together.
`app/api/deploy/reserve/route.ts` is deliberately **not** a connection point.
Bursts against the deploy path inside an already-paid-for monthly quota are the
threat this design excluded, and adding a scope for it here would have
contradicted that exclusion two sections later. It already refuses on
`maxConcurrentDeploys`.

OAuth sign-in through Google and GitHub is out of scope: there is no password to
guess, and the rate limit that matters there is the provider's own.

### Shipping safely

Behind `RATE_LIMIT_MODE`, defaulting to off, read once at module load exactly as
`GATING_ENABLED` is. Three states rather than two — `off`, `count`, `enforce` —
which is why it is a mode and not an `*_ENABLED` boolean. The middle one
**counts but never refuses**. Run it that way for a week and read the real
numbers before any ceiling turns into a refusal.

In `count` the counter must run PAST the ceiling rather than stopping at it,
which means a different statement, not just a different branch on the result. A
counter that stops at the guess only ever reports that somebody reached it, and
never how far past they went — and that distance is the entire number the real
ceiling is supposed to be chosen from. `countIfUnder` already counts unlimited
plans for this reason, and says so: a plan that records nothing is a plan we
cannot price.

This exists because every ceiling in this document is currently a guess. Nobody
has ever counted signups per hour or failed logins per account here, and a limit
chosen from imagination is as likely to refuse a real user on a bad day as to
refuse an attacker.

### Tests

Following `test/plan-limits.test.ts`. What must be covered:

- concurrent takes against the same bucket do not exceed the ceiling — the race
  `countIfUnder`'s comment describes
- a window boundary resets the count
- login fails closed and signup fails open when the query throws
- a forged `x-forwarded-for` does not create a new bucket, once the parse rule
  is settled by measurement
- the flag's three states: off, count-only, enforcing

## Sequencing

1. Cloud Armor on the two existing backends — configuration, ~an hour, no
   migration, no code.
2. `maxScale` on the control plane — one setting.
3. The limiter — code, roughly half a day with tests, shipped flag-off, then a
   week counting before it refuses anything.

**A dependency worth stating.** Step 3 is code, and every push to `main` deploys
production while no CI runs the 1593 tests that exist. Either CI lands first, or
the limiter ships behind a flag that is off — the flag is in the design
regardless, so this is not a blocker, but it is the reason the flag is not
optional.

## What this does not do

- Does not protect `app.thebay.cloud` from a volumetric flood. That needs the
  load balancer migration.
- Does not replace the monthly quotas. Different window, different question.
- Does not do anything for tenant apps' own rate limiting.
  `services/proxy/src/headers.ts` already forwards the client IP so that a
  tenant app can limit its own traffic, and that division stays.
