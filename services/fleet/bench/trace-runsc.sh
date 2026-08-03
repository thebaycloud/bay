#!/usr/bin/env bash
# Force runsc to log regardless of whether the shim honours
# /etc/containerd/runsc.toml, by interposing a wrapper on the binary the shim
# execs. Run with sudo.
#
# This exists because three attempts to get a runsc log out of the containerd
# path produced no file at all, which left the hang completely opaque.
set -u

REAL=/usr/local/bin/runsc.real
WRAP=/usr/local/bin/runsc

if [ ! -x "$REAL" ]; then
  cp "$WRAP" "$REAL"
fi

cat > "$WRAP" <<'EOF'
#!/bin/bash
# Interposer: adds debug logging to every runsc invocation the shim makes.
exec /usr/local/bin/runsc.real \
  --debug \
  --debug-log=/var/log/runsc/ \
  --strace \
  --log-packets \
  "$@"
EOF
chmod +x "$WRAP"

# runsc looks for gvisor-bin/ next to its OWN binary. The wrapper is at the same
# path, and it execs runsc.real which is also there, so the sidecar directory is
# still found. Assert it rather than trust it.
test -d /usr/local/bin/gvisor-bin || { echo "gvisor-bin missing"; exit 1; }

rm -rf /var/log/runsc; mkdir -p /var/log/runsc

IMG="${1:-us-central1-docker.pkg.dev/supersonic-deploy-prod/cloud-run-source-deploy/a8ebb:latest}"
ID="trace-$$"

echo "=== running $ID under the traced runsc (40s cap)"
timeout 40 ctr run --rm --runtime io.containerd.runsc.v1 "$IMG" "$ID" /bin/sh -c 'echo INSIDE' \
  >/tmp/trace.out 2>/tmp/trace.err
echo "exit=$?"
echo "stdout: $(cat /tmp/trace.out)"
echo "stderr: $(tail -c 400 /tmp/trace.err)"

echo
echo "=== runsc debug logs produced"
ls -la /var/log/runsc/ 2>&1 | head -10
echo
echo "=== first error-ish lines across all logs"
grep -hiE 'error|fail|fatal|panic|refus|denied|no such|timeout' /var/log/runsc/* 2>/dev/null | head -30
echo
echo "=== tail of the boot log"
for f in /var/log/runsc/*boot*; do [ -e "$f" ] && { echo "-- $f"; tail -40 "$f"; break; }; done
