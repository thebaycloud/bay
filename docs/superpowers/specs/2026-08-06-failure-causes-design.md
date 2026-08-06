# Keep the reason a deploy failed

**Date:** 2026-08-06
**Status:** design, approved for planning
**Supersedes nothing. Follows `2026-08-06-deploy-cold-start-design.md`, which measured speed.**

## The finding, and a correction

This work began as "fix the 43% deploy failure rate". That number does not survive
contact with the data, and the correction matters more than the original claim.

Measured 6 Aug against `deploys`, with `classify` (`lib/deploy-errors.ts`) re-run over
every stored error:

| | deploys | failed |
|---|---|---|
| owner `d501e5d0…` — us | 80 | 23 |
| the other six owners | 9 | 0 |

**Every recorded failure is ours.** The 23 include `examples/broken` and `examples/tsbroken`,
which exist to fail. No other owner has failed a deploy. Nine deploys is far too small a
sample to call the platform healthy — it is an absence of data, not evidence of health —
but it is enough to say the reliability problem we set out to fix has not been observed
on a real user.

What the same query does show is a defect that is real, measurable, and blocks any future
reliability work:

- **Six of 23 failures carry no error text at all.** `classify` calls these platform
  failures with the reason "The deploy failed without saying why. That is a gap in our
  reporting, not in your code." It is right.
- **Three more are headers with no body** — `Build failed:` twice and `Prepare failed:`
  once, each with nothing after the colon.
- **Nine of the twelve app-blamed failures read `codex/opencode couldn't get it live after
  N redeploys`.** That is the repair agent's verdict, written over the original cause by
  `deploy-pipeline.ts:3959`. The failure that sent the deploy to the agent is gone.

So a quarter of failures never said why, and most of the rest had their reason overwritten
by the thing that was called in to fix it. "What breaks most often" is not answerable
today, and it will not become answerable by waiting for users.

This is the same shape the 5-6 Aug dogfooding session recorded: the runtime is in good
health, and the reporting surfaces are where the rot is.

### One structural fact behind the numbers

`classify` returns `app` as its **fallback**. Anything not matching a known platform marker
is blamed on the user's code and routed to the repair agent. An unrecognised platform
failure therefore arrives at an agent that cannot fix it — which is a plausible cause of
that agent's 41-failed-to-26-ok record, and is untestable while causes are being discarded.
This spec does not change the fallback. It makes the question answerable.

## What gets built

A table, `deploy_failures`, holding one row per failed **attempt** — not per app.

| column | why it is there |
|---|---|
| `run_id` | primary key. Migration 018 made this the id that stitches the route's stages to the job's; a failure belongs to the same attempt. |
| `slug`, `owner_id` | `owner_id` in the row, not behind a join: "ours or a user's" took a bespoke script to answer today, and that is the first question anyone asks. |
| `stage` | already computed — `stages.failedStage()`. |
| `cause` | the original error, first line intact. Never overwritten. |
| `blame` | `classify`'s verdict, recorded where it is acted on rather than re-derived later. |
| `repair` | `null` never attempted, `skipped` not Pro, `fixed`, `gave-up`. |
| `repair_summary` | the agent's verdict, beside the cause instead of on top of it. |
| `failed_at` | |

The difference from today is not that `deploys.error` is overwritten by the repair agent.
It is that `deploys` holds **one row per app**, so the next deploy discards the history
whether or not the agent touched it. A per-attempt table is what makes the record survive.

## Where it hooks in

One write site: `deploy-pipeline.ts:3856`, where `classify` returns its verdict — **before**
that verdict branches the flow. It is the only point at which the original cause is still
intact and the blame is known. The repair outcome then **updates that same row**; it never
inserts a second.

`setDeploy(slug, { status: "failed", error: fixed.summary })` at `:3959` stays as it is. For
the user, the current state of the app genuinely is the agent's verdict. Once the cause is
recorded elsewhere, that write stops being a loss.

## The three defects fixed alongside

1. **A blank cause survives.** `result.error ?? "deploy failed"` guards `null` and lets `""`
   through, because `??` does not test for blank. Substituting `"deploy failed"` would only
   trade one uninformative string for another. The rule for the new table is stricter: a
   blank cause is never stored. If the pipeline produced no reason, the row records the
   exact sentence **"no reason captured — this is a reporting gap, not a cause"**, so the
   gap is countable by one query rather than silent. That exact string, and no synonym:
   the Done-means below counts it, and two spellings would count as one gap and one cause.
2. **Header without a body.** `Build failed:\n${reason}` yields exactly `Build failed:` when
   `reason` is empty (`deploy-pipeline.ts:2842`, `:3385`, and `Prepare failed:` at `:3444`).
   Each becomes a sentence that states the reason was not captured — a different and
   findable claim.
3. **The overwrite** is closed by the table's existence.

## Constraints

- **Recording a failure may never fail a deploy.** Same rule as telemetry, wrapped the same
  way. A failure we could not record costs us the observation and nothing else.
- No backfill. The 23 historical rows keep what they have.
  `apps/web/scripts/failure-blame.ts` — the script that produced the numbers above — is
  committed, so the before and after are computed by one file. Same argument as
  `scripts/deploy-timing.ts`.
- Work on a branch. `main` deploys production on push.

## Testing

- The `blame` stored equals what `classify` returned for that error — asserted through the
  same function, not a copy of its rules.
- A blank or whitespace-only cause is stored as the explicit not-captured value, never `""`.
- The repair outcome updates the existing row; a failed-then-repaired attempt leaves exactly
  one row.
- A write that throws does not fail the deploy.
- The existing suite stays green (1155 tests, 1150 pass at the time of writing).

## Done means

- Over the next 20 recorded failures, **zero rows with a blank cause**, and the count of
  rows carrying the not-captured sentence is a number someone has looked at — it is the
  size of the remaining reporting gap, and a large one is the next piece of work rather
  than a success.
- Every row carries a blame.
- "What breaks most often, and whose fault did we say it was" is answerable in one query.
  Today it is not answerable at all.

## What this does not claim

It does not make deploys more reliable, and on the evidence there is no user-facing
reliability problem to fix yet. It makes the next reliability question answerable, and it
closes a reporting gap that would otherwise make every future answer wrong. The repair
agent's poor record — 41 failed against 26 ok, ten minutes each, on roughly a fifth of
deploys — stays open, and becomes diagnosable rather than merely visible.
