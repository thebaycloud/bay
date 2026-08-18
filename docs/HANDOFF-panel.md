# Handoff — the app panel (the in-app dashboard)

Written 18 Aug 2026 at the end of a long session. Read this before touching
`services/proxy/src/drawer.ts` or anything in the injection path.

---

## 1. Read this first, or you will lose work

**`services/proxy/src/drawer.ts` is a GENERATED file.** It is built by
`services/proxy/panel/compose.py` from the sources beside it:

```
services/proxy/panel/
  compose.py     the generator — run it, don't read drawer.ts to understand the panel
  panel.css      the stylesheet (tokens, cells, screens, controls)
  layer.js       the data layer: fetching, the model, render loop, actions
  icons.js helpers.js atoms.js cells.js feed.js screens.js nav.js titles.js
                 component code SLICED from the recovered prototype, not retyped
  slice.py       how those slices were originally cut out of the prototype
```

Rebuild with:

```bash
python3 services/proxy/panel/compose.py     # writes services/proxy/src/drawer.ts
```

Editing `drawer.ts` by hand works right up until someone runs that, at which
point the edit is silently gone. The file carries a header saying so.

**Why it is generated:** most of the component code (`cell`, `li`, `pad`, `btn`,
`bars`, `screen`, `homeScreen`) is the recovered prototype's OWN source, cut out
by line range and renamed where it collided. Slicing rather than retyping is what
keeps the design from drifting away from the one that was approved.

---

## 2. What the panel is

An owner-only dashboard **injected into every hosted app's own HTML**, rendered
inside a Shadow DOM so neither side's CSS reaches the other. Same code is also
served as a standalone page at `<slug>.supersonic.cv/_dashboard` (and `/_xray`,
kept as an alias — see §6).

Home is a grid of cells:

```
Address (full width)
Analytics | Ships
Data      | Keys
Infra     | Access
Agent (full width)
```

Each cell shows a live fact and pushes into a screen. `Address` and `Agent` are
the bookends — where it lives, and how you work on it.

### Where it came from

The design is a prototype called `bay-panel` / `site/index.html`, built 12 Aug in
a session named `baycloud-dashboard`, and **lost** — it was written to a
`/private/tmp` scratchpad that macOS wiped. It was recovered from that session's
transcript: the last full `Write` plus a chain of eight Python patch scripts,
replayed in order. All revisions are preserved at `~/dev/recovered-bay-panel/`
(outside the repo). `site-index-v3.html` matches the screenshot that started the
hunt; `v5` is the last state and is what shipped.

---

## 3. Architecture, and the three rules that are load-bearing

`services/proxy/src/inject.ts` splices the panel into every hosted app's HTML
before `</body>`. Three properties exist for stated reasons — do not weaken them:

1. **Owner code is emitted as SOURCE only for owners** (`owner ? OWNER_JS : ""`).
   A visitor must not be able to read the panel out of the page and learn a
   private surface exists.
2. **CORS is exactly one origin.** The panel runs on `<slug>.supersonic.cv` and
   calls `app.supersonic.cv/api/apps/<slug>/*` with `credentials:'include'`.
   `apps/web/lib/cors.ts` allows that app's origin and nothing else. Its comment
   documents a real cross-tenant account-takeover a wider allowlist would open.
   **Never allow `*.supersonic.cv`** — every one of those origins is a tenant's
   own JavaScript.
3. **Flat mode.** `buildDrawer(true)` renders the same component as the body of
   the standalone page. Any change must keep serving both.

### The data model

`dwLoad()` fans out **nine** reads in parallel, on idle, before the panel is
opened, so home can show a fact per cell without six spinners:

| Source | Gives |
|---|---|
| `/api/apps/<slug>/share` | visibility, grants, requests |
| `/env` | key names |
| `/db` | tables + row counts |
| `/storage` | object count |
| `/jobs` | scheduled jobs |
| `/deploy-status` | the latest deploy |
| `/analytics` | whether analytics is ON |
| `/agent` | CLI tokens + `last_used_at` |
| `/_xray` (same-origin) | live half + the audience half |

Every one is wrapped in `dwSoon(p, ms, fallback)` — **a per-request deadline with
a fallback**. See §5 for why that is not optional.

---

## 4. Design system (decided on a canvas, 18 Aug)

shadcn neutral with the brand red as the single accent. Tokens live in
`panel.css`:

```
--white:#FFFFFF  --ground:#FAFAFA  --tile:#F4F4F5
--ink:#0A0A0A    --ink-2:#737373   --ink-3:#A1A1AA   --line:#E5E5E5
--red:#E63F2C    --red-deep:#FC8779 (borders)  --red-ink:#B32C1A (text on tint)
--tint:rgba(230,63,44,.10)   --green:#16A34A
--r-xl:8px --r-lg:6px --r-sm:4px
Geist Sans + Geist Mono
```

Rules that were argued for and should not be casually undone:

- **Green is NOT a second accent.** It is reserved for status. If red also meant
  "running", nothing would be left that means *something is wrong*, and the alert
  state is the one thing that must be unmistakable. Red = brand + data. Green =
  live.
- **Mono carries machine values and nothing else** — URL, commands, counts, key
  names. That boundary is what stops a value reading as a label.
- **Ground is `#FAFAFA`, not white.** Cards are `#FFFFFF`. At white-on-white the
  border does all the work and the panel flattens.
- **Headings are 14px/400.** At 18px/500 a cell's title outweighed the fact under
  it, which is backwards for a panel whose whole job is the fact.
- **Segmented controls are a recessed track with a raised white thumb** — not
  four buttons with dividers and an ink-filled selection.
- **No metal plates.** The prototype's button was two `.webp` plates cross-fading
  under the cursor. Removed: it made every owner's page fetch two images to draw
  a button. `btn()` still builds the elements; they are `display:none`.

Design canvases (Artifacts, editable):

- four directions: `claude.ai/code/artifact/283860b6-718b-46d3-ace2-9af4b6b9e827`
- the chosen one, built out: `claude.ai/code/artifact/b40f9cdf-8d75-4f4c-a54d-04a490b2da9b`
- sources at `.design/c/` and `.design/panel/` (`.dc.html` + `canvas.json`)

---

## 5. Bugs that reached production. Do not reintroduce these.

Each cost real time. Every one was invisible to typecheck and to tests that
answer instantly.

**A backtick in a comment made the stylesheet the string `NaN`.**
`DRAWER_CSS` is carried to the browser inside a JS template literal. A comment
containing `` `*` `` closed the string early, so the browser evaluated
`"…sit on " * ", which…"` — string × string — assigned `NaN` to the stylesheet,
and rendered the whole panel unstyled 6,000px down the page. It parsed, it ran,
it threw nothing, the console was clean. **Nothing that goes inside `String.raw`
may contain a backtick or `${`.** `compose.py` asserts this; a test evaluates the
script and reads the stylesheet back.

**A global named `top` silently killed the script.** `top`, `self`, `parent`,
`closed`, `length` are `[LegacyUnforgeable]` on `Window` — a global with one of
those names makes the WHOLE script fail to evaluate, with no error. This is what
broke the recovered prototype originally. Pinned by a test.

**304 passthrough made four deploys invisible.** The overlay is added AFTER the
app produces its HTML, so the app's ETag describes a body the browser never gets.
The browser cached the injected page, revalidated, the app said 304, a 304 has no
`content-type` so `isHtmlDocument` was false, injection never ran, and the browser
kept showing the stale body — forever, for a landing page. Now: conditional
headers are stripped when we intend to inject, and injected responses drop
`ETag`/`Last-Modified` and go out `private, no-cache` (**private** because the
owner's toolbar must never reach a visitor from a shared cache).

**Making an app public deleted the owner's dashboard.** The public branch passed
`false` for ownership unconditionally. Skipping the sign-in *wall* is not the
same as refusing to know who is there. Fixed via `hasCredential(req)` — a header
lookup and cookie parse, so anonymous visitors still pay nothing.

**Twenty reads raced to log in.** `authToken()` cached the token but not the
ATTEMPT. The full analytics read makes ~20 parallel calls; on a cold token all
twenty hit `/api/auth/login`, and umami checks the password with **bcrypt**.
Everything timed out. The login is single-flight now.

**Fonts 307'd to `/login`.** `middleware.ts` exempted static assets by extension
and listed `webp` but not `woff2`. A font that fails to load is not an error
anyone sees — the browser follows the redirect, gets HTML, and falls back
silently.

**The panel hung forever.** `Promise.all` with no deadline; `/_xray` reaches
umami, which `reading.ts` itself says can be unreachable. Hence `dwSoon`.

**`stage` is not `status`.** `deploys.ts` has no `'done'` stage — `status` is
`live | building | deploying | pending | failed | canceled`, and `stage` holds
the last step that ran. Reading stage for doneness left every finished app saying
"Shipping" forever.

**Lesson worth keeping:** four wrong theories were argued from response sizes and
inference before anyone instrumented. `forward.ts` now logs the overlay decision
(owner, badge, content-type, bytes added, the app's CSP) **for documents only**.
Use it. Read the logs instead of reasoning:

```bash
gcloud logging read 'resource.labels.service_name="supersonic-proxy" AND jsonPayload.ev="overlay"' \
  --project supersonic-deploy-prod --limit 5 --freshness=20m
```

---

## 6. Naming

The panel stopped being an "x-ray" when it could do things rather than only show
them. The button says **Dashboard**, the tab says `<slug> — dashboard`, and the
page answers on **`/_dashboard`**. `/_xray` still works and must keep working —
it is baked into every page already served and into agents' scripts.

---

## 7. Deploy

Push to `main` deploys both, via OIDC from GitHub — no local gcloud needed.

- `deploy.yml` → control plane, on any push (~7 min)
- `deploy-proxy.yml` → proxy, on `services/proxy/**` (~2 min)

Verify with `gh run list`. The proxy is `supersonic-proxy` in
`supersonic-deploy-prod`, region `us-central1`.

Test app: **`l3sgp`** (a Speko landing page, Next.js App Router). It is currently
**public** — set from the panel's Access screen and never set back. That matters:
public + owner is the exact combination that was broken in §5.

---

## 8. What is NOT built

- **The toolbar.** Still the old dark bar with square buttons, sitting above the
  new panel — the last thing that looks like the previous product. It is also
  the only way in: a button labelled "Dashboard" you must already know about.
  The prototype opened from a white status pill showing app name and state, which
  is both better looking and self-explanatory. **This is the obvious next job.**
- **Key health.** The Keys screen says *"we can tell you whether a key works,
  because we watch your app use it."* Nothing does. It means recording upstream
  call outcomes in the proxy — proxy work, not UI.
- **Ships history.** `deploy-status` returns only the latest deploy. No
  deploys-list route, and no deploy-trigger route (which is why there is no
  re-ship button — a dead control is worse than none).
- **MCP.** The Agent screen has a slot for it and says, in words, that it is not
  built — deliberately, rather than emitting a config that points at nothing.
- **Sessions** (umami's nearest thing to replay: visitor list + per-session
  activity). Umami has **no session replay**; it does not exist in the product.

---

## 9. Strategy discussed (opinions, not decisions)

**Integrations.** The list (cli, mcp, cursor, claude, chatgpt, github, slack,
telegram, imessage) is three different products. **MCP collapses cursor/claude/
chatgpt/copilot into one build** — they all speak it; building per-tool is
building the same server with different logos. iMessage has no API (Mac relay
hacks) — wrong bet. Slack and Telegram are one notification abstraction with two
adapters. **Missing and more important: custom domains** (nobody ships on
`slug.supersonic.cv`), transactional email, and auth for tenant apps.

Suggested order: CLI+MCP → custom domains → GitHub deploy-on-push → email/auth →
chat notifications.

**Next two features.** Of "database & storage viewer" vs "observability + prod
agent":

- **Observability is ~70% built already** — `xray.ts` (edge metrics), `/logs` and
  `/errors` (Cloud Logging), umami, and **a repair agent already exists**
  (`lib/agent.ts`, a Gemini tool-use loop, plus `lib/agents/`, `repair-diff.ts`,
  and `diagnose`/`fix`/`patch` routes). It fires on **failed deploys**, not on
  running symptoms.
- The two real gaps: **frontend runtime error capture** (you have page views and
  zero JS error capture — the most common way a vibecoded app dies, and invisible
  today because the request returned 200 while the page broke), and **pointing
  the existing agent at prod symptoms** rather than build failures. The panel
  already knows `/checkout has been failing for 14m`; nothing acts on it.
- The DB viewer is table stakes and a deep well. If built, scope it as *"what did
  my app store"* — inferred relationships, plain English, ask-a-question — not a
  SQL client. **Keep it read-only**; `/db` already refuses anything but a single
  `SELECT`.
- **Warning:** an agent that watches prod and proposes patches is the
  highest-trust thing here. Observe-and-suggest only, never auto-apply, until it
  has earned it. `agent.ts` today runs on an already-broken app, where the
  downside is bounded. Prod is not that.

---

## 10. Loose ends

- `l3sgp` is **public** (see §7).
- An old session's transcript contains **live Stripe secret + webhook secret +
  GitHub OAuth client secret in plaintext**
  (`~/.claude/projects/-Users-arsenkylysbek-Desktop-supersonicdeploy/9c8ac09a-*.jsonl`,
  27 Jul). Worth rotating.
- `~/dev/recovered-bay-panel/` holds every recovered prototype revision plus a
  `panel-preview.html` that renders the real shipping `DRAWER_CSS`/`DRAWER_JS`
  against stubbed endpoints. Regenerate it from `/tmp/preview.mjs` if it drifts;
  serve with `python3 -m http.server 4321` from that directory.
- Seven `apps/web` tests were already failing before any of this work
  (Dockerfile/image/fleet); confirmed by running them at `origin/main`.
- Everything above is deployed and green: **178 proxy tests pass.**
