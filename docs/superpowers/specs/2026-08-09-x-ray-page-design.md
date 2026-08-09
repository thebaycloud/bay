# The X-ray page: one reading, two renderings

Design date: 2026-08-09. Supersedes the app page in `apps/web/app/apps/[slug]`
and `apps/web/components/Cockpit.tsx`.

Research behind it: `docs/research/agent-first-dashboard.md` (855 lines, primary
sources, six claims verified by live HTTP probe).

---

## The one-paragraph answer

An app's page stops being a console that describes the app and becomes the
**X-ray** — the same thing the owner already brings up over their live app, now
also openable as a page at the app's own address. It is assembled once into a
single **reading** and rendered twice: HTML for a person, JSON for the owner's
agent, split on `Accept`. The load-bearing commitment is **one object, not one
URL** — the human render may not reach past the reading for anything, because
that is precisely the bug the repo has already paid for once.

## Why this, and not Render's five tabs

Render's dashboard splits an app across Events / Logs / Metrics / Shell /
Settings and leaves the join — "was the latency spike the deploy?" — to the
person. Five pictures from which a human assembles the answer. And an agent
cannot read any of them; it is handed a separate REST API built by different
code, which drifts.

The drift is not hypothetical here. `apps/web/app/api/apps/route.ts:24-28`, in
the team's own words:

> anything the first render has and this does not VANISHES from every row the
> moment a deploy starts. That is exactly what happened to the "deployed" line,
> which the server had and this route did not.

The same failure is named again at `services/proxy/src/xray-panel.ts:1-14` —
"Two copies would drift within a week, and the one that drifted would be the one
nobody was looking at" — and again in `CONTEXT.md` under the retired term
**Lane**. Three times, one disease.

`/_xray` is already the cure, shipped: `xray(slug)`
(`services/proxy/src/xray.ts:133`) returns one object and
`services/proxy/src/index.ts:86-98` renders it as a page or as JSON depending on
`Accept`. This design generalises that from the overlay to the whole page.

## Vocabulary

Settled during design and written into `CONTEXT.md`:

- **X-ray** — widened from "the layer over a live app" to "what an owner sees
  when they look inside their own app", reached two ways: over the live app, or
  as the app's own page. **One thing seen from two sides, never two things.**
- **Reading** — everything the X-ray shows about one app at one moment, as a
  single thing. Person and agent get the same reading; only the rendering
  differs. Every reading says what window it is true for.
- **Who did it** — *you*, *an agent*, *the platform*, or *someone* when nobody
  said. Never guessed.

Three words the glossary already banned are being shipped today and go away with
this work: `Cockpit.tsx:31` and `:161` ship **Settings** (banned under
**Secrets**); this document's earlier drafts said **panel** and **dashboard**
(both banned under **X-ray**).

## The page

**Canvas: the app in the middle, the timeline along the bottom, the reading's
things down the side, the door and who's here across the top.** Space in the
centre, time underneath, like a video editor.

The centre has four honest states, and no fifth:

| When | The centre shows | Why |
|---|---|---|
| Now, app answering | the live app, same origin | it is the thing, not a picture of it |
| Now, app never came up | the **room**, from the same `room-feed` | one drawer of that event, not two |
| Now, app serves no HTML | "nothing to show — this is an API" | `lilna` and `rtmsw` answer `/` with JSON |
| Rewound | a still, labelled a still | the old version is not running; it cannot be live |

**rewind ≠ undo**, and the glossary already said so (`CONTEXT.md`, **Timeline**):
moving along the timeline is *rewind*, going back to a version that worked is
*undo*. Rewind shows a picture and says it is one. Undo makes it real again —
and it is honest about costing more: `POST /api/apps/[slug]/rollback` works on
Cloud Run and returns **501** on a fleet app, because "a placement holds one
spec, not a history". That 501 stays. The two verbs diverge in price, and that
is a fact about the platform, not a flaw in the design.

**The strip's unit is a Build** — one attempt at shipping, per the glossary — not
a log line. A scrubber over the ~3,300 stored lines would be meaningless; a
scrubber over a few dozen builds is the app's versions.

## The reading

One object. Fields, and where each comes from:

| Field | Source | Status |
|---|---|---|
| `door` | `apps.run_url`, slug; multi-service prefixes in `apps.routes` (`db/008`) | exists |
| `open` | probe / `deploy-status` | exists |
| `here` | `xray().here` (`xray.ts:122`) — proxy memory | exists |
| `paths` | `xray().paths` — p50/p95/hits/errors, costliest first | exists |
| `secrets` | `GET /api/apps/[slug]/env` — **keys only, values never** | exists |
| `data` | `/db`, `/storage` | exists |
| `builds` | new `builds` table (below) | **new** |
| `lines` | `deploy_events` by `run_id` | exists, 7-day |
| `breaks` | `deploy_failures`, `/errors` | exists |
| `since` | mandatory, per half | partly exists |

**Every reading carries `since`, and it is two windows, not one**, because the
halves have genuinely different lifetimes: `here` and `paths` live in proxy
memory and die with a proxy release (§6.5 of the 2026-08-09 handoff); `builds`
are durable. A reading that presented them under one window would lie about one
of them.

**Two questions become three.** `CONTEXT.md` had **what happened** and **who's
here**; this adds **who did it**, which is the one Render has no answer to at
all.

## What has to be built

1. **`builds` — one durable row per attempt**: `run_id, slug, who, started_at,
   ended_at, outcome`. Today there is no such row anywhere: `deploy_runs` is
   deleted by `finishRun` the moment a build ends (it holds the app's secrets),
   and `deploy_stages` is one row per *stage* — it gained `run_id` on 6 Aug
   (`db/018`) but still cannot answer "who did this" or "list this app's builds"
   without a `GROUP BY`.
2. **`who` plumbed from the CLI**, declared explicitly. **Never inferred from a
   TTY** — CI has no TTY either, and we would report "an agent" where there was
   none. Undeclared writes `someone`.
3. **The reading assembler**, in the proxy, which already reads Postgres
   (`services/proxy/src/db.ts`) and already holds the live half in memory.
4. **The `Accept` split, with the fixes the research names**: the HTML branch has
   no cache headers at all today (`index.ts:24-27` writes only `Content-Type`) —
   it needs `Cache-Control: private, no-store` and `Vary: Accept, Cookie`, and
   `Vary: Accept` belongs on both branches. The existing test is on `text/html`
   rather than on JSON, which is the safe direction and must stay that way: a
   bare `fetch()` sends `Accept: */*` (Fetch Standard), including our own poll at
   `xray-panel.ts:116`.
5. **`readVisitor` accepts a bearer token** as well as the session cookie,
   resolving both to one user id and one return type, so the `Accept` branch
   never learns which was used. This is the fork the research found in Mastodon's
   controller.
6. **The HTML render takes everything from the reading.** `page.tsx:67-77`
   currently reaches past it for `describeService` on the Cloud Run path. That
   must move inside the assembler or the drift bug returns wearing a new coat.
7. **`/apps/[slug]` becomes a redirect**; `Cockpit.tsx` (302 lines) is deleted.
   The control plane keeps the app list and the account.
8. **Actions forwarded through the proxy** — `undo`, secrets, delete are
   control-plane routes; forwarding keeps the browser on one origin.

## What we are deliberately not building

MCP (agreed as next, still a README — §6.6 of the handoff). X-ray history or
minute rollups (§6.5). Per-build stills. `undo` on fleet apps. Access for anyone
but the owner's own agent.

## Honest degradations

Each is drawn as a fact, never as an empty state:

- A build older than seven days has no lines — `pruneEvents(days = 7)`, called
  at `api/deploy/route.ts:288`. The tick and the outcome survive; where the lines
  were, the page says the narration is gone. An empty list would read as "nothing
  happened".
- `here` and `paths` are only ever "since this proxy instance started".
- A rewound build has no still, so the centre shows the build's outcome rather
  than an image.
- `undo` returns 501 on fleet apps, in those words.

## Testing

Follows the pattern that caught three defects last session — tests written while
writing the thing. Specifically: one reading, two renderings, asserted to agree
field-for-field; `Accept: */*` gets JSON; an unauthenticated request gets
neither; a build with pruned lines renders the "narration gone" state rather than
an empty list; a `who` that was never declared renders *someone* and never *an
agent*.

## Known risks

- **The JSON becomes a contract silently.** No CLI reads any dashboard route
  today — verified — so the decision is still free. It is being kept as page
  internals **and that is being written next to the serialiser**, because the
  moment our own CLI depends on it, renaming a field in the markup becomes a
  breaking change.
- **Shipping without a settings index is unattested.** Linear, Notion, Figma and
  Slack all ship inline controls *and* an index; the research found no
  first-party account of anyone doing without. Apple's HIG argues for a partition
  by frequency-of-change, not abolition, and NN/g measured >20% lower
  discoverability for hidden navigation. Mitigation taken: the surface keeps a
  stable, deep-linkable address (`Cockpit.tsx:100-103`'s `?tab=` machinery
  already ignores unknown values) and loses only the nav item; and because the
  rare things are *fields of the reading*, "what have I never configured" is
  answerable — which a timeline structurally cannot do.
- **Billing stays account-scoped**, at `/settings`. It was never an app fact.
