# Agent-only deploy — the deploy brain moves to the agent

**Status:** building · **Date:** 2026-07-30 · **Supersedes:** the detector/framework-matrix approach

## Why

Every failure this session — Excalidraw's output dir, skipped devDeps, `next dev` as
the run command, the 512 MiB OOM — was the **platform guessing** how to build and run
an app it doesn't understand. The agent in the repo already knows all of it. So stop
guessing: the agent decides, Supersonic executes.

## The contract — what the agent provides

The agent (the user's local coding agent, or cloud opencode when headless) works out
how the app ships and passes exactly one shape:

- **`--out <dir>`** — it built a static site; upload that directory and serve it.
- **`--run "<prod cmd>"`** — it's a server; run this command (binds `0.0.0.0:$PORT`).
- **a `Dockerfile`** in the repo — the author was explicit; container build.

Env comes from the existing `.env` carry-up. Memory defaults generous (2Gi for the
runner). Nothing is detected.

## What Supersonic does (dumb executor)

Lane decision, in order — **no `detectStack`**:

1. `Dockerfile` present → container lane (unchanged).
2. `--out` provided → static lane: publish the uploaded directory (reuse the existing
   `isPrebuilt` / prebuilt-release path).
3. `--run` provided → runner lane: fetch the encrypted bundle, run the agent's command
   with 2Gi (reuse the runner, now that devDeps/run-cmd/memory are fixed).
4. none → error that asks for `--out` or `--run`. `llms.txt` makes the agent always
   provide one, so this is the rare headless-misuse case.

`detectStack` is kept **only** as an optional Postgres-provisioning hint (the agent can
override via env); it no longer decides build, run, output, or lane.

## What we delete

- The framework matrix / serve-mode / runtime detection that chose the lane.
- Every guess patched this session: the `npm start` default, the `next start`
  convention, the assumed `dist/` output dir.

## What we keep

- Upload + encrypted-bundle runner + fetch/decrypt (0a) — the transport + isolation.
- The static lane (upload + pointer flip) — reliable, ~10s.
- URL-first + the live-preview tunnel.
- The `Dockerfile` container lane.

## llms.txt (the agent's instructions)

> Work out how this app ships. If it builds to static files: build it
> (`npm run build` / your stack's build), then `supersonic deploy --out <build dir>`.
> If it's a server: `supersonic deploy --run "<production start command binding
> 0.0.0.0:$PORT>"`. You know the stack — figure out the dir/command; don't make the
> platform guess.

## Rollout

`--out` (static) rides the already-reliable static lane — usable immediately. `--run`
(server) rides the runner, which stays behind `RUNNER` until a real app is proven live
end-to-end. Removing the detector from the decision is the core change.

## Out of scope (unchanged)

Multi-service/compose, self-hosted Redis, anything needing more than one running unit.
