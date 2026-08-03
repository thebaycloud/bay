#!/usr/bin/env bash
# Step 0, item 2: what does one resident app actually cost on a fleet node?
#
# Every capacity claim in docs/VM-FLEET.md is a placeholder until this runs.
# The plan says "a few hundred apps per node" from arithmetic on a ~120 MB Node
# app plus a ~45 MB sandbox tax; this replaces that with a measurement on real
# customer images.
#
# Usage: sudo bash density.sh <count>
set -u

N="${1:-25}"
RUNSC="/usr/local/bin/runsc --root=/run/supersonic/runsc"
REPO=us-central1-docker.pkg.dev/supersonic-deploy-prod/cloud-run-source-deploy

# Real customer images. Distinct ones matter: identical images would share page
# cache for the rootfs and flatter the result.
IMAGES=(a8ebb acce7 anatf bmoj5 bnzxu cx1qz dp7ul ex4id ezjo2 h7xm1 hdhxq hl52l
        hn9ll hxor3 iuc26 jkopx jlf8x km0g0 kngsu m4vtu m5gl3)

echo "=== generating desired state for $N apps"
{
  echo '{ "apps": ['
  for i in $(seq 1 "$N"); do
    img="${IMAGES[$(( (i-1) % ${#IMAGES[@]} ))]}"
    slug=$(printf "bench%03d" "$i")
    sep=","; [ "$i" -eq "$N" ] && sep=""
    printf '  {"slug":"%s","image":"%s/%s:latest","port":8080}%s\n' "$slug" "$REPO" "$img" "$sep"
  done
  echo '] }'
} > /srv/state/desired.json

free -m | awk '/^Mem:/ {printf "baseline: used=%s MB available=%s MB\n", $3, $7}'

echo "=== restarting agent and waiting for convergence"
START=$(date +%s)
INTERVAL=5s bash /tmp/restart-agent.sh >/dev/null 2>&1

# Converged = the running count stops climbing for three consecutive polls.
prev=-1; stable=0
for _ in $(seq 1 120); do
  sleep 5
  now=$($RUNSC list 2>/dev/null | awk 'NR>1 && $3=="running"' | wc -l)
  if [ "$now" -eq "$prev" ]; then stable=$((stable+1)); else stable=0; fi
  prev=$now
  [ "$stable" -ge 3 ] && break
done
ELAPSED=$(( $(date +%s) - START ))

RUNNING=$($RUNSC list 2>/dev/null | awk 'NR>1 && $3=="running"' | wc -l)
HEALTHY=$(python3 -c "
import json
try:
    r=json.load(open('/srv/state/routes.json'))
    print(sum(1 for x in r if x['healthy']))
except Exception: print(0)")

echo
echo "=== RESULT"
echo "requested:        $N"
echo "running:          $RUNNING"
echo "healthy:          $HEALTHY"
echo "time to converge: ${ELAPSED}s"
echo

free -m | awk '/^Mem:/ {printf "node: used=%s MB free=%s MB available=%s MB\n", $3, $4, $7}'

echo
echo "=== per-app cgroup memory.current"
total=0; count=0; max=0; min=999999
for d in /sys/fs/cgroup/supersonic/*/; do
  [ -f "$d/memory.current" ] || continue
  v=$(cat "$d/memory.current" 2>/dev/null || echo 0)
  mb=$(( v / 1048576 ))
  total=$(( total + mb )); count=$(( count + 1 ))
  [ "$mb" -gt "$max" ] && max=$mb
  [ "$mb" -lt "$min" ] && min=$mb
done
if [ "$count" -gt 0 ]; then
  echo "apps measured: $count"
  echo "sum:           ${total} MB"
  echo "mean:          $(( total / count )) MB"
  echo "min / max:     ${min} MB / ${max} MB"
  echo
  echo "at this mean, 55 GiB of usable RAM holds ~$(( 56320 / (total / count + 1) )) apps"
fi

echo
echo "=== swap / compression in play?"
free -m | awk '/^Swap:/ {printf "swap: used=%s MB total=%s MB\n", $3, $2}'
echo
echo "=== failures, if any"
grep -c 'start failed' /var/log/supersonicd.log 2>/dev/null || true
grep 'start failed' /var/log/supersonicd.log 2>/dev/null | tail -3
