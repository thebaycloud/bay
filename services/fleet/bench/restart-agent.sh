#!/usr/bin/env bash
# Rebuild and restart the agent, clearing any sandbox it left behind.
#
# This lives in a file rather than inline over ssh for a reason that cost three
# dropped sessions: `pkill -f supersonicd` issued as part of an ssh command
# matches the ssh command's OWN command line, so the node kills the shell running
# the kill. Every process match here is -x (exact comm), never -f.
set -u

export PATH=$PATH:/usr/local/go/bin
RUNSC="/usr/local/bin/runsc --root=/run/supersonic/runsc"

cd /opt/agent || exit 1
if ! go build -o supersonicd . ; then
  echo "BUILD FAILED"
  exit 1
fi
echo "built"

pkill -x supersonicd 2>/dev/null
sleep 1

# Tear down every sandbox this agent owns, so a restart is a clean slate.
for id in $($RUNSC list 2>/dev/null | awk 'NR>1 {print $1}'); do
  $RUNSC kill "$id" SIGKILL >/dev/null 2>&1
  $RUNSC delete --force "$id" >/dev/null 2>&1
done
for m in $(mount | awk '/\/srv\/state\/bundles/ {print $3}'); do
  umount -l "$m" 2>/dev/null
done
rm -rf /srv/state/bundles /srv/state/routes.json

# Stale namespaces and veths from killed runs, so addressing starts clean.
for ns in $(ip netns list 2>/dev/null | awk '/^ss-/ {print $1}'); do
  ip netns delete "$ns" 2>/dev/null
done
for l in $(ip -o link show 2>/dev/null | awk -F': ' '/ vh-/ {print $2}' | cut -d@ -f1); do
  ip link delete "$l" 2>/dev/null
done

: > /var/log/supersonicd.log
nohup /opt/agent/supersonicd -interval "${INTERVAL:-10s}" >> /var/log/supersonicd.log 2>&1 &
echo "agent started pid $!"
