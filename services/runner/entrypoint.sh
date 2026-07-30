#!/bin/sh
# Supersonic runner entrypoint — identical on every app that runs on this base.
#
# The base image already carries a warm dependency cache for the popular
# packages, so there is NO per-app image to build. At container start we:
#   1. fetch the user's code bundle from GCS (uploaded at deploy time),
#   2. reconcile dependencies against the warm cache (fast — most are present),
#   3. optionally run a build step, then
#   4. exec the app's start command on $PORT.
#
# No framework detection lives here on purpose. How to build/run the app is
# handed in via env ($SUPERSONIC_BUILD / $SUPERSONIC_RUN) — by the CLI/agent that
# already knows the stack, by opencode for the weird 10%, or a language default
# (Node → `npm start`). That is the whole point: the knowledge lives with the
# agent, not in a detector matrix baked into our platform.
set -eu

PORT="${PORT:-8080}"
APP="/app"
log() { echo "[supersonic-run] $*"; }

# Pull the code bundle using the container's own runtime service account via the
# metadata server — no keys in the image. The runtime SA needs storage.objectViewer
# on the code bucket. Object names contain slashes, so they are percent-encoded
# into the JSON API object path.
fetch_code() {
  bucket="$SUPERSONIC_CODE_BUCKET"
  object="$SUPERSONIC_CODE_OBJECT"
  log "fetching gs://$bucket/$object"
  token=$(curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
    | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')
  [ -n "$token" ] || { log "FATAL: no token from metadata server"; exit 1; }
  enc=$(printf '%s' "$object" | sed 's:/:%2F:g')
  # Keep the HTTP status. "code download failed" sent the repair agent hunting
  # through the customer's code for six minutes and three redeploys over what was
  # a 403: the runtime service account these apps run as has no read access to the
  # assets bucket, so the container never had its code. The status says which of
  # those it is, and the message names the identity that was refused.
  code=$(curl -s -o /tmp/code.tgz -w '%{http_code}' -H "Authorization: Bearer $token" \
    "https://storage.googleapis.com/storage/v1/b/$bucket/o/$enc?alt=media")
  if [ "$code" != "200" ]; then
    sa=$(curl -sf -H "Metadata-Flavor: Google" \
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email" || echo "unknown")
    log "FATAL: could not read gs://$bucket/$object — HTTP $code as $sa"
    [ "$code" = "403" ] && log "that identity is not allowed to read the code bundle — this is a platform misconfiguration, not a problem with the app"
    exit 1
  fi
  mkdir -p "$APP"
  tar -xzf /tmp/code.tgz -C "$APP"
  rm -f /tmp/code.tgz
}

[ -n "${SUPERSONIC_CODE_BUCKET:-}" ] && fetch_code
cd "$APP"

# A Python bundle prepared at deploy ships a .venv — put it first on PATH so the
# app's gunicorn/uvicorn/streamlit resolve from it with no global install.
[ -d "$APP/.venv/bin" ] && export PATH="$APP/.venv/bin:$PATH"

# If dependencies are already present, this is a prepared bundle: install and
# build ran ONCE at deploy, so a starting instance does neither — this is the
# whole point (install once, run many). If they're absent, fall back to
# reconciling here so a raw-source deploy still works. Language is inferred from
# the manifest present — a two-way Node/Python fork, not a framework matrix.
prepared=""
{ [ -f package.json ] && [ -d node_modules ]; } && prepared=1
{ { [ -f requirements.txt ] || [ -f pyproject.toml ]; } && [ -d .venv ]; } && prepared=1

if [ -n "$prepared" ]; then
  log "prepared bundle — dependencies already installed, skipping install/build"
else
  if [ -f package.json ]; then
    if [ -f package-lock.json ]; then
      npm ci --prefer-offline --no-audit --no-fund || npm install --prefer-offline --no-audit --no-fund
    else
      npm install --prefer-offline --no-audit --no-fund
    fi
  elif [ -f requirements.txt ]; then
    pip install --no-cache-dir --find-links="${PIP_WHEELHOUSE:-/opt/wheels}" -r requirements.txt
  elif [ -f pyproject.toml ]; then
    pip install --no-cache-dir --find-links="${PIP_WHEELHOUSE:-/opt/wheels}" .
  fi
  # Build by convention (Node `build` script) — only on the fallback path; a
  # prepared bundle is already built.
  if [ -z "${SUPERSONIC_BUILD:-}" ] && [ -f package.json ]; then
    if node -e "process.exit((require('./package.json').scripts||{}).build?0:1)" 2>/dev/null; then
      SUPERSONIC_BUILD="npm run build"
    fi
  fi
  if [ -n "${SUPERSONIC_BUILD:-}" ]; then
    log "build: $SUPERSONIC_BUILD"
    sh -c "$SUPERSONIC_BUILD"
  fi
fi

# Run. Default to the language's conventional start; override with $SUPERSONIC_RUN.
RUN="${SUPERSONIC_RUN:-}"
if [ -z "$RUN" ]; then
  if [ -f package.json ]; then
    RUN="npm start"
  else
    log "FATAL: no start command — set SUPERSONIC_RUN"; exit 1
  fi
fi
log "starting on :$PORT → $RUN"
exec sh -c "$RUN"
