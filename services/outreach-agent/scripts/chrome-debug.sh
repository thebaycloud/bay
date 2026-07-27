#!/usr/bin/env bash
# Launch Chrome with a debugging port for the outreach agent to attach to.
#
# Deliberately uses a SEPARATE profile directory rather than your everyday one:
# --remote-debugging-port lets any local process drive the browser and read its
# cookies for every site it is signed into. Scoping it to a profile that only
# holds the LinkedIn account you log in here keeps that blast radius small.
set -euo pipefail

PORT="${CDP_PORT:-9222}"
PROFILE="${CHROME_PROFILE_DIR:-$HOME/.outreach-chrome}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [ ! -x "$CHROME" ]; then
  echo "Chrome not found at: $CHROME" >&2
  echo "Set CHROME_BIN to your Chrome binary." >&2
  exit 1
fi

if curl -s --max-time 1 "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
  echo "Chrome is already listening on :${PORT}"
  exit 0
fi

mkdir -p "$PROFILE"
echo "Launching Chrome on :${PORT} with profile ${PROFILE}"
echo "Log into LinkedIn in this window, then run: outreach-agent likers <post-url>"
exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  "https://www.linkedin.com/feed/"
