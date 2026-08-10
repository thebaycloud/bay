# The panel's fourth section — "What happened"

## Why

`/_xray` serves one object. `assembleReading` fills both halves of it: `live`,
which dies with a proxy release, and `builds`, which is durable and carries the
`who` column added on 9–10 Aug.

The panel renders only the first half. Its three sections — `Who's here`,
`Speed`, `Breaks` (`services/proxy/src/xray-panel.ts:65,79,102`) — all read
`d.live`. Nothing in the shipped panel reads `d.builds`, and nothing reads
`d.since.builds`.

So the durable half is assembled on every request, sent to every owner's
browser, and thrown away by the renderer. The question the `builds` table was
added to answer — *what happened, and who did it* — has no rendering at all.

This is the whole change: draw the half that already arrives.

## What it is not

Not a dashboard, not a new screen, not a prompt box, no model, no new
infrastructure, no new field in `Reading`. One section in one file, over data
already in the object.

## The section

Appended after `Breaks`, in the existing `sec()` idiom, using the host names the
panel already has (`h`, `sec`, `clock`, `C.slug`).

State is decided in this order, and the order matters:

1. **`d.builds` is absent** → "Reading…"

   `toggleXray()` paints a placeholder synchronously before the first fetch
   resolves (`xray-panel.ts:125`), and that placeholder carries no `builds` key.
   The alternative — inventing `builds: []` for it — would render "this app has
   never been built" for one frame, which is a lie about an app that has been
   built a hundred times. "Not read yet" is a third state and it gets its own
   words rather than borrowing another state's.

   This branch also makes the panel survive being handed an older-shaped object,
   which is the failure §4 of the 10 Aug handoff describes happening once already.

2. **`d.since.builds === "unreadable"`** → "Couldn't read this app's build
   history."

   `BuildsWindow` exists for exactly this and currently has no rendering
   anywhere. Today a database that will not answer and an app that has never been
   built both draw as nothing. That is the one thing every `since` in this
   codebase was written to prevent, and the panel breaks the rule the object
   keeps.

3. **`d.builds` is empty, window `durable`** → "No builds recorded for this app."

   A fact about the record, deliberately not about the app. The first wording
   here was "This app has never been built", which the window above does license
   — the read succeeded, the list really is empty. It was still wrong: the
   `builds` table began on 10 Aug, so every app older than it reads empty while
   plainly being built and running. Verified on production an hour after this
   shipped — `oh6sn` returned `since.builds: "durable"` with zero rows.

   That is the same substitution `since` and `BuildsWindow` were written to
   prevent, told one field further along: a gap in the record rendered as an
   absence in the world.

4. **Otherwise, rows** — newest first, which `listBuilds` already guarantees
   (`ORDER BY started_at DESC`). Capped at 8, matching `Breaks`.

### A row

`ago(startedAt)` · `who` · outcome.

Relative, not `clock()`. `clock()` renders `HH:MM` and is right for the live
half's "watching since", which is never more than one release old. Builds are
durable: `zpjsb` has been stuck since 2 Aug, and drawn by `clock()` it would read
"14:32" with no day attached. `ago()` currently tops out at hours
(`xray-panel.ts:50`), which was correct while it only described live traffic, so
it gains a days branch here — the first consumer with a long enough memory to
need one.

`who` is printed verbatim: `you`, `agent`, `platform`, `someone`. No mapping to
prettier words — the value's honesty is the point, and `someone` deliberately
means "nobody said". Per §5.1 of the handoff every production build reads
`someone` until `NPM_TOKEN` is replaced, so this section ships truthful and dull.
That is the correct order: the renderer is not the place to hide a credential
problem.

Outcome, from `outcome` and `endedAt` together:

| `outcome` | `endedAt` | drawn as | class |
|---|---|---|---|
| `ok` | any | `ok` | — |
| `failed` | any | `failed` | `bad` |
| `null` | `null` | `in flight, <elapsed>` | — |
| `null` | set | `ended, unrecorded` | `bad` |

The last row is not defensive padding. §4 of the handoff records that
`builds.outcome` was very nearly never written at all, and §5.3 records that a
dispatched-but-never-started build reads in-flight forever. If either recurs,
this section is where it becomes visible instead of reading as success.

`in flight` shows elapsed time rather than a spinner for the same reason: a build
stuck since 2 Aug should look wrong, not busy.

`linesGone: true` appends a muted `· lines pruned`, so an owner who finds no log
lines behind a build knows why.

### Two time helpers, not one

`ago(sec)` gains a days branch, per the row above.

`dur(sec)` is new, for `in flight, <elapsed>`: `ago()` renders "12m ago", which
is the wrong wording for a duration. Two lines, beside `ago()`.

## The two fixes that ship with it

**`xray-panel.ts:119` — `pullXray`'s `.catch(function(){})`.** Carried in §5.3 as
a known debt. It is not optional here: the panel is about to grow a branch that
reads a field the poll supplies, and this is the exact `.catch` that swallowed
the identical mismatch in §4 — a healthy 200 in the network tab and nothing in
the console. Replace with a `console.error`, and let the panel stop with a
reason. Nothing user-facing; the owner is a developer with a console open.

**The placeholder.** Left without a `builds` key, deliberately, and rendered by
state 1 above. The existing test at `xray-panel.test.ts:94` pulls that literal
straight out of `XRAY_JS` and runs it, so this stays honest without a new guard.

## Not in scope

- **The favicon noise in `Breaks`** (§5.3). The debt is real but its stated
  mechanism is wrong: §5.3 says favicon 404s will *top* the section, while
  `paths` are sorted by `p95` descending (`xray.ts:151`) and `Breaks` inherits
  that order, so a fast 404 sorts last. What is true is that when nothing else
  fails, favicon 404s are the entire section. Fixing that is a decision about
  what counts as an error, not a rendering change, and it does not belong in this
  pass. The handoff's §5.3 entry should be corrected separately.
- **Anything that changes an app.** Blocked on `finishRun`, which is a decision
  about secrets (§2).
- **The bar.** `✦ Supersonic · Live · Ask` is the form this content eventually
  moves into. This pass puts the content in the panel that exists; moving the
  frame is its own change and should not ride along inside a section diff.

## Testing

`xray-panel.test.ts` runs the shipped `XRAY_JS` against a fake host and asserts
only that it does not throw. Extend in the same style:

- a `Reading` with builds covering all four outcome states, including
  `linesGone`, built through `assembleReading` so the field names come from the
  real assembler and not from this document
- `listBuilds: async () => null`, giving `since.builds === "unreadable"` — the
  branch that has never had a renderer
- the existing placeholder test (`:94`) already covers the absent-`builds` state
  once state 1 exists; assert it explicitly rather than relying on the coincidence
- static guards matching the ones at `:104`: `d.builds` and `d.since.builds` must
  appear in the source, so a later edit cannot quietly drop back to drawing only
  the live half

## Scope

`services/proxy/src/xray-panel.ts` and `services/proxy/src/xray-panel.test.ts`.
No schema change, no change to `Reading`, and no change to either consumer:
`xray-page.ts:2` and `inject.ts:2` both import `XRAY_CSS` and `XRAY_JS` from the
panel, so the overlay and the standalone page get this from one edit. That is
what the file was made one thing for.
