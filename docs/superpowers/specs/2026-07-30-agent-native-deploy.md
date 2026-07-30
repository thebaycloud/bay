# Agent-native deploy — the deploy overhaul

**Status:** plan · **Date:** 2026-07-30 · **Supersedes:** the framework-matrix + runner drafts

## The shift

Stop trying to *reverse-engineer* every repo in the cloud. The user is already
driving with a coding agent that has the repo open and the deps warm — it knows
how the app builds and runs better than any detector can guess. So:

> **Supersonic doesn't figure out anyone's repo. It lets the agent, who already
> understands it, ship it — however that stack actually runs.**

"However it runs" is per-stack, not a matrix:
- **Static/Vite** → there's a build; the output is files → build + serve files.
- **Node server** → maybe a build, then run.
- **Python** → *no build* → install deps + run.

Two agents exist and both get used: the **user's local agent** (primary — has
context + warm deps) and **cloud opencode** (fallback for headless/no-agent and
the genuinely-hard tail). The deterministic detector drops to a *hint*, never the
authority.

## Why (evidence from this session)

- **Excalidraw** fails today: detector hardcodes Vite→`dist`, but the real output
  is `excalidraw-app/build` (a workspaces monorepo). Build succeeds, publish finds
  nothing → empty/failed release. A guess can't win here; the agent that reads the
  config does.
- **Docmost** fails: multi-service (needs Redis, out of scope), auto-Postgres
  didn't fire, `diagnose` returns "no source repo on file", the repair agent
  promised "provisioning the database next" then quit. The platform hid its own
  limits behind broken tooling.
- **Speed**: a Next deploy is ~2–3 min. Measured breakdown: **72% Docker image
  build, 19% Cloud Run rollout, 9% everything else.** Caching can't touch the
  overhead floor — you have to *delete* the build and the per-app rollout.
- **Build risk**: vibecoders run `npm run dev`, often never `npm run build`. A
  first-ever production build can fail. The deploy must degrade gracefully, never
  dead-end.
- **Cross-platform**: packaging shells out to system `tar` — the source of the
  macOS `._*` bug (hotfixed in CLI 0.9.1) and fragile on Windows.

## Target

- **Live URL: instant** (~1s) — already delivered by the tunnel + non-blocking CLI.
- **Real build live: 5–10s** for the common case — the new work below.

## Phases (ordered by dependency, then value)

### Phase 0 — Foundations (unblockers)
- **0a. Per-object signed-URL bundle access.** The control plane signs a
  short-lived GET URL for `ready/<slug>/<release>.tgz` per deploy and passes it to
  the runner as env; the runner fetches via that URL — **no bucket-wide SA grant**,
  so one shared runtime account can't read other apps' bundles. This unblocks BOTH
  the runner lane (currently dark) and the local-build ship-a-bundle path. Team
  already agreed on this (commit 9c22547). *Files:* `services/runner/entrypoint.sh`,
  `apps/web/app/api/deploy/route.ts`, control-plane SA `signBlob`. *Risk:* URL
  expiry on a cold start weeks later → refresh on every redeploy; revisit a
  control-plane-mediated fetch if the edge case bites.
- **0b. Node `tar` library replaces system `tar`.** Packaging becomes byte-identical
  on macOS/Windows/Linux, junk-file exclusion lives in code (`._*`, `.DS_Store`,
  `Thumbs.db`, `desktop.ini`), and the `tar`-installed dependency disappears —
  permanently retiring the class of bug the 0.9.1 hotfix patched. `windowsHide` on
  the detached worker. *Files:* `packages/cli/index.js`, add `tar` dep.

### Phase 1 — Agent-native contract
- **`llms.txt` = the contract.** The agent's job: work out how the app builds and
  runs (read the config — it's right there), build it when there is a build, and
  hand Supersonic the result / the run command. Same shape as the existing
  `--dev-cmd`. *Files:* `apps/landing/public/llms.txt`.
- **CLI accepts ground truth.** `supersonic deploy --out <dir>` uploads a prebuilt
  output directory (static); build-locally-and-upload becomes first-class, not the
  hidden `--prebuilt`. Agent-supplied run/build commands are honoured. *Files:*
  `packages/cli/index.js`.
- **Detector → hint.** Agent-supplied facts override detection; a wrong `dist`
  guess can never beat the agent that knows it's `excalidraw-app/build`. *Files:*
  `apps/web/app/api/deploy/route.ts`.

### Phase 2 — Detector as a *better* hint (for the no-agent case)
- Read the real `outDir` from `vite.config` / `next.config`; detect workspaces
  monorepos and the app subdirectory. Fixes Excalidraw even headless. Still a hint,
  still overridable. *Files:* `services/deploy-agent/src/index.ts` + tests.

### Phase 3 — Speed lever 1: local build → ship the result (kills the 72%)
- **Static** → agent builds, `--out` uploads the files (~10s, already close).
- **Node server** → `output: 'standalone'` → upload the standalone bundle → runner
  runs `node server.js`. No cloud install, no cloud build.
- **Python** → no build: install deps against the warm wheelhouse + run the agent's
  command (the runner already does this).
- *Files:* `llms.txt`, `services/runner/*`, `apps/web/app/api/deploy/route.ts`.

### Phase 4 — Speed lever 2: kill the per-app rollout (the last ~35s)
- The static lane is 10s because it has **no Cloud Run revision** — upload +
  pointer flip on one shared service. Bring that to server apps: a **warm runner**
  that **hot-swaps the bundle** (fetch new bundle, restart the app process) instead
  of rolling out a new revision. Deploy = upload + flip + reload signal → a few
  seconds. *Options:* `min-instances=1` per app (idle cost) vs. a **warm pool
  assigned one-app-at-a-time** (the real engineering; preserves isolation — never
  share a process across tenants). *Highest risk/effort; the piece that separates
  40s from 10s.*

### Phase 5 — Reliability (Docmost lessons; can run in parallel)
- **Fix `supersonic diagnose` for local/Dockerfile deploys** — it returns "no
  source repo on file" today, breaking the paste-ready-fix path for every
  non-GitHub deploy.
- **Repair agent honesty** — never promise "provisioning the database next" then
  quit. Fail cleanly, naming exactly what's missing and whether it's supported.
- **Build-failure handling** — don't gate on a clean prod build: try build → agent
  fixes (local, then cloud opencode) → **dev-parity fallback** (run it like the
  user's machine). The tunnel keeps the URL live throughout, so never a dead link.
- **Scope honesty** — detect unsupported shapes (multi-service/compose, Redis) and
  say so up front, instead of failing deep in a build.
- *Files:* diagnose route/CLI, `apps/web/lib/opencode-deploy.ts`, deploy route,
  runner (dev-parity mode).

## Sequencing

```
0a signed-URL ─┐            ┌─ 3 local-build speed ─┐
0b node-tar  ──┼─ 1 agent ──┤                       ├─ 4 warm-runner (last, biggest)
               │   contract  └─ 2 detector-hint     │
               └───────────── 5 reliability (parallel any time)
```

Phase 0 is the keystone: the signed URL unblocks the runner *and* the ship-a-bundle
path, so it pays off twice. Ship 0→1→3 for most of the win (agent-native + ~10s
static / fast Node), then 5 for trust, then 4 for the sub-10s server number.

## Out of scope (say no on purpose)

- Multi-service / docker-compose apps (Docmost) — one running unit, not a stack.
- Self-hosted Redis / queues — bring your own via env (Upstash).
- Sub-second *real* builds — that's the tunnel preview, which already exists.
