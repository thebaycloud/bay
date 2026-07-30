# End-to-end deploy test — design

**Date:** 2026-07-30
**Goal:** Prove the deploy product works from a real user's account, on production, across
every lane that is switched on — and fix what it finds.

## Why this exists

Every previous round of this work reported success that production did not share. Tests
passed while the thing was broken at least four separate times: a warm dependency cache
published empty releases while reporting success, a `$` that needed doubling shipped in
Cloud Build YAML, telemetry was wired to a recorder nobody called, the static server was
deployed world-invokable while apps were meant to be sealed. Each was found by looking at
production, never by a passing test.

So this is not a unit test. It is a real account, real deploys, real URLs, and evidence
recorded per step.

## Preconditions

Two facts about production shape the run:

- **`GATING_ENABLED=1`.** Sign-in is allowlisted. `gmail.com` is not an allowed domain, so
  `ilmak1704@gmail.com` gets in only if that address was seeded into `allowed_signins` as
  an existing user at migration time. If sign-in is refused, add exactly that one address
  (an additive `INSERT`, no other row touched) and record that it was needed.
- **`RUNNER` is unset.** The prebuilt-runner lane is dark in production. It cannot be
  exercised by deploying normally, and turning it on for everyone mid-test is not
  acceptable. S10 covers it with a tagged, zero-traffic revision instead.

Authentication is the user's own step: they run `supersonic login` and pick the account in
their browser. No password is ever typed by the agent — this is a hard rule, not a
preference, and the loopback flow makes it unnecessary anyway.

## Scenarios

Each scenario deploys its own app and leaves it on the account, so the dashboard can be
inspected by eye afterwards.

| # | What it proves | Fixture |
|---|---|---|
| S1 | URL-first default: a link appears immediately, the app is live after | `examples/hello` |
| S2 | Static lane and its speed claim (12s changed / 1s unchanged) | a Vite build, `deploy --prebuilt` |
| S3 | Deploy from GitHub — the path the web UI uses | `deploy --repo <url>` |
| S4 | Postgres provisioning, `DATABASE_URL`, the locked-down runtime account | `examples/pgapp` |
| S5 | Environment and secrets | `examples/secretapp`, `supersonic env` |
| S6 | A broken project: does repair fix it, and if not, is the error legible | `examples/broken`, `examples/tsbroken` |
| S7 | Lifecycle of a live app | `redeploy`, `logs`, `status`, `rollback` |
| S8 | Privacy: a signed-out stranger cannot open a private app | curl at the domain and at the run.app URL |
| S9 | Thumbnails: one appeared, and it is a picture of the right app | download and look |
| S10 | The runner lane (optional) | tagged revision, `RUNNER=1`, no user traffic |

## What counts as a failure

- A live URL answers anything but 200.
- An app does not reach live within 5 minutes.
- No thumbnail within 2 minutes of the app going live.
- A signed-out request opens a private app.
- `rollback` does not restore the previous release.

Anything slower than its stated claim is recorded as a number, not a verdict — a slow
deploy is a fact worth having even when nothing is broken.

## Evidence

Every step records the command, the HTTP status, the elapsed time, and the resulting URL
into one log. Judgment calls — what a thumbnail actually shows, whether the dashboard
looks right — are made by looking, with the image attached.

A claim without a recorded status code or a downloaded artifact does not count as passed.

## Fixing what it finds

Findings are fixed as they appear: one commit per fix, pushed immediately, deployed to
production, and the same scenario re-run against the new revision. Commits are never
squashed.

## Not in scope

Load and concurrency, billing flows, the framework matrix beyond what these fixtures
cover, and the CDN work already deferred in the dashboard design doc.
