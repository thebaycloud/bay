#!/usr/bin/env bash
# Isolate where the containerd -> runsc path breaks. Run with sudo.
# No pipes on the commands under test: a pipe makes $? the exit code of `tail`,
# which is how the first three attempts at this reported success while producing
# no output.
set -u

IMG="${1:-us-central1-docker.pkg.dev/supersonic-deploy-prod/cloud-run-source-deploy/a8ebb:latest}"
OUT=/tmp/runsc-debug
rm -rf "$OUT"; mkdir -p "$OUT"

run() {
  local name="$1"; shift
  echo "=== $name"
  timeout 40 "$@" >"$OUT/$name.out" 2>"$OUT/$name.err"
  local rc=$?
  echo "    exit=$rc"
  echo "    stdout: $(tr '\n' '|' < "$OUT/$name.out" | head -c 200)"
  echo "    stderr: $(tr '\n' '|' < "$OUT/$name.err" | tail -c 300)"
}

ctr c rm dbg-hostns dbg-ownns 2>/dev/null
ip netns delete sbtest 2>/dev/null
ip netns add sbtest
ip netns exec sbtest ip link set lo up

run runc-control \
  ctr run --rm "$IMG" ctl-$$ /bin/sh -c 'echo RUNC_OK'

run runsc-hostns \
  ctr run --rm --runtime io.containerd.runsc.v1 "$IMG" dbg-hostns /bin/sh -c 'echo RUNSC_HOSTNS_OK'

run runsc-ownns \
  ctr run --rm --runtime io.containerd.runsc.v1 --with-ns network:/var/run/netns/sbtest \
    "$IMG" dbg-ownns /bin/sh -c 'echo RUNSC_OWNNS_OK'

echo "=== leftover containers/tasks"
ctr c ls 2>&1 | head -5
ctr t ls 2>&1 | head -5

echo "=== runsc sandboxes known to the shim's root"
for root in /run/containerd/runsc/default /run/containerd/runsc/k8s.io /run/containerd/io.containerd.runtime.v2.task/default; do
  [ -e "$root" ] && { echo "-- $root"; ls "$root" 2>/dev/null | head -5; }
done

echo "=== containerd journal, last 20"
journalctl -u containerd --since '3 min ago' --no-pager -q 2>&1 | tail -20
