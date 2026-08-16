# Analytics on every hosted app

## Why

The panel ships an Analytics section that is drawn from a fixture. It is the one
surface in the panel that claims something we do not measure, and the numbers it
claims — visitors, bounce, how long they stayed, where they came from — are the
first questions somebody asks about an app they just put on the internet.

**Umami**, one instance, serving every hosted app. MIT, Postgres, native
multi-site, cookieless by default, ~2 KB tracker, and a REST API we read from —
its own interface is never shown to an owner.

Not PostHog: its supported self-hosted deployment was withdrawn and what remains
is a compose file its own docs decline to recommend at scale; the real stack is
ClickHouse plus Kafka. Its value is funnels, cohorts and replay, which is
analytics for somebody building a product, not for somebody asking whether
anyone opened theirs. Not Plausible: AGPL, and we embed this in our own UI.

**This does not replace the edge.** A broken app serves 500s and runs no
JavaScript, so umami would show traffic vanishing and be unable to say why. Umami
answers *people*; the edge keeps answering *machine*. That is the same line the
panel already draws between `Analytics` and `Right now`.

## Decisions

**One instance, not one per app.** Umami's own model is a "website" per site with
its own id. Thirty-two apps is thirty-two rows, not thirty-two containers.

**It runs on Cloud Run, not the fleet.** ADR 0001 moved *tenant* compute off
Cloud Run; this is platform compute, like the proxy and `apps/web`. Private
ingress, reachable by the platform only.

**Its database is `umami` on `supersonic-platform-pg`** — the platform instance,
not the shared one. Umami owns and migrates that schema itself; we never write to
it.

**The tracker is served first-party, from the app's own address.** Two routes on
the edge:

- `GET /_bay/a.js` → umami's `script.js`
- `POST /_bay/a` → umami's `/api/send`

This is the load-bearing decision. A third-party script tag is blocked by every
content blocker, needs CORS, and tells the visitor about a vendor they have no
relationship with. Proxied through the app's own origin it is same-origin,
unblockable by hostname, and never leaves the address the visitor already chose
to trust. It also means the umami service is never publicly reachable.

**Owners can turn it off**, and that switch is in `Analytics`, not buried.

## Order of work

Each task is committed on its own and verified before the next begins.

### 1. The service and its database

- `umami` database on `supersonic-platform-pg`, its own role.
- Cloud Run service `supersonic-umami`: image `ghcr.io/umami-software/umami:postgresql-latest`,
  `DATABASE_URL` and `APP_SECRET` from Secret Manager, ingress internal, no
  public URL, min-instances 0.
- One admin account, credentials in Secret Manager. This UI is for us.

**Verify:** the platform can reach `/api/heartbeat`; the internet cannot.

### 2. First-party routes on the edge

In `services/proxy/src/routes.ts`, before app forwarding:

- `/_bay/a.js` — proxy umami's script, cache a day, strip cookies both ways.
- `/_bay/a` — proxy the collect endpoint. Forward `User-Agent` and set
  `X-Forwarded-For` so umami still resolves country and device; nothing else.

Both answer for the slug they arrive on, so an app's analytics can never be
posted from another app's address.

**Verify:** `curl https://<slug>.supersonic.cv/_bay/a.js` returns the tracker;
a hand-made `POST /_bay/a` shows up in umami within a few seconds.

### 3. A website per app

- Column `umami_website_id` on `apps`.
- On `createAppRecord` (`apps/web/lib/apps.ts:18`), create the umami website and
  store the id. Idempotent — creating an app twice must not create two sites.
- A backfill for the ~32 apps that already exist.

Provisioning failure must **not** fail a deploy. An app with no analytics is an
app with no analytics; an app that would not ship because analytics was down is
a much worse thing.

**Verify:** create a throwaway app, see the website appear; delete it, see the
site removed; `supersonic delete` still works when umami is unreachable.

### 4. Inject the tracker

`inject.ts` already builds one script for every HTML app and already knows the
slug. Add the tracker tag to it — for **every visitor**, not only the owner, and
outside the `owner ? OWNER_JS : ""` split so no owner-only surface leaks.

```
<script defer src="/_bay/a.js" data-website-id="<id>" data-host-url="/_bay"></script>
```

Umami's tracker follows `history.pushState` on its own, which is what closes the
client-side-routing gap the edge cannot see.

**Verify:** load a hosted app in a browser with a content blocker on and watch
the request land. Confirm a visitor reading the page source learns nothing about
the panel.

### 5. Read it back

`services/proxy/src/analytics.ts` — query umami's API for one website and shape
it into the field the panel already expects:

```ts
interface Audience {
  visitors: number; views: number; bounce: number; avgSeconds: number;
  change: number | null;          // vs the previous window; null when too new
  pages: [string, number][];
  from:  [string, number][];
  on:    [string, number][];
}
```

It joins `Reading` beside `live` and `builds`, with the same honesty rule the
other two halves keep: a window we could not read is **not** an app nobody
visited. `since.audience: "read" | "unreadable" | "off"`.

Cache per slug for ~60s. The panel polls every 3 seconds and umami must not be
asked 20 times a minute per app.

**Verify:** `reading.test.ts` gains cases for read / unreadable / off, and the
numbers match umami's own dashboard for the same window.

### 6. The panel stops pretending

The Analytics screen reads `d.audience` instead of the fixture, and the empty and
unreadable branches say which is which.

### 7. The switch

`Analytics → off` stops the injection and stops the reads. Existing data stays
until the app is deleted.

## What will bite

- **Content-Security-Policy.** A hosted app that sets its own CSP blocks our
  injected script. This is already true of the overlay and the panel — worth
  measuring across the live apps before assuming the tracker will land.
- **Do not double-count.** The edge counts requests, umami counts people. They
  will disagree and both will be right. Never show them as the same number.
- **`anonId` is `req.socket.remotePort`** (`forward.ts:85`) — per connection, not
  per visitor. Fine for the 90-second "here now" window, wrong for anything
  cumulative. Do not let it grow into a visitor count now that a real one exists.
- **This is other people's users' data.** Terms, retention, and the owner switch
  are part of shipping it, not a follow-up.

## Not in this plan

Minute rollups of the edge's own numbers — the storage that would let the panel
say "it got slower after Tuesday's ship". Still unbuilt, still the blocker for
every comparative statement about latency and breakage. Umami does not solve it:
it knows nothing about status codes, durations or ships.
