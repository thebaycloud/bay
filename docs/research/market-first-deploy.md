# Market research: "time to first deploy" across deploy platforms

Research date: 2026-08-06. Scope: primary sources only (vendor docs, vendor engineering blogs, changelogs, and benchmarks that state their own methodology). Marketing-page numbers are included only where a concrete figure is stated, and are explicitly labeled "vendor marketing." Every claim below is labeled one of: **vendor-claimed** (stated by the vendor, no independent verification), **vendor-measured** (vendor publishes internal percentile/telemetry data, still self-reported), **independently measured** (a named third party ran and timed it themselves, methodology given), or **anecdotal** (forum/HN/Reddit comment, single data point, no methodology).

No single rigorous, dated, cross-platform "time to first deploy" benchmark exists in the public record covering all seven vendors with a stated methodology. This is flagged explicitly wherever relevant, rather than papered over with a listicle number.

---

## 1. Numbers per vendor

### Vercel

| Scenario | Number | Label | Source |
|---|---|---|---|
| CLI deploy (`vercel`) to a public URL, no account required for the URL to exist | "less than 60 seconds," "usually 30–90 seconds" for simple projects | Secondary/tutorial paraphrase, not found verbatim on a Vercel-owned page | [vibecodingwithfred.com](https://vibecodingwithfred.com/blog/getting-started-vercel/) (2026) — **treat as anecdotal/tutorial, not primary** |
| Marketing copy | "Import your repo, deploy in seconds" | Vendor marketing (round number, no methodology) | Vercel pricing page, referenced via search, not independently re-fetched in full |
| Fixed per-build platform overhead removed | "up to 7 seconds faster end-to-end"; breakdown: ~2.2s build-shutdown moved off critical path, ~930ms CLI prep moved into build env, ~413ms earlier finalization, ~900ms deduped requests (platform-side, 5s total); CLI-side: ~1s earlier domain-alias detection, ~650ms streamlined team resolution, ~500ms reused deployment data (2.1s total) | **Vendor-measured** (internal telemetry) | [vercel.com/changelog/deployments-are-now-up-to-7-seconds-faster](https://vercel.com/changelog/deployments-are-now-up-to-7-seconds-faster) (dated 2026-07-30 per fetch) |
| Deploy-step latency improvement | "2.8s at P99, 760ms at P75, 410ms average" faster; for projects with 100+ Vercel Functions, "more than 50 seconds faster," some customers "over 2 minutes" saved | **Vendor-measured** | [vercel.com/changelog/deploy-steps-are-now-up-to-21-faster](https://vercel.com/changelog/deploy-steps-are-now-up-to-21-faster) |
| Cold "cell" provisioning for Secure Compute builds | "90 seconds → 5 seconds," build time down 40%, overall build performance up ~30%, 20% faster than the prior (pre-Hive) system | **Vendor-measured**, from Vercel's own Hive infra blog | [vercel.com/blog/a-deep-dive-into-hive-vercels-builds-infrastructure](https://vercel.com/blog/a-deep-dive-into-hive-vercels-builds-infrastructure), published 2024-10-30 |
| Build timeout | Hard limit 45 minutes; build cache up to 1GB, retained 1 month | Vendor docs (limit, not typical case) | [vercel.com/docs/builds](https://vercel.com/docs/builds), last updated 2026-06-16 |

Vercel does not publish a single "first deploy takes N seconds" headline number for a first-ever deploy of a fresh Node/Python app. What it publishes are relative/percentile improvements to steps in the pipeline (provisioning, deploy-step, CLI overhead), which is more rigorous but harder to translate into a single wall-clock figure. No independent stopwatch benchmark with stated methodology was found.

### Netlify

| Scenario | Number | Label | Source |
|---|---|---|---|
| Platform-wide average build | "~2 minutes" average build across the platform | Secondary paraphrase (Oreate AI blog), not Netlify's own wording verified verbatim | Excluded as non-primary; flagged as low-confidence |
| Build-pipeline overhaul (Kubernetes containers → Firecracker microVMs) | Queue wait P95: ~40s → <2s; Queue wait P50: ~2s → 1s; cache fetch P95: 59.4s → 13.4s; cache fetch P50: 8.5s → <1s; dependency install P95: 55.8s → 24.2s; dependency install P50: 8.8s → 2.5s; cache save P95: >4min → 26s; cache save P50: 9.2s → 4.5s; Enterprise end-to-end 33% faster | **Vendor-measured** (internal percentile telemetry) | [netlify.com/blog/your-builds-just-got-faster](https://www.netlify.com/blog/your-builds-just-got-faster/), published 2026-04-09 |
| Netlify Drop (no-account, drag-and-drop static deploy) | "a live, shareable link in seconds" | **Vendor-claimed**, plausible for a zero-build static case since there's no dependency install or compile step | [docs.netlify.com — Netlify Drop Quickstart](https://docs.netlify.com/start/quickstarts/netlify-drop-quickstart/) |
| Netlify CLI anonymous deploy | `netlify deploy --allow-anonymous` creates a live URL claimable within 1 hour | Vendor docs (feature description, not a timing claim) | [developers.netlify.com](https://developers.netlify.com/guides/netlify-cli-alias-ntl/) |
| Older CLI deploy claim | "Deploy in seconds with Netlify CLI" | **Vendor marketing**, from 2019 — stale (7 years old), included only because it's the origin of the "seconds" framing still echoed in current docs | [netlify.com/blog/2019/05/28/deploy-in-seconds-with-netlify-cli](https://www.netlify.com/blog/2019/05/28/deploy-in-seconds-with-netlify-cli/) |

No first-deploy-specific wall-clock number from Netlify itself was found for a server app (Node/Python) with a build step. The percentile data above describes pipeline stages, not a single "signup to live URL" number, and it's about builds generally (mostly static/frontend framework builds), not specifically first-ever deploys.

### Railway

| Scenario | Number | Label | Source |
|---|---|---|---|
| Fully-cached build, after architecture refactor | Removing unneeded Temporal round-trips/gRPC bridges cut "about 20 seconds off a fully-cached build"; reading OCI manifest metadata instead of decompressing layers "shaved another 10 seconds off the average build" (~15x faster than decompression) | **Vendor-measured** | [blog.railway.com/p/new-builder-scale-big](https://blog.railway.com/p/new-builder-scale-big), "Counting to 3 with a new builder processing 50M+ monthly builds," published 2026-05-14 |
| Build-cell infra | Each 256-vCPU/512GB bare-metal host split into 8 microVM build cells (32 vCPU/64GB each) running BuildKit; cells are long-lived and their disks (hence BuildKit cache) persist across stop/start | **Vendor-measured/described** | Same post as above |
| Peak throughput | 66,000 builds/hour at peak (week of 2026-05-12), up from ~60,000/hour; 50M+ monthly builds | **Vendor-claimed** (scale, not speed-per-deploy) | Same post |
| Marketing/press claim | Railway "delivers deployments in under one second" (context: agent-driven deploys, contrasted with a "two to three minute" Terraform build-and-deploy cycle) | **Vendor-claimed via press coverage** — could not verify against a Railway-owned primary page; likely refers to a specific already-built-image redeploy case, not a first-ever build-from-source deploy | Reported via VentureBeat coverage of Railway's funding round (VentureBeat page returned HTTP 403 on fetch, so the quote could not be verified against the original article text — treat with caution) |
| Deploying without a build (pre-built image) | "By skipping the build process, deployments are much faster, often taking just a few seconds to pull the pre-built image" | **Vendor-claimed** | [blog.railway.com/p/comparing-deployment-methods-in-railway](https://blog.railway.com/p/comparing-deployment-methods-in-railway) |
| Anecdotal user reports | "Got app live in under 2 minutes" | **Anecdotal** (HN comment) | [news.ycombinator.com/item?id=35117991](https://news.ycombinator.com/item?id=35117991) |
| Quick-start docs | No explicit timing number; describes flow: New Project → connect GitHub repo or CLI (`railway init && railway up`) → Railway auto-builds → Generate Domain for a public URL | Vendor docs (no number stated) | [docs.railway.com/quick-start](https://docs.railway.com/quick-start) |

Railway is the vendor that talks most about build-pipeline internals but is the vaguest about a first-deploy headline number on its own properties; the sub-second and sub-2-minute figures both come from press or community sources, not a Railway-authored, methodology-stated benchmark.

### Render

| Scenario | Number | Label | Source |
|---|---|---|---|
| Marketing framing | "Run your web app in minutes"; "Signing up is fast and free" — no specific number given | **Vendor marketing**, deliberately unquantified | [render.com/docs/your-first-deploy](https://render.com/docs/your-first-deploy) |
| Free-tier cold spin-up after idling | Free web services spin down after 15 minutes of inactivity; spin-up on next request takes "about a minute," with some sources citing "30 to 60 seconds" | **Vendor documentation** (spin-up), the 30–60s figure appears to be a secondary paraphrase | [render.com/docs/free](https://render.com/docs/free) / community discussion at [github.com/orgs/community/discussions/197645](https://github.com/orgs/community/discussions/197645) |
| Build caching | Build cache is no longer auto-cleared after a failed build (so a fix-and-retry deploy can reuse cache); manual "Clear Build Cache and Deploy" available | **Vendor changelog** (feature description, no time delta given) | [feedback.render.com/changelog/improved-build-caching](https://feedback.render.com/changelog/improved-build-caching) |

Render is the most number-shy vendor in this set for first-deploy timing. Its own docs deliberately avoid stating a duration ("minutes" is as specific as it gets), and no Render-authored blog post with a build-time benchmark was found despite searching (`render.com/blog`, Render changelog, Render community/discourse). This is a genuine sourcing gap, not an oversight — flagged explicitly.

### Fly.io

| Scenario | Number | Label | Source |
|---|---|---|---|
| Machine *start* (image already cached locally), same region | "the 'start' message might arrive in ~10ms" (LA→LA) | **Vendor-claimed**, from Fly's own blog | [fly.io/blog/fly-machines](https://fly.io/blog/fly-machines/), published 2022-05-24 (>18 months old — flagged as potentially stale, though the Firecracker-based architecture is still current) |
| Machine start, cross-region | ~150ms (LA→São Paulo) | **Vendor-claimed** | Same post |
| Machine *creation* (image not cached — first deploy case) | Involves ~92 infra steps; image download "a few seconds if you're near S3 and the image is small... several minutes... if you're far away and the image is large" | **Vendor-claimed**, and directly relevant: this is the first-deploy case, explicitly slower than the oft-quoted sub-second "start" number | Same post |
| Typical `fly deploy` in practice | "First deployment should complete in about a minute" under ideal conditions; typical deploys "around 4–5 minutes"; occasionally ~30 minutes; health/smoke checks add ~10s | Mixed — first clause reads as vendor-ish guidance, remainder is **anecdotal**, from Fly community forum threads | [community.fly.io/t/fly-deploy-sometimes-takes-a-long-time-why](https://community.fly.io/t/fly-deploy-sometimes-takes-a-long-time-why/24798), [community.fly.io/t/deploying-app-suddenly-takes-15-minutes](https://community.fly.io/t/deploying-app-suddenly-takes-15-minutes/3705) |
| Third-party "commit to production" benchmark | Initial (cold) builds: 1:15 → 0:55 after optimization; subsequent (warm) builds: 30s → 13s, after switching to native overlayfs for Podman-based builds on Fly Machines; Firecracker machine start ~400–500ms in their pipeline | **Independently measured**, but by a vendor (WunderGraph) building its own CI product on top of Fly, not a neutral benchmark of Fly.io itself, and the post is now marked "archived/no longer maintained" | [wundergraph.com/blog/the_builder_the_road_from_commit_to_production_in_13s](https://wundergraph.com/blog/the_builder_the_road_from_commit_to_production_in_13s), published 2023-03-09, last updated 2025-09-10 |

Fly.io's own numbers are almost all about the *warm* machine-start case (sub-second to low-hundreds-of-ms), which is explicitly NOT the first-deploy case. Fly's own blog is candid that first-time image creation/download is the slow path. This is one of the clearer vendor-acknowledged gaps between "our fast number" and "what a first-time user experiences."

### Cloudflare Workers / Pages

| Scenario | Number | Label | Source |
|---|---|---|---|
| Code propagation after deploy | "Any deployment on Cloudflare Workers takes less than a second to propagate globally" | **Vendor-claimed** (marketing page framing, no methodology) | Cloudflare Workers product page, via search summary; not independently re-verified against a dated blog post |
| Worker cold start (isolate model, not container) | "under 5 milliseconds" to load an isolate; with SNI-based eager loading during the TLS handshake, effective cold start is described as "zero" because the 5ms load fits inside network latency | **Vendor-claimed/measured**, from Cloudflare's own engineering blog, with a clear before/after mechanism explanation | [blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers](https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers/), published 2020-07-30 (>18 months old, but the mechanism is still the documented current behavior per 2025–2026 secondary sources) |
| Pages build-container start time (old vs new infra) | "2+ minutes" → "2–3 seconds" for build initialization, by keeping a warm VM pool instead of spinning up a fresh VM per build (gVisor-sandboxed) | **Vendor-measured** | [blog.cloudflare.com/cloudflare-pages-build-improvements](https://blog.cloudflare.com/cloudflare-pages-build-improvements/), originally published 2022-05-10, last modified 2026-07-15 — old post, but Cloudflare has kept it updated, which raises some confidence it still reflects current infra |
| Pages first-deploy build (secondary source, not vendor) | "typically takes 1–3 minutes," 20-minute hard timeout | Secondary paraphrase / vendor docs limit | [developers.cloudflare.com/pages/platform/limits](https://developers.cloudflare.com/pages/platform/limits/) (timeout is primary; "1–3 minutes" figure not independently confirmed on a Cloudflare-owned page in this research pass) |
| Workers Builds (CI/CD product) | Max build duration 20 minutes; no first-deploy wall-clock number published | **Vendor docs**, mechanism-only | [blog.cloudflare.com/workers-builds-integrated-ci-cd-built-on-the-workers-platform](https://blog.cloudflare.com/workers-builds-integrated-ci-cd-built-on-the-workers-platform/), published 2024-10-31 |

Cloudflare is unusual: for the *code-execution* side (Workers isolates) it has hard, well-documented, sub-5ms numbers with a stated mechanism. For the *build/CI* side (Pages, Workers Builds) the numbers are much softer — one solid vendor-measured improvement (2min→2-3s build-container init) but no end-to-end "first deploy took N seconds" figure.

### Heroku

| Scenario | Number | Label | Source |
|---|---|---|---|
| Slug compile timeout | Hard limit: 25 minutes | Vendor docs (limit, not typical case) | Search result summary of [devcenter.heroku.com/articles/slug-compiler](https://devcenter.heroku.com/articles/slug-compiler) |
| Eco dyno wake-from-sleep | Sleeps after 30 minutes idle; wakes "with a delay of a few seconds" on next HTTP request | **Vendor docs** | [devcenter.heroku.com/articles/how-heroku-works](https://devcenter.heroku.com/articles/how-heroku-works) |
| "Instant deployment" framing | 2009 post argues deploy/provisioning should approach instant, states "10 seconds isn't good enough" as an aspiration — not a claim that Heroku achieves any specific number | **Vendor-claimed / aspirational**, and 16+ years old — clearly stale, included only for historical framing | [heroku.com/blog/why_instant_deployment_matters](https://www.heroku.com/blog/why_instant_deployment_matters/), published 2009-02-24, last updated 2024-06-03 |
| Tutorial framing | "a public URL for your app in 5 minutes"; "even a beginner can deploy... in minutes" | Secondary/tutorial, not Heroku-owned | Search summary of general Heroku learning guides |
| Third-party build optimization | One engineering team reported cutting their own Heroku deploy time by ~35% (specific before/after numbers not extracted in this pass) | **Independently measured** by a single company (Carwow), about their own app, not a general benchmark | [medium.com/carwow-product-engineering/speeding-up-our-heroku-deploys-by-35-percent](https://medium.com/carwow-product-engineering/speeding-up-our-heroku-deploys-by-35-percent-f9fa6f6cf404) |

Heroku has the weakest recent primary-source coverage of any vendor here — its own Dev Center documents the *mechanism* (buildpacks → slug → release → dyno) in detail but states no current wall-clock target or measured figure for first deploy. This is consistent with Heroku's reduced public engineering-blog activity since the 2022 Salesforce restructuring; nothing found in this research is more recent than 2024 (a docs "last updated" stamp) for anything timing-related.

### Cross-vendor summary table

| Vendor | Best available first-deploy-relevant number | Type | Recency |
|---|---|---|---|
| Vercel | Deploy-step overhead cut by up to 7s; cold provisioning 90s→5s | Vendor-measured (pipeline stages, not full first-deploy) | 2024–2026 |
| Netlify | Dependency install P95 55.8s→24.2s; cache fetch P95 59.4s→13.4s (post Firecracker-microVM rebuild) | Vendor-measured (build-pipeline stages) | 2026-04 |
| Railway | "few seconds" if no build (prebuilt image); ~20s+10s shaved off fully-cached builds | Vendor-claimed / vendor-measured | 2026-05 |
| Render | "minutes" (undefined); free-tier wake ~30–60s | Vendor marketing / vendor docs | undated / ongoing |
| Fly.io | Warm machine start ~10ms–150ms; but first-time image creation is "several minutes" if far from registry | Vendor-claimed, both fast and slow cases documented | 2022 (stale, architecture unchanged) |
| Cloudflare | Worker isolate cold start <5ms (effectively 0 via SNI preload); Pages build-container init 2min→2-3s | Vendor-measured | 2020 / 2022(updated 2026) |
| Heroku | No current stated number; wake-from-sleep "a few seconds" | Vendor docs | stale (no dated recent source) |

**No vendor in this set publishes a single, dated, methodology-backed "first deploy: N seconds/minutes, measured this way" statement covering a fresh Node/Python app from user action to working URL.** Every number above is either (a) a percentile/relative pipeline-stage improvement, (b) a best-case/warm-case number that explicitly excludes the first-deploy cold path, or (c) anecdotal.

---

## 2. Mechanism: what makes the fastest platforms fast

Based on available primary sources, the two platforms with the most detailed, vendor-published mechanism explanations are **Cloudflare Workers** and **Fly.io**, with **Vercel** and **Netlify** close behind on the build-orchestration side. Railway publishes real infra detail too.

### Cloudflare Workers — no build, no container, no VM for code execution
- Workers doesn't run your code in a container or VM at all; it runs in a **V8 isolate**, the same lightweight sandboxing primitive Chrome uses for tabs. There is no OS to boot and no container image to pull for code execution, only isolate creation, which the vendor states takes under 5ms. [blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers](https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers/) (2020-07-30) and [blog.cloudflare.com/cloud-computing-without-containers](https://blog.cloudflare.com/cloud-computing-without-containers/).
- Cloudflare hides even that 5ms by starting isolate load speculatively: when the TLS ClientHello (SNI) arrives, before the handshake finishes, Cloudflare already knows the hostname and starts loading that Worker. By the time the actual HTTP request arrives, the Worker is warm. Vendor's own framing: cold start becomes "zero" because loading fits inside network round-trip time.
- For the **build/CI** side (Pages, Workers Builds), Cloudflare's fix was a warm-VM pool: instead of creating a fresh VM per build job (2+ minutes of the old pipeline was VM boot/init), jobs now land on already-running, pre-initialized machines (gVisor-sandboxed for isolation), cutting build-container init from 2+ minutes to 2–3 seconds. [blog.cloudflare.com/cloudflare-pages-build-improvements](https://blog.cloudflare.com/cloudflare-pages-build-improvements/).
- Net effect: for the large class of apps that need no build step at all (a raw Worker script, or a static Pages site), essentially all of the wall-clock is upload + global propagation (sub-second, per vendor claim), not build or scheduling.

### Fly.io — fast VM boot, but only after the image already exists
- Fly Machines are Firecracker microVMs. **Starting** an already-created machine (image cached on the host) is the genuinely fast part: ~10ms same-region, ~150ms cross-region per Fly's own numbers. This matches the general Firecracker literature (sub-second boot is well documented independently, e.g. Julia Evans' widely cited "Firecracker: start a VM in less than a second," 2021-01-23, [jvns.ca](https://jvns.ca/blog/2021/01/23/firecracker--start-a-vm-in-less-than-a-second/) — a third-party technical write-up, not a vendor claim, but consistent with Fly's).
- **Creating** a machine — the actual first-deploy path — is explicitly called out by Fly's own blog as the slow part: ~92 infrastructure steps, and image download time that scales with image size and distance from the registry ("a few seconds" if small and near S3, "several minutes" if large and far). [fly.io/blog/fly-machines](https://fly.io/blog/fly-machines/) (2022-05-24).
- A third-party (WunderGraph, building their own CI on Fly) measured that switching their build pipeline to native overlayfs (rather than copy-based layer extraction) took cold builds from 1:15 to 0:55 and warm/incremental builds from 30s to 13s — an example of build-caching strategy, not Fly-platform-level optimization, but built entirely on Fly Machines primitives. [wundergraph.com](https://wundergraph.com/blog/the_builder_the_road_from_commit_to_production_in_13s) (2023, updated 2025, now archived).
- Net effect: Fly's speed story is about **warm/incremental** operations (redeploys, scale-to-zero wake-ups). The literal first deploy of a new app pays full image-build and image-distribution cost, which Fly's own docs and community threads confirm can run into minutes, occasionally tens of minutes.

### Vercel — pre-warmed build cells + shrinking fixed overhead
- Vercel's "Hive" build infrastructure (in production since November 2023) maintains a **pool of pre-warmed cells** so that spinning up a fresh isolated build environment (for "Secure Compute" customers) dropped from ~90s to ~5s provisioning. [vercel.com/blog/a-deep-dive-into-hive-vercels-builds-infrastructure](https://vercel.com/blog/a-deep-dive-into-hive-vercels-builds-infrastructure) (2024-10-30).
- Separately, Docker image caching for the build environment itself reportedly cut ~45 seconds off startup versus the prior approach (previously "almost 2 minutes"). Same source.
- More recent changelog entries describe shaving fixed per-deploy overhead in the orchestration layer itself (moving shutdown/cleanup off the critical path, starting finalization concurrently with other steps, deduping API calls) — the vendor explicitly notes this matters most for **small builds**, where fixed orchestration overhead is a larger fraction of total time. [vercel.com/changelog/deployments-are-now-up-to-7-seconds-faster](https://vercel.com/changelog/deployments-are-now-up-to-7-seconds-faster).
- Vercel also **skips the build step entirely** for static sites (HTML/CSS/client JS with no framework) when "Framework Preset: Other" and no build command is set. [vercel.com/docs/builds](https://vercel.com/docs/builds).

### Netlify — replaced Kubernetes with Firecracker microVMs, layered filesystem for caching
- Netlify's build infra used to run builds in Kubernetes containers; it moved to **Firecracker microVMs** (the same hardware-virtualization tech AWS Lambda uses), plus pre-warmed VMs and pull-based work distribution to cut queue-wait time. Queue wait P95 dropped from ~40s to under 2s. [netlify.com/blog/your-builds-just-got-faster](https://www.netlify.com/blog/your-builds-just-got-faster/) (2026-04-09).
- The single largest documented lever was an **overlay/layered filesystem** — a writable layer stacked on read-only cached layers — for both dependency-cache fetch (P95 59.4s→13.4s) and dependency install (P95 55.8s→24.2s). This is a caching-strategy change (avoid re-fetching/re-installing unchanged dependency layers), not a "skip the build" change.

### Railway — long-lived microVM build cells with persistent BuildKit cache
- Railway runs BuildKit inside long-lived microVM "build cells" (8 per 256-vCPU bare-metal host). Because the VM's disk persists across stop/start, the BuildKit cache **survives infrastructure upgrades**, avoiding cold-cache penalties even when Railway ships new builder code. [blog.railway.com/p/new-builder-scale-big](https://blog.railway.com/p/new-builder-scale-big) (2026-05-14).
- Two concrete optimizations described: removing unnecessary Temporal/gRPC round-trips in the control plane (~20s off a fully-cached build) and reading OCI layer metadata directly from manifests instead of decompressing layers just to inspect them (~10s off average build, ~15x faster than decompression). Both are scheduling/orchestration-overhead fixes, not build-work reductions.
- Railway's own post frames the fastest possible deploy as one that **skips building altogether** by deploying a pre-built image directly ("often taking just a few seconds to pull the pre-built image"). [blog.railway.com/p/comparing-deployment-methods-in-railway](https://blog.railway.com/p/comparing-deployment-methods-in-railway).

### Rough build vs. scheduling vs. rollout breakdown
No vendor publishes a full percentage breakdown (e.g., "build is 60% of wall-clock, scheduling 20%, health-check rollout 20%") for a first deploy. What can be pieced together from the sources above:
- **Cloudflare Workers (no-build case):** essentially 100% is upload + propagation (sub-second, per vendor claim) — there is no build or scheduling phase in the traditional sense.
- **Cloudflare Pages / Workers Builds:** build-container acquisition used to be the dominant cost (2+ min) before warm pools cut it to 2-3s; remaining time is the actual framework build + upload, unquantified.
- **Vercel:** vendor changelog language ("orchestration represents a more substantial portion of total build time" for small builds) implies that for small apps, fixed platform overhead (not the actual `npm run build`) is a meaningful chunk, which is exactly what the ~5-7 second cuts targeted.
- **Netlify:** its own percentile table effectively is a partial breakdown — queue wait, cache fetch, dependency install, and cache save are called out as separate, separately-optimized stages, but a "build" step (running the user's actual build command) still sits in between them and is not itself timed in what was found.
- **Fly.io:** the split is much clearer here — machine *creation*/image distribution is the slow, first-deploy-specific phase; machine *start* (scheduling + boot) is the fast, sub-second phase used mostly for redeploys and scale-to-zero wake-ups.

---

## 3. Perceived vs. actual speed: what happens in the first ~5 seconds

| Vendor | What the user sees almost immediately | Source |
|---|---|---|
| Vercel | CLI/dashboard immediately shows a streaming build log and a preview URL is allocated early (before the build finishes) so a link exists to share/watch; small builds specifically benefit from recent overhead cuts, which the vendor says matter most exactly because the orchestration/queueing steps used to dominate small-build wall-clock. | [vercel.com/docs/builds](https://vercel.com/docs/builds) (streaming logs are standard product behavior, described across Vercel deployment docs); [changelog post](https://vercel.com/changelog/deployments-are-now-up-to-7-seconds-faster) |
| Netlify | Drag-and-drop (Netlify Drop) and CLI anonymous deploy explicitly optimize for "a live, shareable link in seconds" for the no-build/static case, with no login required; for git-based deploys, Netlify shows a build log and a "Deploying" status immediately, with queue-wait now under 2s at P95 after the infra rebuild. | [docs.netlify.com Netlify Drop Quickstart](https://docs.netlify.com/start/quickstarts/netlify-drop-quickstart/); [netlify.com/blog/your-builds-just-got-faster](https://www.netlify.com/blog/your-builds-just-got-faster/) |
| Railway | CLI flow is two commands (`railway init`, `railway up`) then the user lands on a live "Project Canvas" showing build logs streaming and deployment status, before the deploy necessarily finishes; "Generate Domain" is a distinct explicit step (not automatic) which is itself near-instant once clicked. | [docs.railway.com/quick-start](https://docs.railway.com/quick-start) |
| Render | Docs show a config form (branch/build/start command) then "click deploy" leads straight to a live-updating log view with status progressing to "Live"; no vendor-stated number for how fast the log/status view itself appears. | [render.com/docs/your-first-deploy](https://render.com/docs/your-first-deploy) |
| Fly.io | `fly launch` / `fly deploy` streams build and rollout logs including explicit stage labels like "Configuring firecracker" (visible enough that it shows up verbatim in community bug reports when it hangs) — i.e., the CLI is chatty about internal stages, which reads as transparency/progress-indication even when the underlying step is slow. | [community.fly.io "Deploy stuck on 'Configuring firecracker'"](https://community.fly.io/t/deploy-stuck-on-configuring-firecracker/14833) (community thread; existence of this exact log line is the useful evidence here, not the complaint itself) |
| Cloudflare Workers | `wrangler deploy` uploads a Worker and the vendor claims global propagation in under a second; combined with sub-5ms isolate cold starts, the practical experience is closest to "instant" of any vendor in this set for the no-build case. | [Cloudflare Workers product page framing](https://www.cloudflare.com/products/workers/) (vendor marketing claim on propagation time; not independently verified with a dated methodology) |
| Heroku | `git push heroku main` streams buildpack output live in the terminal by design (this has been Heroku's signature UX since its earliest days); no recent vendor source quantifies how fast the first log line appears. | General Heroku Dev Center description of the git-push deploy flow; no specific timing source found |

The general pattern across all seven: **every vendor gets a build log or status view in front of the user within the first few seconds**, regardless of how long the underlying deploy actually takes — this is treated as close to an industry-standard UX baseline, not a differentiator. What differs is (a) whether a *URL* exists before the build finishes (Vercel allocates a URL early; several others only expose the URL once the deploy is "Live"), and (b) whether the no-build/static path is meaningfully faster than the build path (Cloudflare and Netlify both explicitly design for this; Vercel explicitly supports "skip the build step" for plain static sites).

---

## 4. The irreducible floor

Genuinely hard-to-compress steps identified from primary sources, and which vendors sidestep (vs. actually shrink) each one:

**DNS propagation / custom-domain TLS issuance**
- This is the step every vendor sidesteps rather than compresses, by giving every new deployment a certificate-ready subdomain on a domain the vendor already controls and has wildcard (or fast per-subdomain) TLS coverage for: `*.vercel.app`, `*.netlify.app`, `*.onrender.com`, `*.up.railway.app`, `*.fly.dev`, `*.herokuapp.com`, `*.workers.dev`. Because these certs are already provisioned/wildcarded ahead of time, a first deploy never pays real ACME/DNS-propagation latency for its default URL.
  - Netlify: "If your domain uses Netlify DNS, Netlify automatically provisions a wildcard certificate" — [docs.netlify.com HTTPS(SSL)](https://docs.netlify.com/manage/domains/secure-domains-with-https/https-ssl/).
  - Vercel: default `*.vercel.app` domains get certs automatically; true wildcard subdomains for *your own* custom domain require moving DNS to Vercel's nameservers so Vercel can complete a DNS-01 challenge — [vercel.com/docs/domains/working-with-ssl](https://vercel.com/docs/domains/working-with-ssl).
  - Heroku: `*.herokuapp.com` ships with a wildcard cert by default (SNI-based) — search summary of [devcenter.heroku.com/articles/ssl](https://devcenter.heroku.com/articles/ssl).
  - Render, Railway, Fly.io all document analogous default-subdomain TLS as "automatic," with no user-facing provisioning delay — [render.com/docs/tls](https://render.com/docs/tls), [docs.railway.com/networking/domains/working-with-domains](https://docs.railway.com/networking/domains/working-with-domains), [fly.io/docs/networking/custom-domain](https://fly.io/docs/networking/custom-domain/).
  - The moment a **real, user-owned custom domain** enters the picture, the floor reappears: Railway's own docs say "certificate issuance should happen within an hour of DNS being updated"; Netlify's support forum has multiple threads of certs stuck "provisioning" for 24-48+ hours pending DNS propagation; none of this is compressible by the platform because it depends on DNS TTLs and Let's Encrypt/CA behavior outside any vendor's control. Sources: [docs.railway.com](https://docs.railway.com/networking/domains/working-with-domains); Netlify forum threads e.g. [answers.netlify.com/t/custom-domain-stuck-provisioning-ssl-certificate-for-hours-migrated-from-wix](https://answers.netlify.com/t/custom-domain-stuck-provisioning-ssl-certificate-for-hours-migrated-from-wix/159809) (anecdotal support cases, but consistent with the DNS-propagation-dependency mechanism described in vendor docs).

**Dependency install / package resolution**
- This is the one step every vendor is actually trying to shrink, not sidestep, because it can't be skipped for any app with real dependencies. Netlify's layered-filesystem work targets exactly this (dependency install P95 55.8s→24.2s). Railway's persistent BuildKit cache and Vercel's build-cache (1GB, 1-month retention) target the same problem. None of these help a genuine **first-ever** deploy, though — by definition there is no prior cache to hit, so a first deploy pays full, uncached dependency-resolution cost on every platform. This is arguably the single largest true "floor" component for a Node/Python app with a non-trivial `package.json`/`requirements.txt`, and it is consistent across all vendors examined.

**Container/image creation and distribution**
- Fly.io is the most explicit about this being slow and unavoidable on a genuine first deploy: image creation involves ~92 steps and download time scales with image size and distance from the registry, contrasted directly against the fast (~10-150ms) "start" path that only applies once an image already exists on a host. [fly.io/blog/fly-machines](https://fly.io/blog/fly-machines/).
- Cloudflare Workers sidesteps this entirely for its core product by not using containers/VMs for code execution (isolates instead) — this is a genuine architectural bypass, not an optimization, and it's only available because Workers constrains what kind of code can run (V8-compatible JS/Wasm, not arbitrary server binaries).

**Database / resource provisioning**
- Not covered in depth by any primary source found in this pass. Railway, Render, and Heroku all offer one-click-attached databases; none of the fetched sources gave a provisioning-time number for a first database attach. This is a real gap — flagged explicitly: searched for "[vendor] database provisioning time" style queries were not run in this pass and would need follow-up if this dimension matters to the comparison.

**Cold starts (post-"deploy complete," first real HTTP request)**
- This is where "deploy complete" and "app actually responds" diverge, and where the biggest perception gap lives (see Section 5). Render's free-tier idle-to-wake cycle (~30-60s after 15 min idle) and Heroku's eco-dyno wake ("a few seconds" after 30 min idle) are both vendor-documented cases where the platform reports the service as deployed/live long before a real user request would get a fast response, if that request arrives after the service has gone to sleep even once.

---

## 5. What the headline number hides

| Vendor | What gets excluded from the "fast" story | Evidence |
|---|---|---|
| Vercel | The percentile/relative improvements (7s here, 2.8s there) are pipeline-internal; they say nothing about account creation, Git App installation/OAuth consent, or the time to get from "I have a repo" to "Vercel is authorized to see it" — none of which is timed in any source found. Also: the fast "provisioning" numbers are for the Secure Compute build-cell case specifically, not necessarily representative of the default Hobby-tier build path. | [vercel.com/blog/a-deep-dive-into-hive-vercels-builds-infrastructure](https://vercel.com/blog/a-deep-dive-into-hive-vercels-builds-infrastructure) |
| Netlify | The layered-filesystem percentile table describes *build-pipeline stages* (queue, cache fetch, install, cache save) but conspicuously does not include the time to run the user's own build command, nor the very large gap between the fast, no-account "Netlify Drop" flow (seconds, but static-only, and any claimed URL is temporary/unclaimed) and the standard signed-in, git-connected flow that most real first-time server-app users would actually take. | [docs.netlify.com/start/quickstarts/netlify-drop-quickstart](https://docs.netlify.com/start/quickstarts/netlify-drop-quickstart/); [netlify.com/blog/your-builds-just-got-faster](https://www.netlify.com/blog/your-builds-just-got-faster/) |
| Railway | The "few seconds to pull a pre-built image" framing quietly assumes you already have a pre-built image somewhere (i.e., you did a Docker build yourself, off-platform, first) — for the common case of "point Railway at my source and let it build," that build cost is the thing actually being measured elsewhere in the same post (the ~20s+10s savings), not eliminated. The reported "under one second" deploy figure (via press coverage) almost certainly describes an already-built-artifact redeploy, not a from-source first build — but this could not be confirmed against Railway's own text since the source article returned a 403 on fetch. | [blog.railway.com/p/comparing-deployment-methods-in-railway](https://blog.railway.com/p/comparing-deployment-methods-in-railway); VentureBeat quote unverifiable in this pass |
| Render | Render's docs never state a number, which is itself notable: "minutes" covers everything from a fast static build to a multi-minute Python dependency install, and the free-tier spin-up delay (30-60s) only applies to a service that has already deployed once and gone idle — meaning a brand-new user's very first request, made right after "Live" appears, is likely NOT subject to this delay, but their second visit an hour later could be, which is a distinction Render's docs do not draw out for the user. | [render.com/docs/free](https://render.com/docs/free), [render.com/docs/your-first-deploy](https://render.com/docs/your-first-deploy) |
| Fly.io | The widely-repeated sub-second/low-hundreds-of-ms Firecracker boot numbers (from Fly's own blog and from Julia Evans' independent write-up) describe *machine start*, explicitly not *machine creation* — Fly's own post is unusually candid that this distinction exists, but the "Firecracker boots in under a second" framing is what circulates in secondary coverage, stripped of that caveat. A first-time user doing `fly launch` pays the creation cost, not the start cost. | [fly.io/blog/fly-machines](https://fly.io/blog/fly-machines/) |
| Cloudflare | The sub-second global-propagation and sub-5ms cold-start claims apply to the no-build Workers-script case. The moment a real build step enters via Workers Builds or Pages, none of those numbers apply, and Cloudflare's own build-side numbers are much sparser (only the 2min→2-3s build-container init figure was found, which is about container acquisition, not the user's actual framework build). | [blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers](https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers/); [blog.cloudflare.com/cloudflare-pages-build-improvements](https://blog.cloudflare.com/cloudflare-pages-build-improvements/) |
| Heroku | No current headline speed number exists to hide anything behind — the gap here is the opposite problem: Heroku's own recent-dated material is almost entirely about mechanism (buildpacks/slugs/releases) and hard limits (25-minute compile timeout), not speed, so there is nothing to check the "hidden cost" of. The one aspirational claim found ("10 seconds isn't good enough") is 16 years old and was never a claim that 10 seconds (or any other number) was actually achieved. | [heroku.com/blog/why_instant_deployment_matters](https://www.heroku.com/blog/why_instant_deployment_matters/) |

Across all seven, the single most consistent hidden cost is **account/Git-integration setup** (OAuth consent, choosing/installing a GitHub App, org selection) — no vendor's speed claims include this, and no primary source found actually times it. This is a blind spot across the entire industry's public materials, not specific to any one vendor, and is worth flagging as a genuine "nobody measures this" gap.

---

## Sourcing gaps (explicitly flagged)

- **No cross-vendor benchmark with a stated methodology** timing "first deploy, wall clock, user action to working URL" was found for any pair of these seven vendors, let alone all seven. All comparison-style articles found in search results were listicle/SEO comparison pages explicitly excluded per the sourcing standards for this research.
- **Render**: no engineering blog post or changelog with a build-time number was found at all, despite direct searches of `render.com/blog`, Render's changelog/feedback site, and Render's community forums. Render's own docs deliberately avoid quantifying deploy time ("minutes").
- **Heroku**: no primary source newer than a June 2024 "last updated" docs stamp was found with any timing content; Heroku's public engineering-blog output on this topic appears to have gone quiet.
- **Database/resource provisioning time** (a first Postgres/Redis attach) was not covered by any source found in this research pass for any vendor — flagged as an open gap rather than estimated.
- **Account/OAuth/Git-App-install time** — no vendor measures or publishes this, for any of the seven platforms.
- **Railway's "under one second" deploy claim** (via VentureBeat) could not be verified against Railway's own words because the VentureBeat article returned HTTP 403 to automated fetch; the claim is reported here only as press-relayed, not confirmed primary-source vendor language.
- Several sources used (Fly.io's `fly-machines` blog, Cloudflare's Workers cold-start blog, Heroku's "instant deployment" post) are older than the 18-month freshness preference stated in the brief; each is flagged inline above where used, and included only because no newer primary source covering the same mechanism was found.
