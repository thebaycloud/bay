# Outreach — Build Plan

Internal growth tooling: `apps/outreach-extension` + `services/outreach` +
`services/outreach-agent`. Not part of the product, not on the product's
release cadence.

Phases are **sequence, not scope** — dependency order, same convention as
[`PHASES.md`](PHASES.md). Marked ⚡ = concentrated risk.

---

## What this is

Cold outreach on LinkedIn, run from the team's own accounts, with copy written
per prospect rather than templated. The pipeline:

```
source → enrich → qualify → generate → approve → drip → track
```

**The account is the asset.** Every design decision below is downstream of one
fact: a restricted LinkedIn account cannot be un-restricted, and it takes years
of legitimate use to build the connection graph that makes outreach work at all.
Throughput is never worth risking it.

### Non-goals

- **No headless browser, no session export.** Actions happen in the teammate's
  own logged-in tab, from their own IP and device fingerprint. Cookie export to
  a server is the single biggest restriction trigger and is off the table.
- **No scale beyond the team.** Caps are per-account and deliberately low.
- **Not a product.** No onboarding, no billing, no multi-tenancy beyond
  per-teammate accounts. If it ever becomes a product, that is a rewrite.

### The constraint that shapes everything

LinkedIn's User Agreement prohibits automation, and enforcement is real. The
mitigations are structural, not incidental: human pacing, hard daily caps,
working-hours-only execution, and a human approving copy before it sends.

---

## Status

**Phase 1 shipped, partly unverified.** Backend, schema, ingest, dedupe,
ownership, enrichment storage, and run history are built and exercised
end-to-end against a real Postgres. The extension loads, connects, and drives
the tab.

Verified: canonicalisation and dedupe (case, locale subdomain, relative href,
tracking params), ownership never transferring, auth rejecting bad tokens, CORS
rejecting unknown origins, first-name derivation.

**Not verified: the LinkedIn selectors.** Post-likers currently fails on a live
page. That is the whole of Phase 1.5.

---

### Phase 1 — Sourcing ✅ *(shipped)*

Prospect ingest with global dedupe by canonical profile URL · single-owner
claim so two teammates cannot work the same lead · scrape-run history as the
regression alarm · profile enrichment pass · side panel with health + diagnosis.

**Ships:** a prospect list that grows from four sources without duplicates.

---

### Phase 1.5 — Sourcing by agent, not by selector ⚡ *(current)*

Hand-written selectors were tried and abandoned. Two rounds of fixes against a
live page failed — evidence scoring and click-verification were an improvement
over an ordered CSS list, but the underlying problem stands: nobody writing this
code can see the DOM, and LinkedIn's markup varies by account, locale, and A/B
bucket.

`services/outreach-agent` replaces that path with Browser-Use. Tasks describe
the goal — "everyone who reacted to this post" — and the model reads the page.

- **Attaches to the teammate's real Chrome over CDP**, so session, cookies, and
  IP stay theirs. A fresh browser profile on an established account is a
  device-fingerprint change and among the strongest restriction signals there is.
- **Read-only contract** prepended to every task: no Connect, Follow, Message,
  Send, Like, React, Comment, Share, Accept, or form submission.
- **Structured output** (`output_model_schema`) so the model returns validated
  records rather than prose to parse.
- **Pacing enforced between agent steps**, not left to the model.
- **Partial pulls are explicit** — `reached_end_of_list` is reported, because a
  truncated scrape that reads as complete is how you wrongly conclude a source
  is exhausted.

**Cost:** each step is a model call carrying a page summary — cents per scrape
rather than fractions of one, and slower. That is the trade for never
maintaining a selector again.

**The extension keeps the panel, settings, and run history**, and remains the
send path in Phase 4. Its scraping code stays until the agent has proven itself
on all four sources, then comes out.

**Ships:** all four sources pulling from live LinkedIn without a CSS selector in
the loop.

---

### Phase 2 — ICP definition and qualification

Search is the weakest source, and the fix is targeting, not scraping.

- **ICP spec from plain English.** Describe the target; Claude produces a stored
  structured spec plus **concrete LinkedIn search URLs** — keywords, boolean
  strings, title and geography filters. URLs rather than driving the filter UI:
  LinkedIn search is query-string driven, so URLs do not rot the way DOM
  automation does.
- **The tuning loop.** Pull a 25-prospect sample, score each against the ICP with
  a stated reason, report precision, propose a sharper query. Iterate, *then*
  pull the full list. Tuning against real results beats guessing at filters.
- **Standing fit filter.** Every prospect gets a fit score and reason regardless
  of source. Below threshold never enters a campaign.

**Schema:** `icps(name, spec jsonb, queries jsonb)` ·
`prospects.icp_fit_score`, `prospects.icp_fit_reason`, `prospects.icp_id`.
**Endpoints:** `POST /icps` · `POST /icps/:id/queries` · `POST /icps/:id/tune` ·
`POST /prospects/score`.
**Ships:** describe an ICP in a sentence, get search URLs that return mostly
the right people, and junk never reaches a campaign.

---

### Phase 3 — Copy generation and the approval queue ⚡

Fully AI-generated copy, gated by a human until it earns trust.

- **Campaign brief** — ICP, offer, tone, hard rules, worked examples.
- **Batch generation** ahead of send, not at send time. `claude-opus-5`, low
  effort (short-form copy, not reasoning), brand brief in a cached system prefix.
- **Hard validators before the queue.** Length ceiling · banned phrases ("I
  noticed you", "Hope this finds you well") · **no claim about the prospect that
  is not present in their scraped enrichment** · no em-dash tells. A failure
  regenerates rather than reaching a human.
- **Approval queue** — approve / edit / reject, keyboard-driven, ~30 messages in
  two minutes. Edits are stored as training examples for the brief.

The gate exists because unreviewed generation at volume means the day a prompt
regression ships, 40 real prospects get slop under your name and you find out
from a reply. Flip to auto-send later, once you have watched it for a week —
that direction is reversible, the other isn't.

**Schema:** `campaigns.brief` already exists · `message_edits(message_id, before,
after)`.
**Endpoints:** `POST /campaigns/:id/generate` · `GET /messages/queue` ·
`POST /messages/:id/approve|reject|edit`.
**Ships:** a queue of per-prospect messages worth sending.

---

### Phase 4 — The executor ⚡ *(highest account risk)*

The first phase that touches another human being. Everything here is a safety
mechanism wearing a feature's clothes.

- **Send actions**: connection request with note, direct message to 1st-degree.
- **Pacing**: 30–90s jittered gaps, working hours in the account's own timezone,
  weekend taper.
- **Caps**: ~15 invites/day (under LinkedIn's ~100/week free-tier ceiling),
  ~40 messages/day, incremented **in the same transaction as the send** so a
  crash cannot lose a count and overshoot.
- **Runs only while a LinkedIn tab is open and the account is inside its active
  hours.** No background sending.
- **Kill switch**: pause an account or all accounts from the panel, instantly.
- **Pre-send re-check**: still not replied, still not connected, still approved.

**Schema:** `daily_counters` already exists · `accounts.paused_at`.
**Endpoints:** `GET /queue/next` · `POST /messages/:id/sent|failed` ·
`POST /accounts/:id/pause`.
**Ships:** approved messages actually going out, slowly, within caps.

---

### Phase 5 — Replies, stopping, and knowing if it worked

- **Reply detection** by polling conversation threads; a reply stops the whole
  sequence immediately. Getting this wrong means messaging someone who already
  answered — the worst output this system can produce.
- **Connection-accepted detection** to advance invite sequences.
- **Dashboard**: per-campaign sent / accepted / replied / positive, by source.
  The point is to learn that post-likers out-converts search by 5×, and to stop
  doing the thing that doesn't work.

**Schema:** `enrollments.replied_at` already exists · `reply_checks(enrollment_id,
checked_at)`.
**Ships:** sequences that stop themselves, and numbers that tell you which
source is worth your time.

---

### Phase 6 — Hosting and the second teammate

Trigger is not a date, it is the second person: `localhost:8081` only exists for
whoever runs the process.

- Dockerfile for `services/outreach` (the root one is web + deploy-agent).
- Cloud Run + `--add-cloudsql-instances`; drops `DATABASE_URL` for the socket
  path already in `db.ts`.
- Anthropic key in Secret Manager — Phase 2 forces this anyway.
- `ALLOWED_ORIGINS` unchanged: the extension ID is pinned in the manifest, so it
  is identical on every machine.
- Per-teammate accounts and tokens already exist; ownership already prevents
  collision.

**Ships:** teammates install the extension and work the same prospect pool
without stepping on each other.

---

## Cross-cutting

**Cost.** Negligible and not worth optimising. Generation at 100 messages/day is
~$1.50/day before caching; ICP scoring a few hundred tokens per prospect. The
brand brief clears Claude Opus 5's 512-token cache minimum, so real spend lands
lower. If this ever costs more than a rounding error, something is wrong.

**Selector rot was a permanent tax, so we stopped paying it.** Phase 1.5 moves
sourcing to an agent that reads pages instead of matching selectors. What
remains DOM-coupled is the Phase 4 send path, deliberately: a wrong guess on a
read is a bad batch, a wrong guess on a write is a message you cannot unsend.

**The audit trail is not optional.** Every action lands in `events`. When an
account gets a warning, the question "what exactly did we send, to whom, how
fast" needs an answer.

---

## What could kill this

1. **An account restriction.** Mitigated by caps, pacing, human-tab-only
   execution, and approval gating — but not eliminated. Do not raise caps
   because a week went fine.
2. **Reply rates that don't justify the build.** Most likely outcome if search
   is the main source. Post-likers and commenters are the hedge, which is why
   Phase 1.5 comes before anything else.
3. **Agent unreliability.** The trade made in Phase 1.5: no more selector rot,
   but the model can now misread a page, stop early, or cost more than expected.
   `reached_end_of_list`, `max_steps`, and the run history exist to make that
   visible rather than silent.
4. **Nobody uses it.** An internal tool with one user is a hobby. Phase 6 exists
   for a reason, and should not slip indefinitely.

## Open decisions

- **Auto-send after the trust period** — flip the approval gate off for
  follow-up steps first, or keep the human in the loop permanently?
- **Sales Navigator** — the source layer is pluggable; worth it only if search
  proves to be the main channel after Phase 2.
- **Where fit scoring runs** — at ingest (simple, scores everything) or at
  enrollment (cheaper, but a campaign can't reach back over old prospects).
