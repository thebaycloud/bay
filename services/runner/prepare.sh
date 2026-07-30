#!/bin/sh
# Supersonic prepare — runs ONCE per deploy, inside Cloud Build, on the runner
# image (so the warm dependency cache / wheelhouse is available). It installs the
# app's dependencies and builds it, then tars the whole thing — deps included —
# into a ready-to-run bundle.
#
# The point: serving instances just fetch that bundle and run it, so NO install
# happens when Cloud Run starts a new instance (first visit or scale-up). Install
# once here, run many there.
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
  [ -n "${SUPERSONIC_CACHE_BUCKET:-}" ] || return 0
  t=$(gcs_token); [ -n "$t" ] || return 0
  enc=$(printf '%s' "$SUPERSONIC_CACHE_OBJECT" | sed 's:/:%2F:g')
  if curl -sf -H "Authorization: Bearer $t" \
      "https://storage.googleapis.com/storage/v1/b/$SUPERSONIC_CACHE_BUCKET/o/$enc?alt=media" -o /tmp/cache.tgz; then
    tar -xzf /tmp/cache.tgz -C "$APP" 2>/dev/null && log "restored build cache" || log "cache entry unusable — ignoring"
    rm -f /tmp/cache.tgz
  else
    log "no build cache yet — this deploy warms it for the next"
  fi
}
save_cache() {
  [ -n "${SUPERSONIC_CACHE_BUCKET:-}" ] || return 0
  paths=""; for d in $CACHE_DIRS; do [ -e "$d" ] && paths="$paths $d"; done
  [ -n "$paths" ] || return 0
  t=$(gcs_token); [ -n "$t" ] || return 0
  tar -czf /tmp/cache.tgz $paths 2>/dev/null || return 0
  enc=$(printf '%s' "$SUPERSONIC_CACHE_OBJECT" | sed 's:/:%2F:g')
  curl -sf -X POST -H "Authorization: Bearer $t" -H "Content-Type: application/gzip" --data-binary @/tmp/cache.tgz \
      "https://storage.googleapis.com/upload/storage/v1/b/$SUPERSONIC_CACHE_BUCKET/o?uploadType=media&name=$enc" >/dev/null \
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

if [ -f package.json ]; then
  if [ -f package-lock.json ]; then
    npm ci --prefer-offline --no-audit --no-fund || npm install --prefer-offline --no-audit --no-fund
  else
    npm install --prefer-offline --no-audit --no-fund
  fi
  # Build by convention (Next/Nuxt/etc.) — the script name is the convention.
  if node -e "process.exit((require('./package.json').scripts||{}).build?0:1)" 2>/dev/null; then
    log "npm run build"
    npm run build
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

save_cache

OUT="${SUPERSONIC_OUT:-ready.tgz}"
log "packaging $OUT with dependencies baked in"
# .env* is never shipped — its values arrive as injected runtime env, not baked in.
tar -czf "$SRC/$OUT" --exclude=./.git --exclude=./.env --exclude=./.env.local --exclude="./.env.*.local" --exclude="./$OUT" .

# Encrypt with the per-deploy key so the bundle sitting in the shared bucket is
# unreadable to any other app: the runtime service account may read the bytes, but
# only THIS app has the key (injected as env) to decrypt them. That is what lets a
# shared runtime identity be safe without per-app IAM or an expiring signed URL.
if [ -n "${SUPERSONIC_CODE_KEY:-}" ]; then
  log "encrypting bundle (per-app key)"
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass "pass:$SUPERSONIC_CODE_KEY" -in "$SRC/$OUT" -out "$SRC/$OUT.enc"
  mv "$SRC/$OUT.enc" "$SRC/$OUT"
fi
log "done"
