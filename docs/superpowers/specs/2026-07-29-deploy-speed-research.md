# What is left to make deploys faster — research

**Date:** 2026-07-29
**Method:** 104 research agents across 5 angles, 749 source fetches; every claim put through
three independent adversarial verifications and killed on a 2-of-3 refute. Combined with
timings measured on this platform's own production deploys.

---

## Where the time actually goes

Measured, from `deploy_stages` and real deploys this week:

| Path | Total | Dominant stage |
|---|---|---|
| Static, prebuilt by the CLI, first deploy | 26 s | upload 5 s + verify 5 s |
| Static, prebuilt, output unchanged | 1-2 s | nothing — the upload is skipped |
| Static, prebuilt, output changed | 19-21 s | upload + verify |
| Static, built in the cloud (GitHub route) | 80 s | **build 59-77 s** |
| Container app + Postgres | 79 s | **Cloud Build + rollout 58 s** |

Two different problems. The static lane is already close to its floor. The container lane is
one 58-second block, and that is where the remaining money is.

---

## Confirmed: worth doing

### 1. Kaniko is a dead dependency, and the replacement is strictly better

**Confidence: high** (archival machine-verified; cache-mode behaviour 3-0 on four separate claims)

Kaniko — what we build container images with — was **archived by Google on 2025-06-03**. The
GitHub API returns `archived=true`; the README says "no longer developed or maintained".
Google's own "speeding up builds" page, which used to host a dedicated *Using Kaniko cache*
section, no longer mentions Kaniko at all.

This is not imminent breakage: the executor image still exists and `--cache=true` still works.
It is unpatched-CVE planning.

The replacement is buildx/BuildKit with `--cache-to type=registry,mode=max` pointed at an
Artifact Registry cache repo, and **the cache mode is the whole point**:

> "In min cache mode (the default), only layers that are exported into the resulting image are
> cached" — versus max, where "all layers are cached, even those of intermediate steps."

For a multi-stage Node build — a deps stage running `npm ci`, then a build stage — `min`
discards the `npm ci` layer, because it never lands in the final image. That is exactly the
layer that decides whether a source-only change re-runs the install. On a fresh VM per build,
with nothing persisted locally, that layer is the difference between a 60-second build and a
10-second one.

`min` is still the default: the PR to change it (moby/buildkit #5768) was closed unmerged in
February 2025. And the registry backend keeps cache separate from the app image, so
intermediate layers never bloat what Cloud Run has to pull.

**This is the single highest-value confirmed change available.**

### 2. Our own control plane spends seconds starting `gcloud`

**Confidence: high — measured directly here, not from the research.**

The control plane reaches GCP exclusively by shelling out to `gcloud`: 17 call sites in the
deploy route, 19 more in `lib/gcloud.ts`. Measured on this machine, **a bare `gcloud version`
costs 0.44-0.68 s before it does any work** — that is Python interpreter startup. On Cloud Run,
with a slower vCPU and a cold filesystem, it will be worse.

A prebuilt static deploy makes roughly six of these: resolve the slug, rsync, list objects, read
`index.html`, write the pointer, describe the static service. **Three to six seconds of a
26-second deploy is process startup**, and it lines up exactly with telemetry that shows "upload
5 s" and "verify 5 s" for work that moves a hundred kilobytes.

The fix needs no new architecture: `listBucketObjects` in the same file already does this
properly, over REST with an access token. The hot paths simply never got the same treatment.

---

## Confirmed: do NOT do these

The research killed four plausible ideas. Each would have cost real work for nothing.

**Cloud Build private worker pools.** They also scale to zero, bill per build minute, and
Google's own troubleshooting page attributes slow starts inside a private pool to "waiting for a
new virtual machine to start". A related claim — that private pools unlock machine types the
public pool cannot reach — was refuted 0-3.

**Cloud Run startup CPU boost.** Real, but near-zero here: it is now **default-enabled on new
services**, the Node-specific figure is "up to 30%" (the 50% headline is Java), and it touches
container cold start — our 9-second sealing tail — not the 58-second build.

**Startup probe tuning.** Cloud Run's *implicit* default TCP probe is a single attempt with a
240-second budget that resolves the moment the port listens. There is no 10-second polling
quantization to remove. The documented retry penalty applies only to services that explicitly
declare a probe and leave `periodSeconds` at 10 — ours do not.

**Second-generation execution environment.** Google documents gen2 as having *longer* cold
starts than gen1 for some services and explicitly recommends gen1 for cold-start-sensitive,
bursty scale-out workloads — the exact profile of a fresh revision starting from zero.

**`gcloud run deploy --async`** deserves its own line because it looks like a free win and is
worse than neutral: it returns before the rollout finishes, so the CLI would hand someone a URL
that still serves the **previous** revision for 20-58 seconds, with no error shown.

---

## The one big idea, and why it is not a config change

**Vercel's Hive is the existence proof that "warm" and "isolated" are compatible.** We rejected a
shared warm builder because `npm ci` runs `postinstall` scripts from a customer's
`package.json` — arbitrary customer code — and Cloud Build gives each build a fresh VM. That
reasoning was right, and the research confirms it independently: Kaniko's own maintainers state
Kaniko provides no isolation guarantee for untrusted builds.

But Vercel's answer is not a long-lived shared builder. From their engineering write-up: a pool
of **pre-warmed Firecracker microVM cells**, one cell per Firecracker process, a build starts
immediately if a warm cell is free, a cold cell provisions in about 5 seconds — and, critically,
**"once the build is complete, the cell is destroyed."** Pre-warmed but single-use keeps exactly
the fresh-VM property we refused to give up.

Worth noting how they attribute their own numbers: Vercel credits the speedup to pre-warmed
pools and local Docker image caching, **not to Firecracker itself**. Firecracker is the isolation
substrate that makes warm pooling safe, not the accelerator. The widely quoted "90s → 5s"
figure is scoped in the source to Secure Compute VPC provisioning, not to the build sandbox.

**Porting this to Google Cloud means self-hosting Firecracker on Compute Engine VMs with nested
virtualization.** Cloud Run and Cloud Build expose no KVM; private pools expose no user-managed
warm pool. Nested virtualization is unavailable on E2, AMD and Arm machine families, and Google
documents a >10% penalty on CPU- and I/O-bound work. This is owning a fleet, not changing a
flag. It is the clearest case in this research of a fast-platform technique that depends on
infrastructure we do not have.

---

## Deliberately unresolved

Two things did not survive verification **in either direction**, and should not be presented as
settled:

**Does image size matter to Cloud Run startup?** The claim that image streaming makes size
irrelevant was refuted 0-3 — which leaves size a *live but unquantified* lever, not a confirmed
one. No verified claim addressed eStargz/SOCI-style lazy layer loading at all.

**min-instances.** Refuted 1-2 as "the documented answer" for rollout latency, and economically
awkward for a multi-tenant platform anyway: one warm instance per customer app, billed
continuously, to fix a problem that is about rollout rather than the request path.

---

## Not covered by the research: the structural option

The research did not produce a verified finding on the fifth angle — shipping source onto a
shared runtime instead of building a per-app image — so what follows is our own reasoning, not
sourced.

The static lane went from 80 seconds to 26 by refusing to build at deploy time. The same shape
applies to the container lane: a Node server app does not need a bespoke image. It needs its
dependencies and its source on a runtime that already exists. A shared, already-warm Node
service that loads an app's bundle from GCS — the same way the static server loads a release —
would delete the 58-second block outright rather than shaving it.

The costs are real and would need their own design: tenant isolation moves from the container
boundary into the runtime, native modules stop working, and one runtime failure takes down
every app on it. It is the most valuable idea on this page and the least proven.

---

## Recommended order

1. **Kaniko → buildx/BuildKit with `mode=max`.** Confirmed, contained, and it fixes an
   unmaintained dependency at the same time.
2. **Replace hot `gcloud` shell-outs with REST.** Measured 3-6 s per deploy, no new architecture,
   the pattern already exists in the codebase.
3. **Fix the dependency cache that shipped broken** (`$` not doubled in Cloud Build YAML — caught
   and fixed by a colleague on 2026-07-29, but never executed successfully, so its actual benefit
   remains unmeasured).
4. Everything else waits on data from `deploy_stages`.

Do not spend a day on private pools, CPU boost, probe tuning, or gen2. The research says each is
inert, already on, or actively harmful here.
