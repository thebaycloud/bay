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

# Turn the downloaded /tmp/code.tgz into the app at $APP. If a per-app key is set
# the bundle is encrypted (see below), so decrypt first. A wrong/absent key can't
# decrypt another app's bundle — that is the isolation guarantee.
unpack() {
  if [ -n "${SUPERSONIC_CODE_KEY:-}" ]; then
    openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:$SUPERSONIC_CODE_KEY" -in /tmp/code.tgz -out /tmp/code.dec 2>/dev/null \
      || { log "FATAL: could not decrypt the code bundle (wrong key?)"; exit 1; }
    mv /tmp/code.dec /tmp/code.tgz
  fi
  tar -xzf /tmp/code.tgz -C "$APP"
  rm -f /tmp/code.tgz
}

# Pull the code bundle. Primary path: the runtime SA reads the ENCRYPTED bundle
# from the bucket — safe because the bytes are encrypted and only this app holds
# the key ($SUPERSONIC_CODE_KEY), so one app can never read another's source. A
# per-object signed URL is also honoured if set (no bucket access needed). Both
# routes fetch to /tmp/code.tgz and hand off to unpack().
fetch_code() {
  mkdir -p "$APP"
  if [ -n "${SUPERSONIC_CODE_URL:-}" ]; then
    log "fetching code (signed URL)"
    code=$(curl -s -o /tmp/code.tgz -w '%{http_code}' "$SUPERSONIC_CODE_URL")
    if [ "$code" != "200" ]; then
      log "FATAL: signed-URL fetch failed — HTTP $code (the link may have expired; redeploy to refresh it)"
      exit 1
    fi
    unpack
    return 0
  fi
  # Fallback: read straight from GCS with the runtime SA's own token — no keys in
  # the image. Object names contain slashes, so percent-encode into the API path.
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
  unpack
}

{ [ -n "${SUPERSONIC_CODE_URL:-}" ] || [ -n "${SUPERSONIC_CODE_BUCKET:-}" ]; } && fetch_code
cd "$APP"

# A Python bundle prepared at deploy ships a .venv — put it first on PATH so the
# app's gunicorn/uvicorn/streamlit resolve from it with no global install.
[ -d "$APP/.venv/bin" ] && export PATH="$APP/.venv/bin:$PATH"
# Same for Node: a plan's run command may use bare `prisma`/`next`/etc. — put the
# app's local bin on PATH so they resolve, matching how `npm run` invokes scripts.
[ -d "$APP/node_modules/.bin" ] && export PATH="$APP/node_modules/.bin:$PATH"

# Wait for the Cloud SQL proxy to accept a connection before anything runs.
#
# The proxy is a SIDECAR container, and `--depends-on cloudsql-proxy` orders
# container START, not port readiness: Cloud Run starts the proxy first and then
# starts this one, while the proxy is still authenticating and binding. An app
# that connects at import time — every Django settings module that checks the
# database, every SQLAlchemy engine created at module scope, and every migration
# in the release job, which runs through this same entrypoint — can lose that
# race and die on "connection refused" against a proxy that was listening 200ms
# later. On the runner lane that surfaces as "didn't start on $PORT", which sends
# whoever reads it looking at the app's port handling instead.
#
# Only when the platform gave this app a database: PGHOST is written by
# databaseEnv() for exactly those apps and by nothing else. Bounded, and it gives
# up quietly — the app's own connection error names the host and port, and a wait
# that turned a slow proxy into a startup-probe timeout would replace a
# diagnosable failure with an undiagnosable one.
wait_for_db() {
  host="${PGHOST:-127.0.0.1}"; port="${PGPORT:-5432}"
  i=0
  while [ "$i" -lt 30 ]; do
    if python3 -c "import socket,sys;s=socket.socket();s.settimeout(1);sys.exit(s.connect_ex(('$host',$port)))" >/dev/null 2>&1; then
      [ "$i" -gt 0 ] && log "database reachable after ${i}s"
      return 0
    fi
    # Both runner images carry node as well as python3 (each installs the other
    # for prepare-time monorepo builds), so a missing interpreter is not a reason
    # to skip the wait.
    if node -e "const s=require('net').connect($port,'$host');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1000)" >/dev/null 2>&1; then
      [ "$i" -gt 0 ] && log "database reachable after ${i}s"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  log "the database at $host:$port did not answer in ${i}s — starting anyway, the app's own error will say more"
}
if [ -n "${PGHOST:-}" ]; then wait_for_db; fi

# If dependencies are already present, this is a prepared bundle: install and
# build ran ONCE at deploy, so a starting instance does neither — this is the
# whole point (install once, run many). If they're absent, fall back to
# reconciling here so a raw-source deploy still works. Language is inferred from
# the manifest present — a two-way Node/Python fork, not a framework matrix.
# prepare.sh leaves this marker. It used to be inferred from a root package.json
# plus node_modules (or a root requirements.txt plus .venv) — a guess that is
# simply false for a monorepo, whose manifests live in subdirectories. Such an app
# looked unprepared to every starting instance and reinstalled its dependencies on
# each cold start, which is the exact cost this whole lane exists to avoid.
prepared=""
[ -f .supersonic-prepared ] && prepared=1
# Bundles built before the marker existed still have to start.
{ [ -f package.json ] && [ -d node_modules ]; } && prepared=1
{ { [ -f requirements.txt ] || [ -f pyproject.toml ]; } && [ -d .venv ]; } && prepared=1

if [ -n "$prepared" ]; then
  log "prepared bundle — dependencies already installed, skipping install/build"
else
  if [ -f package.json ]; then
    # --include=dev: NODE_ENV=production (image default) makes npm skip devDeps, but the
    # build needs them. HUSKY=0: skip the common `prepare: husky` hook (no .git here).
    export HUSKY=0
    if [ -f package-lock.json ]; then
      npm ci --include=dev --prefer-offline --no-audit --no-fund || npm install --include=dev --prefer-offline --no-audit --no-fund
    else
      npm install --include=dev --prefer-offline --no-audit --no-fund
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
# How to run the app. The RIGHT source is $SUPERSONIC_RUN — the production run
# command handed over by the deploying agent (which knows the stack). It's the
# only reliable answer for Python (uvicorn vs gunicorn vs flask is unguessable).
# Without it we fall back to a sensible default for Node only.
RUN="${SUPERSONIC_RUN:-}"
if [ -z "$RUN" ]; then
  if [ -f package.json ]; then
    # A BUILT Next app must run its production server, not the app's `start`
    # script — real apps often set `start` to `next dev`, which binds localhost /
    # boots too slowly to pass the health check.
    if [ -d .next ] && node -e "var p=require('./package.json');process.exit((p.dependencies&&p.dependencies.next)||(p.devDependencies&&p.devDependencies.next)?0:1)" 2>/dev/null; then
      RUN="npx --no-install next start -p ${PORT}"
    else
      RUN="npm start"
    fi
  else
    log "FATAL: no run command for this app — the deploy must supply one (the agent"
    log "       passes the production command; Python especially can't be guessed)"
    exit 1
  fi
fi
log "starting on :$PORT → $RUN"
exec sh -c "$RUN"
