# Dashboard speed — design

**Date:** 2026-07-30 · **Status:** approved

The dashboard is slow. Measured, it is not slow for any of the reasons it looked
slow for.

---

## What the measurements say

Taken against production on 2026-07-30:

| | |
|---|---|
| Cloud Run's own view of a request | **4–9 ms** |
| What the browser sees | **~480 ms** |
| One app-card preview (`choqd`) | **3.4 s** |
| JavaScript shipped | 449 kB across 10 chunks |
| Edge cache on static assets | none — no `age` header, `Google Frontend` answers directly |

The server is not the problem. It answers in single-digit milliseconds. Everything
else is distance and payload — and one line of markup that dwarfs both.

## The line of markup

`apps/web/app/page.tsx:82` renders each app card's thumbnail as a **live iframe of
the app itself**:

```jsx
<iframe src={`https://${a.slug}.supersonic.cv`} loading="lazy" sandbox="allow-scripts allow-same-origin" />
```

Opening the dashboard therefore opens every app on it. Measured: 3.4 s for one
app's HTML alone, before the app's own scripts, styles and fonts load inside the
frame. Five apps is five websites, in parallel, to draw five 300×200 thumbnails.

`loading="lazy"` defers only what is below the fold; the first row loads
immediately.

Private apps return **401** to the visitor's browser, so their cards spend a
network round trip to render nothing.

And `sandbox="allow-scripts allow-same-origin"` — those two together — is close to
no sandbox at all: the framed app can reach back into the same origin it was framed
from.

## Fix 1 — thumbnails become screenshots

Capture a screenshot once, at deploy time, store it beside the release in GCS, and
serve it as an ordinary image with a long cache. The card gets an `<img>` of tens of
kilobytes instead of a whole application.

Three things fall out of it:

- The dashboard stops loading other websites to draw itself.
- Private apps get a thumbnail, because the platform captures it rather than the
  visitor's browser. Today they show an authentication error.
- Customer code stops executing inside our dashboard's origin.

Apps deployed before this have no screenshot; their cards keep today's monogram
fallback. No backfill — the next deploy of each app produces one.

## Fix 2 — render the list on the server

The page is `"use client"` and fetches in `useEffect`, so the sequence is: HTML,
then 449 kB of JavaScript, then hydration, and only then a request for the list.
The content of the page arrives last.

Moving the read to the server puts the list inside the HTML. One fewer round trip,
and the list is painted before hydration rather than after it.

The poll stays on the client but only runs while something is building. Today it is
armed on every load and needed on roughly one in a hundred.

**Failure behaviour:** if the server-side read fails, the page renders with an empty
list and the client fetches it exactly as it does today. Server rendering must not
be able to make the page worse than the version it replaces.

## Order, and why it is this order

Screenshots first: they are worth **seconds**. Server rendering is worth tens of
milliseconds.

I nearly did it the other way round, because I started from the API timings and the
API timings pointed at the API. The markup was where the time actually went.

## Not doing now

**A CDN in front of Cloud Run.** It would help the 449 kB, particularly for Europe.
But it is an infrastructure change with its own rollout, and for a US audience the
gain is modest next to the two fixes above. Worth revisiting once they land and the
numbers are re-measured.

**Trimming the JavaScript.** 109 kB of that 449 kB is the legacy-browser polyfill
bundle. Real, but again: milliseconds against seconds.

## How we will know it worked

Re-measure the same three numbers: time to the app list appearing, bytes fetched on
load, and the count of cross-origin requests the dashboard makes. The last one
should go from *one per app* to *zero*.
