# The app workbench — design

19 Aug 2026. Replaces the in-app panel (`services/proxy/src/drawer.ts`) and the
control plane's Cockpit with one surface: a chat rail beside the running app, and
a dev mode holding the detail. Read `docs/HANDOFF-panel.md` first; this document
assumes it and contradicts it in several places on purpose.

---

## 1. What this is

`app.supersonic.cv/apps/<slug>` becomes a workbench with two modes:

- **Chat** (default) — you ask questions about your running app in words and a
  real coding agent answers them. The app renders beside the conversation.
- **Dev** — the panel's cell grid at full width, with the detail screens behind
  it, in the panel's design system.

The shape is Lovable's project view. The capability is deliberately not Lovable's:
chat **reads and answers, and changes nothing**.

### Why the panel moves

The panel today is injected into every hosted app's HTML as a string of source
inside a Shadow DOM. That existed because there was nowhere else to put it. There
is now: `apps/web/app/apps/[slug]/page.tsx` already renders a per-app page, and
putting the workbench there makes the data reads same-origin, retires the
generator, and takes the owner's dashboard out of the tenant's document.

---

## 2. Decisions, and why

Each of these was chosen over a stated alternative. The rationale is recorded
because the alternative will look attractive again later.

**Chat is read-only.** No env writes, no re-ship, no rollback, no code edits.
`HANDOFF-panel.md` §9 warns that an agent touching prod is the highest-trust
thing in this product; the first version earns trust before it spends it. The
action routes (`/exec`, `/fix`, `/patch`, `/rollback`) exist and are deliberately
not wired to chat.

**The workbench lives on the control plane, not the tenant hostname.** The
alternative — `<slug>.supersonic.cv/_dashboard` — would make the app frame
same-origin and readable. We do not need to read into the frame (no element
picking in this design), so that advantage buys nothing, while the control plane
gives us React, one home for every app, and same-origin API reads.

**Dev mode keeps the cell grid.** The alternative was a sidebar over the eight
sections. The grid plus push/pop is what exists, what was approved on canvas, and
what `cells.js`/`screens.js` already encode. A sidebar is a later refactor, not a
prerequisite.

**Every question runs a real agent.** The alternative was answering trivia from
the nine reads already in the browser and escalating on a miss. That needs a
router deciding which is which, and a router that guesses wrong either stalls a
cheap question or answers a hard one from stale data. One path, always honest,
with the work streamed so the wait reads as work.

**Codex drives, opencode stays one variable away.** The pattern
`lib/agents/index.ts` already established, for the reason its own comment gives:
the harness landscape moves faster than we can re-plan around it.

**The panel's design system becomes the house style.** Applied globally by token
swap, not page by page, so navigating between the workbench and settings has no
seam.

**Light mode only.** Dark is dropped rather than carried, because the panel design
system has no dark palette and inventing one to keep a toggle alive is work that
serves nothing anyone asked for.

---

## 3. Surfaces and routing

### The page

```
┌────────────────┬──────────────────────────────────────┐
│ ● l3sgp  live  │   [ Chat │ Dev ]     l3sgp…cv  ↗     │
├────────────────┼──────────────────────────────────────┤
│ ▸ you          │                                      │
│   how many     │   CHAT:  cross-origin iframe of      │
│   users?       │          l3sgp.supersonic.cv         │
│                │                                      │
│ ▸ ran db ·0.4s │   DEV:   the cell grid, full width,  │
│ ▸ 47 rows, 12  │          push/pop into screens       │
│   this week.   │                                      │
│   [ Data ↗ ]   │                                      │
├────────────────┤                                      │
│ Ask…        ⏎  │                                      │
└────────────────┴──────────────────────────────────────┘
```

The chat rail is persistent. It stays mounted across a mode switch, so an answer
can deep-link into a Dev screen without losing the thread.

Top-left is the status pill: app name and one state word, coloured by
`alert ? warn : shipping ? load : ok`. Top-right is the app's address, opening in
a new tab.

**Not built, deliberately.** A Publish button — we deploy on push to `main` and
there is no deploy-trigger route, so it would be dead, and this codebase's rule is
that a dead control is worse than none. A route dropdown — we have no route
manifest to fill it; the frame navigates by being used.

### The iframe

`app.supersonic.cv` framing `<slug>.supersonic.cv` is cross-origin but
**same-site**, both being subdomains of `supersonic.cv`, so the tenant's own
cookies still reach it and a logged-in app previews logged in.

The proxy must permit the framing:

- Send `Content-Security-Policy: frame-ancestors https://app.supersonic.cv` on
  tenant documents.
- Drop `X-Frame-Options` on tenant documents. It has no allowlist form, so a
  `DENY` or `SAMEORIGIN` from the app would refuse us and cannot be narrowed.

Both belong in the proxy's header path (`headers.ts` / `forward.ts`) beside the
existing injected-response header rules, and both apply only to documents we
would have injected into.

### What stays on the tenant hostname

**A status pill, and nothing else.** `inject.ts` keeps its owner detection —
`hasCredential(req)`, the §5 bug where making an app public deleted the owner's
dashboard — and keeps suppressing itself for `Sec-Fetch-Dest: iframe` so no pill
renders inside the preview. What it emits shrinks from a dashboard to a link:
app name, state dot, href to `app.supersonic.cv/apps/<slug>`.

The pill needs one fact beyond the name. It reads `/_xray` same-origin, as the
panel does today.

**`/_xray` keeps answering JSON, byte-for-byte.** It is baked into every page
already served and into agents' scripts (§6). `/_dashboard` stops serving HTML
and 302s to the control plane page; its JSON behaviour is unchanged.

`/_dashboard/analytics` stays where it is. It is owner-only, same-origin, and
answers the twenty-odd umami queries the Analytics screen needs; moving it would
make it cross-origin for no gain.

---

## 4. The chat engine

### Route

`apps/web/app/api/apps/[slug]/chat/route.ts` — `POST`, `runtime: "nodejs"`,
`maxDuration: 300`. Same-origin with the page, so no CORS and no
`credentials:'include'`.

Request carries the new question plus the prior turns of the thread. Response is
an SSE stream of normalised events. Ownership is checked with `currentUserId()`
and `ownsApp()`, as every sibling route does.

### The agent

Driven through the existing seam: `runAgent()` from `lib/agents/harness.ts`, a
backend from `agentName()`, `bareModel(MODEL)`. Two additions to shared code:

**`onEvent?: (e: AgentEvent) => void` on `RunOptions`.** The harness already
builds normalised `AgentEvent`s internally; today only `log(line)` escapes. This
exposes them so the rail can render tool calls as they happen. It belongs above
the backend seam, which is where `types.ts` says shared behaviour goes.

**`OpencodeBackend implements AgentBackend`.** Today `backendFor("opencode")`
throws, and opencode is reached through the parallel functions in
`opencode-deploy.ts`. Chat needs the switch to be real, and the seam already
specifies exactly what a backend owes: `seed`, `bin`, `argv`, `env`, `parse`,
`structured`. `structured` returns null, which is the documented meaning of "this
backend cannot constrain a final answer".

Budgets, as environment variables with these defaults: `CHAT_TIMEOUT_MS` 120000,
`maxCalls` 25, `repeatsAllowed` 3. Every run is recorded through
`recordAgentRun({ role: "chat", ... })`, so chat cost sits beside deploy cost in
`agent-usage`.

### Tools, and why they are files

The agent is a subprocess in a sandbox and needs a channel to ask us for data.
The obvious channel is a loopback HTTP server, which is what `bridge.ts` does for
redeploys. It cannot be used here.

`RunSpec.network` is one boolean covering all outbound access. Enabling loopback
enables the internet, and this agent reads tenant data that is partly
attacker-controlled — see §8. So the channel must not be network.

**File-based tool calls.** The workspace is seeded with one small script per
operation. A script writes a request file and polls for its answer; the route,
running outside the sandbox, watches the directory and answers.

```
agent runs:   ./db "select count(*) from users"
script writes .ask/003.json      { "op": "db", "arg": "select count(*) …" }
route answers .ask/003.out       { "ok": true, "rows": [ … ] }
script prints the answer; the agent carries on
```

The sandbox permits workspace writes by definition — repair mode edits files
there — so this works with `network: false` unconditionally. No sandbox
capability needs verifying.

Operations, all read-only:

Each operation is answered by calling the same library function its sibling API
route calls — the route does not issue HTTP requests to itself.

| Script | Reads |
|---|---|
| `db` | one `SELECT`, behind the same guard `/db` uses, which refuses anything else |
| `logs` | Cloud Logging, as `/logs` does |
| `errors` | Cloud Logging errors, as `/errors` does |
| `analytics` | umami, one window per call |
| `deploys` | latest deploy status and error |
| `keys` | env key **names**, never values |
| `access` | visibility, grants, pending requests |
| `live` | the edge reading: paths, p50, who is here, what is broken |
| `describe` | `describeService`: image, url, envKeys, cloudsql |

The whole tool surface is one file. There is no write operation to misuse, which
is a stronger guarantee than a prompt asking the agent not to.

### No repo

`svc.repo` is set only when a deploy carried a git URL, and the default deploy is
a folder upload from somebody's machine — `fix/route.ts` says so and diagnoses
without code. So chat answers about the **running app**, not its source. No
clone, no source plumbing, and answers about code are out of scope until repos
are retained.

### Multi-turn

Codex `exec` is one-shot. Follow-ups replay the prior turns in the prompt. The
client holds the thread; the route caps replay at the last 10 turns, because
token cost grows with thread length and an uncapped thread is an unbounded bill.
Threads are not persisted in this version — reloading the page starts fresh.

### What the rail renders

`AgentEvent` maps to the surface directly:

- `tool` → a compact row: operation, its argument elided to one line, elapsed.
- `text` → prose.
- `usage` → a token count on the finished turn, muted.
- `error` → the failure in words, with the question still in the composer so it
  can be retried without retyping.

**Numbers render from tool results, not from prose.** A figure appears as a mono
chip carrying the operation that produced it. An answer that states a number with
no tool call behind it is a bug, not a style preference — it is the only
mechanism separating an answer from a plausible guess.

Answers may end with a deep link into a Dev screen (`[ Data ↗ ]`), which switches
mode and pushes that screen without disturbing the thread.

---

## 5. Dev mode

The panel's home grid, at full width:

```
Address (full width)
Analytics | Ships
Data      | Keys
Infra     | Access
Agent (full width)
```

Cells show a live fact and push into a screen; the back affordance pops. This is
the behaviour `drawer.ts` has today, re-hosted in React.

**The nine reads become one server component plus client refresh.** Today
`dwLoad()` fans out nine browser fetches wrapped in `dwSoon` deadlines because it
runs inside the tenant page. On the control plane the page can read them
server-side and stream, which is what `page.tsx` already does with `Suspense` for
the Cockpit. The per-request deadline and fallback stay — the reason for `dwSoon`
was never CORS, it was that umami can be unreachable and one slow read must not
hold the page.

**Cockpit and its panels are absorbed, not kept.** `Cockpit.tsx` (302 lines) with
its tab nav, and `DatabasePanel`, `StoragePanel`, `JobsPanel`, `IssuesPanel`,
`DomainsPanel`, `SharePanel`, `AnalyticsCharts` — roughly 1,300 lines — already
implement much of what the screens show. Their data logic moves into the screens;
their chrome does not. Two parallel implementations of the same eight facts is
the defect this replacement exists to remove.

Screens not built, and honest about it, exactly as the panel is today: key health
(nothing records upstream call outcomes), ships history (no deploys-list route),
MCP (a slot that says it is not built rather than a config pointing at nothing).

---

## 6. The design system swap

`apps/web/app/globals.css` takes the panel's palette from
`services/proxy/panel/panel.css`:

```
--white:#FFFFFF  --ground:#FAFAFA  --tile:#F4F4F5
--ink:#0A0A0A    --ink-2:#737373   --ink-3:#A1A1AA   --line:#E5E5E5
--red:#E63F2C    --red-deep:#FC8779   --red-ink:#B32C1A
--tint:rgba(230,63,44,.10)   --green:#16A34A
--r-xl:8px --r-lg:6px --r-sm:4px
Geist Sans + Geist Mono
```

Everything already reads CSS custom properties, so the colour half is one file.
The control plane's current names (`--paper`, `--card`, `--faint`, `--accent`,
`--fill`, `--live`, `--grid`) are aliased onto the new tokens in the same block
rather than renamed across every component, so the swap is reviewable in one
diff and no component changes to receive it.

The rules that were argued for and must survive the move:

- **Green is not a second accent.** It is status. The control plane's accent is
  green today, so this swap is the rule being applied: accent becomes red, green
  narrows to live/ok.
- **Mono carries machine values and nothing else** — URLs, commands, counts, key
  names.
- **Ground `#FAFAFA`, cards `#FFFFFF`.** At white-on-white the border does all
  the work and the page flattens.
- **Headings 14px/400.** A cell's title must not outweigh the fact under it.
- **Segmented controls are a recessed track with a raised white thumb.** This is
  what `Chat │ Dev` uses.
- **No metal plates.** The workbench draws none; `btn()`'s plates were removed
  from the panel for making every owner's page fetch two images to draw a button.
  But `components/ds/Metal.tsx` and `ds/Button.tsx` **stay**: `Button` is built on
  `Metal`, and `components/landing/Hero.tsx` and `app/design/page.tsx` are built
  on `Button`. Deleting Metal breaks the landing page, which §10 puts out of
  scope. They keep working and the workbench simply does not use them.

### Dropping dark

- Remove the `@media (prefers-color-scheme: dark)` block and every
  `:root[data-theme=…]` selector from `globals.css` — including the `.share-pop`
  shadow and `.an-page` variants.
- Delete `components/ThemeToggle.tsx` and its five mounts: `app/page.tsx`,
  `app/new/page.tsx`, `app/admin/fleet/page.tsx`, `app/admin/analytics/page.tsx`,
  `components/Cockpit.tsx` (which is being removed anyway).
- `components/film/ship-it.js` grades itself from the page's `data-theme`. With
  no dark theme it must be pinned to the light grade rather than left reading an
  attribute that no longer varies.

### The motifs go too

The token swap changes colour and nothing else, because the blueprint system's
character is structural: mono-forward type, 90-degree corners, registration
brackets and a graph-paper substrate. Recoloured, those still read as the old
product. So they are in scope rather than deferred.

What changes, and the counts that say how big it is:

| Motif | Where | Scale |
|---|---|---|
| Mono type | `globals.css`, `styles/themes/blueprint.css` | 177 + 76 declarations |
| Squared corners | the same two files | `--r` is already aliased to 6px |
| Bracket corners | `components/Bracket.tsx`, `.bkt` rules | 5 uses, 19 rules |
| Graph-paper grid | `body` background, `--grid` | 14 references |
| Instrument Serif | `--serif` | 3 uses |
| Metal | `ds/Metal.tsx`, `ds/Button.tsx` | 3 files |

The rules that decide each case:

- **Mono carries machine values and nothing else** — URLs, commands, counts, key
  names, slugs, identifiers. Every other mono declaration becomes Geist Sans.
  This is the panel's rule, and it is what makes the 253 declarations a triage
  rather than a find-and-replace: roughly the `.mono`, `.eyebrow`, `.t-label` and
  `.t-micro` families keep it, headings and body lose it.
- **Headings are 14px/400.** The blueprint system's mono headings at 15px/600 are
  the single loudest remaining signal of the old product.
- **Corners are 8/6/4.** `--r` already aliases to `--r-lg`, so the squared look
  now comes from rules that set `border-radius: 0` explicitly, plus `<Bracket>`.
- **The grid goes.** A graph-paper substrate under `#FAFAFA` is either invisible
  or noise; the panel's ground is plain.
- **Brackets go.** `Bracket.tsx` is deleted, not restyled — its whole purpose is
  drawing right-angle registration marks.
- **Serif goes.** The panel system is one typeface family, Geist Sans and Geist
  Mono, and a third face is the thing that makes a page look assembled.
- **Metal goes, at last.** `ds/Metal.tsx` and `ds/Button.tsx` can only be deleted
  once `components/landing/Hero.tsx` and `app/design/page.tsx` stop using them,
  so those two move to a flat button first. `public/metal/*.webp` goes with them.

`app/design/page.tsx` is the design system's own reference page and is largely
about Metal and brackets. It is rewritten to show what the system actually is
now, rather than deleted — a house style with no page describing it drifts.

### The cost of retiring the generator

`compose.py`, `slice.py`, `drawer.ts` and the JS slices go; the components become
TSX. `HANDOFF-panel.md` §1 exists because that component code is the recovered
prototype's **own source, sliced rather than retyped**, and slicing is what kept
the design from drifting from what was approved. Porting to React gives that up.

Accepted, with the drift guard moved rather than removed: the tokens above pin
the palette and type, and `~/dev/recovered-bay-panel/panel-preview.html` renders
the shipping panel for side-by-side comparison during the port. The port is
reviewed against that page, not against a line range.

Two hazards disappear with the generator, both artifacts of shipping source as a
string, and neither expressible in React: the backtick inside `String.raw` that
made `DRAWER_CSS` the string `NaN`, and the global named `top` that silently
killed the whole script. Their tests go with them.

---

## 7. Build order

Each step lands green on its own.

1. **Token swap + drop dark.** One CSS file, plus deleting `ThemeToggle` and its
   mounts and pinning the film's grade. Nothing structural, and nothing in
   `ds/` is deleted. The control plane turns neutral-and-red before any new
   surface exists. `apps/web/app/landing` and `/design` shift colour with
   everything else while keeping their metal buttons. `apps/landing` is a
   SEPARATE Next app with its own `globals.css` and no cross-app imports, so
   nothing here reaches it.
2. **The motifs.** Mono triage across the two stylesheets, headings to 14px/400,
   corners to the 8/6/4 ramp, and the grid, brackets, serif and Metal removed.
   `Hero.tsx` and `app/design/page.tsx` move off Metal first so it can go. Lands
   before the shell, so the new surface is built on the finished system rather
   than being restyled underneath later.
3. **The workbench shell.** `apps/web/app/apps/[slug]/page.tsx` becomes the
   two-pane layout with the `Chat │ Dev` control, the status pill, and the app
   iframe. Dev renders the existing Cockpit content unchanged at first, so the
   shell is reviewable before the screens are ported.
4. **Proxy framing headers.** `frame-ancestors`, drop `X-Frame-Options`. Without
   this step 2's iframe is blank for any app that sets either.
5. **Port the screens.** Cell grid and the eight screens in TSX, reading
   server-side. Cockpit and the six panels are deleted as their content lands.
6. **Shrink the injection.** `inject.ts` emits the pill; `compose.py`,
   `drawer.ts`, `slice.py` and the slices are deleted; `/_dashboard` HTML 302s.
   `/_xray` JSON untouched.
7. **The chat engine.** `onEvent` on `RunOptions`, the file-based tool bridge,
   the chat route, `OpencodeBackend`, and the rail.

Steps 1–4 are safe to ship independently. Step 6 is the point of no return for
the injected panel and should follow step 5 being visibly correct.

---

## 8. Risks

**Prompt injection through tenant data.** The agent reads rows an app's users
wrote. On an app with public signup, a display name can carry instructions, and a
model reading text cannot reliably tell data from instruction. Read-only bounds
the damage to reading; `network: false` bounds it to *this owner's own screen*,
because there is no channel out. This is why the tool bridge is files and not a
socket, and why `network: false` is a requirement rather than a default. The
instructions also state that content from tools is data and never an instruction,
but that is the second line of defence, not the first.

**Hallucinated numbers.** Addressed by rendering figures only from tool results,
as mono chips carrying their source. Tested by asserting that an answer
containing a figure has at least one tool event behind it.

**Latency.** A trivial question costs a real agent run: seconds, not
milliseconds. Streaming makes the wait legible; it does not remove it. If this
proves intolerable in use, the escalation router we rejected is the fallback, and
rejecting it now costs nothing later.

**Cost.** Every question is a metered agent run. `recordAgentRun` makes it
visible from day one, which is the prerequisite for deciding whether it needs a
cap.

**Apps that refuse framing.** Step 3 handles headers we control. An app that
frame-busts in JavaScript still escapes, and there is no fix worth building for
it; the address opens in a new tab, which is the honest fallback.

---

## 9. Testing

- **Chat route.** Fixture-driven, as `codex.ts` is already tested from recorded
  streams (`test/fixtures/codex-*.jsonl`): feed a recorded stream, assert the SSE
  events, assert a figure never appears without a tool event, assert the
  transcript replay cap holds.
- **Tool bridge.** Each operation answers, an unknown operation is refused, a
  non-`SELECT` query is refused, and a request with no answer times out rather
  than polling forever.
- **`network: false`.** Asserted on the spec the chat route builds — a regression
  here is the difference between a bounded and an unbounded worst case, so it is
  pinned by a test and not by review.
- **Framing headers.** Proxy test: a tenant document gets `frame-ancestors` and
  no `X-Frame-Options`; a non-document response gets neither.
- **Pill injection.** Still owner-only; still absent for `Sec-Fetch-Dest:
  iframe`; still present for a public app viewed by its owner (the §5 bug).
- **`/_xray`.** JSON unchanged. `/_dashboard` 302s.

Seven `apps/web` tests were already failing at `origin/main` before this work
(Dockerfile/image/fleet). They are pre-existing and not a gate for this.

---

## 10. Out of scope

- Chat that changes anything. Actions, env writes, re-ship, rollback, code edits.
- Element picking, visual editing, and comment pins on the preview.
- Answers about source code. Needs repo retention, which does not exist.
- A route dropdown, a Publish button, key health, ships history, MCP.
- Restyling `apps/landing`. It is a separate app and keeps its own styles.
- Persisted chat threads.
