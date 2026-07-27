# Fast deploys — design

**Goal:** cut a first deploy from click to live URL from ~2 minutes to well under one,
by splitting one pipeline into three lanes and attacking the parts that are slow for a
project we have never seen before.

**Status:** approved 2026-07-27. Supersedes nothing; extends the existing deploy route.

---

## Why the current pipeline is slow

Measured against production, on the `hn9ll` deploy of 2026-07-27:

| Stage | Time |
|---|---|
| Cloud Build queue | 57 s |
| Kaniko build (cold cache) | 72 s |
| Image handoff to Cloud Run | 5 s |
| Revision rollout to Ready | 21 s |
| **Build submit → live** | **2 m 35 s** |

On top of that, before the build is even submitted: `/api/detect` clones the repo and runs
the detector, then `/api/deploy` clones the same repo and runs the detector *again*, and
the database and bucket are provisioned in sequence with everything else.

The 57 s queue was a self-inflicted wound — `cachedBuildConfig` asked for
`machineType: E2_HIGHCPU_8`, and a non-default machine makes Cloud Build provision a
dedicated worker instead of using the pre-warmed pool. Across the last 20 builds in this
project the split is exact: all six `E2_HIGHCPU_8` builds queued 44-57 s, all fourteen
default-pool builds queued 1 s. Removed in commit `2844d95`; the rest of this document
assumes it is gone.

That leaves roughly two minutes, and about 95 s of it is structural: every deploy, however
trivial the app, assembles a container image, pushes it to Artifact Registry, creates a
Cloud Run service and waits for a revision to pass its health check.

## The load-bearing constraint

**First deploys are the priority.** That rules out the obvious optimisation. Kaniko's layer
cache keys `RUN npm ci` on the lockfile hash, which is excellent on a redeploy and worth
exactly nothing the first time we see a project — we have never seen that lockfile.

So the caching has to be of things *shared between projects*, not of a project's own
previous build. That single constraint shapes the whole design.

## Architecture: three lanes

The detector picks the lane. One hard override sits above the rules: **a project that ships
its own `Dockerfile` always takes the container lane**, whatever the detector thinks. The
author was explicit; we do not second-guess them.

### Static lane

For `Vite (SPA)`, Create React App, `Astro` without an SSR adapter, Next.js with
`output: 'export'`, and plain static folders.

Cloud Build installs dependencies and runs the production build. Then the pipeline stops
being a container pipeline: the contents of the output directory are uploaded to GCS and a
release pointer is flipped. No image is assembled, nothing is pushed to Artifact Registry,
no Cloud Run service is created, no revision rolls out, no health check is awaited.

### Fast lane

For Next.js, Node/Express, FastAPI and Django. A container is genuinely required, but it is
built as a thin layer over a prebuilt base image that already carries the runtime, the
system packages, and a warm package cache for that stack.

### Generic lane

Everything else, and anything with its own `Dockerfile`. Today's pipeline, unchanged, but
it still gets the cross-cutting accelerators below.

## Cross-cutting accelerators

**Provisioning runs concurrently with the build.** Creating the database and the bucket does
not depend on the build and has no business waiting for it.

**The repo is cloned once.** `/api/detect` keeps its clone and returns a token; `/api/deploy`
reuses it. A token miss — different control-plane instance, expired entry — falls back to
cloning again. This is an optimisation, never a correctness requirement, and it must be
impossible for a miss to fail a deploy.

**A regional npm mirror.** An Artifact Registry remote repository proxying npmjs.org, used
as the registry for every build. The first build to pull `react` warms it for every build
after. Today each build pulls its entire dependency tree across the public internet; after
this it pulls from the same region the build runs in. This is the accelerator that works on
a genuinely cold first deploy, because vibecoded projects overlap heavily in what they
depend on.

**`npm ci --prefer-offline --no-audit --no-fund`.** The audit and funding steps run on every
build and buy us nothing.

## Static serving

**Layout.** One bucket, `supersonic-static-assets`. A release lands at `<slug>/r/<release-id>/`.
A small object at `<slug>/current` names the live release. The server caches that pointer for
ten seconds.

This makes **rollback of a static app instantaneous** — rewrite one small object, done. Today
a rollback means a full pipeline run.

**The server.** A single Cloud Run service, `supersonic-static`. It derives the slug from the
`Host` header, exactly as the existing proxy does, then streams the file from the bucket.

Serving rules, stated explicitly because each one is a bug if got wrong:

- A path with no file extension that does not exist is served `index.html` with status 200.
  Client-side routers need this.
- A path *with* an extension that does not exist is a real 404. Serving `index.html` in place
  of a missing image hides broken builds.
- Files whose names carry a content hash get `Cache-Control: public, max-age=31536000, immutable`.
  `index.html` gets `no-cache`, or people keep seeing the previous deploy.
- Paths are normalised and any `..` segment is rejected, so a crafted `Host` or path cannot
  read another tenant's prefix.

**Identity.** The service account for `supersonic-static` holds `objectViewer` on that one
bucket and nothing else. Given what an audit on 2026-07-27 found about the runtime identity
of hosted apps — every one of them inherits a default compute account carrying `run.admin`,
`storage.admin` and `artifactregistry.writer` — new services get least privilege from the
first commit.

**Access control is unaffected.** The static server is an ordinary Cloud Run service, so the
proxy, `SEAL_APPS` and the visibility rules apply to static apps with no special case. Serving
straight from GCS through the load balancer would have required a second, parallel
access-control mechanism; that is the reason this design does not do it.

**Secrets in the static lane are public.** A static app has no server, so its "secrets" are
build-time variables baked into the bundle — that is what `VITE_*` has always been. Someone
typing an API key into a form labelled *secrets* may reasonably believe otherwise. In the
static lane the form says so in plain words.

## Base images

Stored in our own Artifact Registry, in the build region: `node22`, `node22-next`,
`python312-uvicorn`. Two wins: no Docker Hub pull (and no Docker Hub rate limit) on every
build, and a package cache pre-populated with the stack's canonical dependency tree, so a
real app's install finds most of what it needs locally and never opens a socket.

**Refresh is the most dangerous part of this design.** A base image with pinned dependencies
goes stale and must be rebuilt — and an auto-updating base image is a way to break every
customer's deploy at once.

So: builds reference `:stable`. A weekly job builds `:candidate` and promotes it to `:stable`
**only after a real test deploy has gone through it**. If the test fails, `:stable` is left
alone and we get told. Without that gate, base images are a net risk and should not be built
at all.

## Observability

There is none today. Deploy stages exist only in the SSE stream to one browser; the database
keeps a single latest `stage` string, throttled to one write per 2.5 s. When a customer asks
why their deploy took eight minutes, there is nothing to read.

Every deploy writes a row per stage: slug, lane, stage name, start, end, outcome. This is
also the only way to check the projections below, so it lands before the optimisations, not
after.

## Error handling

Each lane fails independently and visibly:

- **Static build fails** — same repair-agent path as today. Nothing has been uploaded, no
  pointer moved, so there is nothing to unwind.
- **Upload fails partway** — the release directory is orphaned but `current` still names the
  previous release, so the live site is untouched. Orphans are swept by age.
- **Base image missing or unpullable** — the fast lane falls back to the generic lane rather
  than failing the deploy. A stale `:stable` must never be able to take deploys down.
- **Clone-token miss** — clone again. Never fatal.
- **Static server cannot read the pointer** — 503 with a plain message, not a stack trace, and
  never another tenant's content.

## Expected results

| Lane | Today | Target |
|---|---|---|
| Static | ~2 min | 30-45 s |
| Fast | ~2 min | 50-70 s |
| Generic | ~2 min | ~90 s |

**These are projections, not measurements.** The only measured figures in this document are
today's: 72 s build, 21 s rollout, 57 s queue. The lane targets assume dependency installation
is roughly half of build time and that its network portion dominates. The telemetry above is
what will confirm or refute that, which is why it ships first.

## Explicitly out of scope

**A warm shared build service.** It would take the static lane to roughly 15 s by removing the
Cloud Build round trip entirely, and it is the wrong trade. `npm ci` runs `postinstall` scripts
from a customer's `package.json` — arbitrary customer code. Cloud Build gives every build a
fresh VM, and that isolation is precisely what a multi-tenant platform needs. A long-lived
shared builder throws it away. Rejected on those grounds, not on effort.

**Fixing the hosted-app runtime identity.** Real and urgent, but a separate piece of work with
its own blast radius; tracked from the audit, not folded in here.
