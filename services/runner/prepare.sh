#!/bin/sh
# Supersonic prepare — runs ONCE per deploy, inside Cloud Build, on the runner
# image (so the warm dependency cache / wheelhouse is available). It installs the
# app's dependencies and builds it, then tars the whole thing — deps included —
# into a ready-to-run bundle.
#
# The point: serving instances just fetch that bundle and run it, so NO install
# happens when Cloud Run starts a new instance (first visit or scale-up). Install
# once here, run many there.

# ── env names: BAY_* is what this script reads; SUPERSONIC_* is what it accepts ──
#
# This script is baked into every app image. Images built before the rename know
# only SUPERSONIC_*, and they keep running and restarting until somebody
# redeploys those apps — while a switched-over control plane sets BAY_*.
#
# Normalised HERE, once, so the body below has a single name to read. The
# alternative — a two-name fallback at each use — was written first and had a
# bug within the hour: the guard checked both names and the line under it read
# only the old one, so setting only BAY_* passed the check and then used an
# empty value.
#
# `:=` treats empty as unset, so an empty BAY_* falls back to SUPERSONIC_*.
# That is the wanted direction here and not an accident: during the migration a
# half-configured control plane setting BAY_RUN="" should keep running the app,
# not stop being able to start it. Both names come from the same writer at the
# same moment, so they cannot legitimately disagree.
#
# The _B64 pair is copied rather than defaulted, because those two distinguish
# "set and empty" from "unset" — a plan that deliberately runs no install
# command is set-and-empty — and `:=` would flatten that distinction.
for _n in RUN BUILD INSTALL LANG OUT CODE_URL CODE_BUCKET CODE_OBJECT CODE_KEY \
         CACHE_BUCKET CACHE_OBJECT PATH_PREFIX REPO; do
  eval ": \"\${BAY_${_n}:=\${SUPERSONIC_${_n}:-}}\""
done
for _n in INSTALL_B64 BUILD_B64; do
  eval "if [ -z \"\${BAY_${_n}+x}\" ] && [ -n \"\${SUPERSONIC_${_n}+x}\" ]; then BAY_${_n}=\$SUPERSONIC_${_n}; export BAY_${_n}; fi"
done
unset _n

set -eu
log() { echo "[supersonic-prepare] $*"; }

# --- cross-deploy build cache (best-effort) -------------------------------
# node_modules and the framework build cache (.next/cache) are the same between
# most redeploys, so we stash them in GCS keyed by the app and restore them next
# time. This is what makes a REDEPLOY fast: an unchanged lockfile means install
# reconciles an already-present tree, and `next build` reuses its incremental
# cache instead of recompiling from scratch. Auth is the Cloud Build worker's own
# service account via the metadata server — same pattern as the serve entrypoint.
# Every step here is swallowed: a cache miss or failure never fails a prepare.
CACHE_DIRS="node_modules .next/cache"
gcs_token() {
  curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
    | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p'
}
restore_cache() {
  [ -n "${BAY_CACHE_BUCKET:-}" ] || return 0
  t=$(gcs_token); [ -n "$t" ] || return 0
  enc=$(printf '%s' "$BAY_CACHE_OBJECT" | sed 's:/:%2F:g')
  if curl -sf -H "Authorization: Bearer $t" \
      "https://storage.googleapis.com/storage/v1/b/$BAY_CACHE_BUCKET/o/$enc?alt=media" -o /tmp/cache.tgz; then
    tar -xzf /tmp/cache.tgz -C "$APP" 2>/dev/null && log "restored build cache" || log "cache entry unusable — ignoring"
    rm -f /tmp/cache.tgz
  else
    log "no build cache yet — this deploy warms it for the next"
  fi
}
save_cache() {
  [ -n "${BAY_CACHE_BUCKET:-}" ] || return 0
  paths=""; for d in $CACHE_DIRS; do [ -e "$d" ] && paths="$paths $d"; done
  [ -n "$paths" ] || return 0
  t=$(gcs_token); [ -n "$t" ] || return 0
  tar -czf /tmp/cache.tgz $paths 2>/dev/null || return 0
  enc=$(printf '%s' "$BAY_CACHE_OBJECT" | sed 's:/:%2F:g')
  curl -sf -X POST -H "Authorization: Bearer $t" -H "Content-Type: application/gzip" --data-binary @/tmp/cache.tgz \
      "https://storage.googleapis.com/upload/storage/v1/b/$BAY_CACHE_BUCKET/o?uploadType=media&name=$enc" >/dev/null \
    && log "saved build cache for the next deploy" || log "cache save skipped"
  rm -f /tmp/cache.tgz
}
# --------------------------------------------------------------------------

SRC="$(pwd)"     # Cloud Build mounts the user's source here (/workspace).
APP=/app         # Build at the SAME path the runner serves from, so any absolute
mkdir -p "$APP"  # paths baked into deps (a Python venv's shebangs) stay valid.
cp -a "$SRC/." "$APP/"
cd "$APP"
restore_cache

# ── install ────────────────────────────────────────────────────────────────
#
# An explicit install command from the plan replaces the convention entirely.
#
# The convention is "look at the repo root: package.json means Node, else
# requirements.txt means Python" — which answers "what is this repo" by inspecting
# exactly one directory. A monorepo does not have that shape:
# `backend/requirements.txt` beside `frontend/package.json` matches NEITHER
# branch, so NOTHING was installed and the app died at start with no
# dependencies. The planner could already see the right answer — `plan.install`
# has existed all along — and it was dropped on the way here, so the agent had no
# way to say it.
#
# Both runner images now carry both toolchains for exactly this: one command may
# install Python and Node dependencies from different subdirectories.
plan_cmd() {  # $1 = env var name; echoes the decoded command
  eval "v=\${$1:-}"
  printf '%s' "$v" | base64 -d 2>/dev/null || printf '%s' "$v" | base64 --decode
}

# node_modules/.bin and .venv/bin on PATH for every plan-supplied command, so a
# bare `nx` / `prisma` / `tsc` / `alembic` resolves the way it does under `npm run`
# or inside an activated venv. Without this the first local binary 127s.
bin_path() { printf '%s' "$APP/node_modules/.bin:$APP/.venv/bin:$PATH"; }

export HUSKY=0    # the near-universal `"prepare": "husky"` hook 127s with no .git

if [ -n "${BAY_INSTALL_B64+x}" ]; then
  icmd=$(plan_cmd BAY_INSTALL_B64)
  # The venv is created up front for a Python app and put on PATH, so a
  # `pip install -r backend/requirements.txt` anywhere in the command lands in it
  # rather than in the image's global site-packages, which the serving container
  # does not carry forward.
  if [ "${BAY_LANG:-}" = "python" ] && [ ! -d .venv ]; then
    log "creating .venv"
    python -m venv .venv 2>/dev/null || python3 -m venv .venv
  fi
  if [ -n "$icmd" ]; then
    log "install (from plan): $icmd"
    PATH="$(bin_path)" sh -c "$icmd"
  else
    log "plan: no install step"
  fi
elif [ -f package.json ]; then
  # --include=dev is mandatory: the base image sets NODE_ENV=production (correct for
  # runtime), and under that npm install SKIPS devDependencies — but the build needs
  # them (typescript, tailwind, bundlers all live in devDeps for most real apps).
  if [ -f package-lock.json ]; then
    npm ci --include=dev --prefer-offline --no-audit --no-fund || npm install --include=dev --prefer-offline --no-audit --no-fund
  else
    npm install --include=dev --prefer-offline --no-audit --no-fund
  fi
elif [ -f requirements.txt ] || [ -f pyproject.toml ]; then
  # A venv ships with the bundle so serving needs no install and the app's
  # gunicorn/uvicorn/streamlit resolve from .venv/bin at runtime.
  python -m venv .venv
  if [ -f requirements.txt ]; then
    ./.venv/bin/pip install --find-links="${PIP_WHEELHOUSE:-/opt/wheels}" -r requirements.txt
  else
    ./.venv/bin/pip install --find-links="${PIP_WHEELHOUSE:-/opt/wheels}" .
  fi
fi

# ── build ──────────────────────────────────────────────────────────────────
#
# Hoisted out of the Node branch, where it used to live. Nested there it could
# only ever run for a repo with a package.json at its ROOT — so a Python app with
# a frontend to build, or any monorepo, silently skipped its build step even when
# the plan named one.
if [ -n "${BAY_BUILD_B64+x}" ]; then
  bcmd=$(plan_cmd BAY_BUILD_B64)
  if [ -n "$bcmd" ]; then
    log "build (from plan): $bcmd"
    PATH="$(bin_path)" sh -c "$bcmd"
  else
    log "plan: no build step"
  fi
elif [ -f package.json ] && node -e "process.exit((require('./package.json').scripts||{}).build?0:1)" 2>/dev/null; then
  log "npm run build"
  npm run build
fi

# Proof for the serving container that install and build already happened here.
# It used to infer that from a root package.json + node_modules, which a monorepo
# does not have — so a prepared bundle looked unprepared and reinstalled on every
# cold start.
: > "$APP/.supersonic-prepared"

save_cache

OUT="${BAY_OUT:-ready.tgz}"
log "packaging $OUT with dependencies baked in"
# .env* is never shipped — its values arrive as injected runtime env, not baked in.
tar -czf "$SRC/$OUT" --exclude=./.git --exclude=./.env --exclude=./.env.local --exclude="./.env.*.local" --exclude="./$OUT" .

# Encrypt with the per-deploy key so the bundle sitting in the shared bucket is
# unreadable to any other app: the runtime service account may read the bytes, but
# only THIS app has the key (injected as env) to decrypt them. That is what lets a
# shared runtime identity be safe without per-app IAM or an expiring signed URL.
if [ -n "${BAY_CODE_KEY:-}" ]; then
  log "encrypting bundle (per-app key)"
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass "pass:$BAY_CODE_KEY" -in "$SRC/$OUT" -out "$SRC/$OUT.enc"
  mv "$SRC/$OUT.enc" "$SRC/$OUT"
fi
log "done"
