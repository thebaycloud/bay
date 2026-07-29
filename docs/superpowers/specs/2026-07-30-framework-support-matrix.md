# Prebuilt runners — the deploy model

**Status:** building · **Date:** 2026-07-30 · **Supersedes:** the framework-matrix draft

## The decision

We are **not** hardcoding a detector recipe per framework, and we are **not**
building a Docker image per deploy. Both are losing games — you can't enumerate
every framework, and a per-app image build is the slow part of every deploy.

Instead: **prebuilt runner base images that already carry the popular packages.**
A deploy builds nothing. It uploads the user's code and points a Cloud Run
revision at a shared runner that fetches the code and runs it. The knowledge of
*how to run an app* lives with the deploying agent (which knows the stack) and,
for the weird 10%, with opencode — never in a matrix baked into our platform.

## How a deploy works now

1. **Static SPA** (Vite/CRA/plain HTML — nothing to run) → the existing instant
   static lane: build to a folder, upload to GCS, live in ~30s. Unchanged. The
   runner would only add latency here, so it stays off this path.
2. **Everything else with no Dockerfile** → the **runner lane**:
   - Package the source (drop `.git`/`node_modules`/`.next`; **never ship `.env*`**).
   - Upload it to `gs://<assets>/code/<slug>/<release>.tgz`.
   - `gcloud run deploy <slug> --image runner-<node|python>` with the code
     location + `DATABASE_URL`/`STORAGE_BUCKET`/secrets injected as env.
   - The runner image fetches the code, reconciles deps against its warm cache
     (fast — the popular ones are already present), optionally builds (Node
     `build` script by convention), and runs on `$PORT`.
3. **Ships a Dockerfile** → the author was explicit; existing container build.
4. **Deploy fails** → the opencode repair loop, exactly as today.

Language is a **two-way Node/Python fork** read from the detector's `runtime`
string — not a framework decision. That's the only detection left.

## The runner images (`services/runner/`)

- `node/Dockerfile` — `node:22-slim` + a **warm npm cache** of the popular
  packages (`popular-node.txt`), so a user's `npm install --prefer-offline` is
  near-instant.
- `python/Dockerfile` — `python:3.12-slim` + a **prebuilt wheelhouse**
  (`popular-python.txt` → `/opt/wheels`), so `pip install --find-links` resolves
  offline, including the heavy scientific wheels.
- `entrypoint.sh` — identical on every app: fetch code from GCS (runtime SA via
  the metadata server, no keys), reconcile deps, build-by-convention, `exec` the
  start command on `$PORT`. Start command is `$SUPERSONIC_RUN` or the Node
  default `npm start`.
- `build.sh` — builds + pushes both images via Cloud Build. Run **rarely**: once,
  then on a schedule to refresh the warm package set.

## Rollout

Behind `RUNNER=1` on the control plane, so it ships dark. To go live:

1. `services/runner/build.sh` → push `runner-node` / `runner-python` to Artifact
   Registry.
2. Set `RUNNER=1` on `supersonic-control-plane`; redeploy (from the repo root).
3. Deploy a Node server app + a Python app; confirm both come up live.
4. Grant the app runtime SA `storage.objectViewer` on the assets bucket **before**
   `APP_RUNTIME_SERVICE_ACCOUNT` is set (until then apps use the default SA, which
   can already read).

## Known tradeoff (open)

Cloud Run scales to zero, and the runner installs deps on cold start — so a cold
start after idle pays the (warm-cache-fast) install again. Levers: `--min-instances=1`
for paid apps, or bake the reconciled `node_modules` into the uploaded bundle at
deploy time so cold start is fetch-and-run only. Decide after measuring real
cold-start numbers with the warm cache in place.

## Out of scope

Multi-service/compose apps, self-hosted Redis, and any stack that needs more than
one running container — same as before.
