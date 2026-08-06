# The fastest first deploy on the market

**Date:** 2026-08-06
**Status:** direction, approved. Decomposes into several plans; only the first is scoped here.
**Decision of record:** [`docs/adr/0001-fleet-is-the-only-target-for-server-apps.md`](../../adr/0001-fleet-is-the-only-target-for-server-apps.md)
**Vocabulary:** [`CONTEXT.md`](../../../CONTEXT.md) — fleet, node, placement, process.

## The goal, in the user's words

A new person points Supersonic at their app and thinks *"that was fast, and it was
not as complicated as I feared."* The measurable half is the **first deploy of a new
app**, and the target is to be the fastest in this market. Every shape is in scope —
Node, Python, an app with its own Dockerfile, an app with a database — each as fast
as its own physics allows, rather than one hero case optimised and the rest left.

The "not complicated" half is not separate scope. It is what speed feels like from
the outside.

## Where the time is now

Measured from `deploy_stages` this week. A first deploy is roughly 170–235 s, which
matches the 210 s p50 across all deploys.

| | first deploy | repeat |
|---|---|---|
| waiting for the deploy job to start | ~104 s | ~104 s |
| `build` | 41.1 s | 25.1 s |
| `deploy` (Cloud Run) | 89.7 s | 70.8 s |
| `fleet` (placement) | 25.1 s | 115.3 s |

Two things in that table are worth more than the totals.

**Placement is not the problem on a first deploy.** 25 s, the smallest part. The
first deploy is dominated by the 104 s handoff — already fixed by
[`2026-08-06-deploy-cold-start-design.md`](2026-08-06-deploy-cold-start-design.md),
which lands it near 30 s — and by the build.

**A repeat deploy is 4.6× slower to place than a first one**, and the mechanism is
known: the node builds its status report at the *top* of a reconcile pass, so a
process started during pass N is not reported until pass N+1, a full 10 s later; the
control plane then sleeps 5 s and polls every 5 s. That is 10–15 s of pure
sequencing added after the app is already visibly serving. It is ordering, not
physics.

## The shape of the answer

**Keep per-app isolation. Take the build out of the wait.**

The fastest first deploy would ship source onto a shared warm runtime and skip
images entirely — and it would trade tenant isolation from the container boundary
into the runtime, break native modules, and let one runtime failure take down every
app on it. That trade is refused.

Instead, the expensive part of the build moves to the machine that is already idle:
the user's. **The CLI installs dependencies locally and uploads them beside the
source; the node assembles the image from a prepared tree.** Dependency install is
the layer the `mode=max` cache exists for, and it is what decides whether a build is
40 s or 10 s.

Three things this deliberately is not:

- **Not building the image on the user's machine.** `packages/cli/lib/prebuilt.js`
  already refuses this in as many words — "we are not building images on someone
  else's machine" — and the arithmetic backs it: an image is hundreds of megabytes
  against a few for source, so a home connection would trade 41 s of server build
  for minutes of upload. Worse, the nodes are amd64 and most laptops are arm64, so
  the build would move from a fast datacentre machine to a slow local emulator.
- **Not a GitHub App that prebuilds on push.** It was the obvious way to have an
  image ready before the user asks — but the dominant path here is `supersonic
  deploy` from a folder, not a repository push, so it would serve a minority and
  cost an install step against the "not complicated" half of the goal.
- **Not applicable to apps with native modules.** Those keep the server-side build.
  Stating the exception is part of the design, not a gap in it.

## The finish line for the refactor

**Exactly one place in the code knows where an app runs.** Today the choice is a
boolean, `toFleet`, re-read at 16 sites inside a 4,253-line file, plus five
independent `runtimeOf()` checks in API routes that share no code with the pipeline —
21 decision points, none behind an abstraction. Of 14 named pipeline stages, 6 are
shared, 3 branch, and 5 are target-specific.

Done is that seam existing and the Cloud Run path removed behind it, for apps that
run a server. Speed is a separate goal measured separately, because a refactor by
itself buys no seconds.

## What must be fixed before any of it

Three findings from this session are independent of the refactor, small, and should
not wait for it.

1. **A deleted app's placement outlives it.** `fleet_placements` is keyed on
   `(slug, node)`, the delete route never calls `unplaceApp`, and `lib/gcloud.ts:666`
   states that five-character slugs *will* be re-issued — at which point
   `desiredFor`'s join finds a partner again and hands a node the previous tenant's
   spec. Latent, not live: no slug is known to have been reused. Full chain in
   [`docs/research/orphaned-placement.md`](../../research/orphaned-placement.md).
2. **The redeploy corroboration tail** — 10–15 s off every repeat deploy, by
   reporting from live state at send time instead of from the previous pass.
3. **The fleet has no working auto-rollback.** `rollBackToLastGood` is not gated on
   `toFleet`, so it silently no-ops for a fleet app that fails after taking traffic.

## What must be measured before the rest is designed

**Image pull and sandbox boot on the node are not instrumented anywhere the control
plane can see.** Every estimate of the floor — 25 s or 60 s — turns on that number,
and nobody has it. The same trap was hit with `job-cold-start` two sessions ago and
the answer was to measure first; it is the answer again. One stage around
`EnsureImage` and the sandbox start, surfaced into `deploy_stages`.

Two related reporting defects, found while researching, that make the table lie:
fleet deploys write **no `release` row at all**, and fleet apps still call
`createDomainMapping` against a Cloud Run service that was never created for them.

## Decomposition

Each becomes its own plan. Only the first is ready to write.

1. **Small fixes and instrumentation** — the three findings above plus the node
   timing. Independent of everything else, and the timing gates the rest.
2. **CLI dependency prebuild** — the CLI installs dependencies and ships them; the
   node assembles from a prepared tree. Needs the measurement from (1) to size the
   win honestly.
3. **The seam** — one deploy-target interface, 21 decision points collapsed to one.
4. **Deleting the Cloud Run path** for server apps, once (3) makes it removable.

## Done means

- A first deploy of a new app, in every shape we support, is faster than any
  competitor's equivalent — measured against
  [`docs/research/market-first-deploy.md`](../../research/market-first-deploy.md)
  rather than against a number we chose.
- Exactly one place in the code decides where an app runs.
- The node's image pull and boot are visible in `deploy_stages`, so the next
  argument about the floor is settled with data.

## The bar, from the market research

[`docs/research/market-first-deploy.md`](../../research/market-first-deploy.md) came
back while this was being written, and the honest summary is that **nobody publishes
a clean first-deploy-from-source number.** Vendor figures are about builds, not about
what a new user waits. What can be relied on:

- **Netlify**, after moving builds onto Firecracker microVMs, reports dependency
  install at **P50 2.5 s / P95 24.2 s** and queue wait at P50 1 s — vendor-measured
  percentiles, published 2026-04-09.
- **Vercel**'s Hive post reports a cold build cell provisioning in **5 s**, down from
  90 s, and separately shaves seconds off fixed platform overhead.
- **Railway** states that deploying a pre-built image takes "just a few seconds"
  because the build is skipped entirely.
- The loudest "in seconds" claims — Netlify Drop, Vercel marketing — are for static
  drops with no dependency install and no compile. That is our static lane, and it is
  already 26 s.

Two further findings change what "fastest on the market" can mean.

**The sub-second numbers in circulation are about the wrong thing.** Fly.io is candid
about it in its own materials: machine *start* is 10-150 ms, but machine *creation* —
which is what a first deploy actually is — runs to roughly 92 steps and can take
minutes. The fast number survives being quoted secondhand; the distinction does not.
Cloudflare Workers is genuinely fast for the no-build case, but by skipping
containers entirely for V8 isolates, which is a different product rather than a
faster version of ours.

**Nobody measures the part a new user actually waits through.** Database and resource
provisioning, account setup, OAuth, installing a Git app — no vendor in the survey
publishes a number for any of it. That is an industry-wide blind spot rather than one
platform's omission, and it is exactly the span this design targets. It means the bar
is lower than the folklore suggests, and that an honest, published, end-to-end
first-deploy number would itself be a thing none of them has.

Netlify's 2.5 s is the number that matters, because it is the same layer this design
moves to the CLI. **They got there by persisting the build cache on long-lived
microVM cells rather than by moving the work off the platform.** That is a genuine
alternative to the CLI prebuild, it keeps the work on hardware we control, and it
does not care whether the user has a laptop or a phone. It is more infrastructure
than we have. Recording it here so the choice is visible as a choice: if the CLI
prebuild proves awkward — native modules, lockfile drift, users on slow machines —
warm build cells with a persistent cache is the fallback, not a new idea.

## What this does not claim

No end-to-end number is promised. The node's own image-pull and sandbox-boot cost is
unmeasured, and it is the input that decides whether "fastest on the market" is a
week of work or a quarter. That measurement is the first plan's job. A spec that
named a target now would be naming a guess.
