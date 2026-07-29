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

SRC="$(pwd)"     # Cloud Build mounts the user's source here (/workspace).
APP=/app         # Build at the SAME path the runner serves from, so any absolute
mkdir -p "$APP"  # paths baked into deps (a Python venv's shebangs) stay valid.
cp -a "$SRC/." "$APP/"
cd "$APP"

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

OUT="${SUPERSONIC_OUT:-ready.tgz}"
log "packaging $OUT with dependencies baked in"
# .env* is never shipped — its values arrive as injected runtime env, not baked in.
tar -czf "$SRC/$OUT" --exclude=./.git --exclude=./.env --exclude=./.env.local --exclude="./.env.*.local" --exclude="./$OUT" .
log "done"
