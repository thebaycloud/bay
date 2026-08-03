#!/usr/bin/env bash
# Smoke test: a real customer app image runs in a gVisor sandbox on this node,
# and a sandbox cannot reach the metadata credentials API.
#
# Run with sudo. The token fetch needs it — the nftables rule from provision.sh
# allows uid 0 and 987 (the `supersonic` user the agent runs as) and nobody else,
# so an interactive login user is correctly denied.
set -euo pipefail

REPO=us-central1-docker.pkg.dev/supersonic-deploy-prod/cloud-run-source-deploy
IMG="${1:-$REPO/a8ebb:latest}"

token() {
  curl -s -H 'Metadata-Flavor: Google' \
    http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'
}

echo "=== pulling $IMG"
ctr images pull --user "oauth2accesstoken:$(token)" "$IMG" >/dev/null 2>&1 \
  || { echo "PULL FAILED"; exit 1; }
echo "ok"

echo "=== kernel as reported inside a runsc sandbox"
ctr run --rm --runtime io.containerd.runsc.v1 "$IMG" smoke-runsc uname -a

echo "=== kernel as reported inside a runc container"
ctr run --rm "$IMG" smoke-runc uname -a

echo "=== can a sandbox reach the metadata credentials API? (must fail)"
if ctr run --rm --runtime io.containerd.runsc.v1 --net-host "$IMG" smoke-meta \
     curl -s -m 5 -H 'Metadata-Flavor: Google' \
     http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token 2>/dev/null \
     | grep -q access_token; then
  echo "LEAK: a sandbox read the node's service account token"
  exit 1
fi
echo "blocked (correct)"
