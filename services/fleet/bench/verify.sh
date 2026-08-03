#!/usr/bin/env bash
# Prove the four things that have to be true for the fleet design to hold.
# Run with sudo.
set -u
RUNSC="/usr/local/bin/runsc --root=/run/supersonic/runsc"

ADDR=$(python3 -c "
import json
print(json.load(open('/srv/state/routes.json'))[0]['addr'])" 2>/dev/null)
SLUG=$(python3 -c "
import json
print(json.load(open('/srv/state/routes.json'))[0]['slug'])" 2>/dev/null)

echo "app=$SLUG addr=$ADDR"
echo

echo "=== 1. does the app actually serve HTTP?"
curl -s -m 8 -o /tmp/body.html -w 'status=%{http_code} bytes=%{size_download} ttfb=%{time_starttransfer}s\n' "http://$ADDR/" \
  || echo "REQUEST FAILED"
head -c 160 /tmp/body.html 2>/dev/null; echo
echo

echo "=== 2. is it really gVisor inside?"
$RUNSC exec "$SLUG" /bin/sh -c 'uname -r' 2>/dev/null || echo "exec unavailable"
echo

echo "=== 3. can the app read the node's service account token? (must fail)"
if $RUNSC exec "$SLUG" /bin/sh -c \
   'wget -q -T 4 -O - --header="Metadata-Flavor: Google" http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token 2>/dev/null || curl -s -m 4 -H "Metadata-Flavor: Google" http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token 2>/dev/null' \
   2>/dev/null | grep -q access_token; then
  echo "LEAK: sandbox read the node's token"
else
  echo "blocked (correct)"
fi
echo

echo "=== 4. does DNS work inside the sandbox? (it needs 53 to the same address)"
$RUNSC exec "$SLUG" /bin/sh -c 'getent hosts storage.googleapis.com 2>/dev/null | head -1' 2>/dev/null \
  || echo "(no getent in image)"
echo

echo "=== resident cost: sandbox processes for $SLUG"
ps -eo rss,comm,args 2>/dev/null | grep '[r]unsc-' | awk '{s+=$1} END {printf "  runsc processes RSS total: %.1f MB\n", s/1024}'
cat /sys/fs/cgroup/supersonic/$SLUG/memory.current 2>/dev/null \
  | awk '{printf "  cgroup memory.current: %.1f MB\n", $1/1048576}'
