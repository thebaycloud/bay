#!/usr/bin/env bash
# Provision the build host: a long-lived BuildKit with a local, warm cache.
#
# WHY THIS EXISTS. Builds were 54 s of a measured 238 s deploy, and the cache was
# `--cache-from type=registry` pulled onto a CLEAN Cloud Build worker every time —
# which the architecture spec calls "not a cache; a slow registry". A daemon that
# stays up keeps its cache on local SSD, so the second build of an app touches
# almost nothing.
#
# Idempotent, like services/fleet/image/provision.sh, and safe to re-run.
#
# NO `| grep -q` ANYWHERE IN THIS FILE. Under `set -euo pipefail` that construct
# inverts its own answer: grep exits at the first match, the producer takes
# SIGPIPE and exits 141, and pipefail makes the pipeline fail exactly when the
# thing being looked for is present. It cost the fleet a node — see the comment
# at the top of provision.sh.
set -euo pipefail

BUILDKIT_VERSION="${BUILDKIT_VERSION:-v0.32.2}"
CERT_DIR=/etc/buildkit/certs
LISTEN_ADDR="${LISTEN_ADDR:-$(hostname -I | awk '{print $1}')}"

log() { echo "[buildkit] $*" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  log "FATAL: run as root"
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. The daemon
# ---------------------------------------------------------------------------
if [ ! -x /usr/local/bin/buildkitd ]; then
  log "installing buildkit ${BUILDKIT_VERSION}"
  # The archive is `bin/buildkitd`, `bin/buildctl`, … so extracting into
  # /usr/local puts them on PATH as-is. `--strip-components=1` would drop the
  # `bin/` and land them in /usr/local directly, which is where the first run of
  # this script put them — the next line then reported an empty version and the
  # daemon never started.
  curl -fsSL "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-amd64.tar.gz" \
    | tar -xz -C /usr/local
fi
log "buildkitd $(/usr/local/bin/buildkitd --version)"

# runc is what buildkitd executes build steps with. The distro package is fine:
# nothing here is a tenant sandbox — a BUILD is already arbitrary code by design,
# which is why this host runs nothing else and holds no secrets.
if ! command -v runc >/dev/null 2>&1; then
  log "installing runc"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq runc >/dev/null
fi

# ---------------------------------------------------------------------------
# 2. mTLS, because an unauthenticated buildkitd is remote code execution
# ---------------------------------------------------------------------------
#
# The daemon listens on a private VPC address with a firewall in front, and that
# is NOT enough on its own: the same VPC carries fleet nodes running other
# people's code. Defence in depth means the network reachability and the identity
# check are separate, so one mistake is not the whole story.
#
# A private CA rather than a public one: both ends are ours, the names are
# internal, and there is no third party whose opinion would add anything.
if [ ! -f "$CERT_DIR/ca.pem" ]; then
  log "generating a private CA and certificates for ${LISTEN_ADDR}"
  mkdir -p "$CERT_DIR"
  cd "$CERT_DIR"

  openssl genrsa -out ca-key.pem 4096 2>/dev/null
  openssl req -new -x509 -days 3650 -key ca-key.pem -sha256 -out ca.pem \
    -subj "/CN=supersonic-buildkit-ca" 2>/dev/null

  # The server certificate carries the IP the client dials. A name would need
  # DNS that this VPC does not have for instances.
  openssl genrsa -out daemon-key.pem 4096 2>/dev/null
  openssl req -new -key daemon-key.pem -out daemon.csr -subj "/CN=buildkitd" 2>/dev/null
  printf 'subjectAltName=IP:%s,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' "$LISTEN_ADDR" > daemon-ext.cnf
  openssl x509 -req -days 3650 -sha256 -in daemon.csr -CA ca.pem -CAkey ca-key.pem \
    -CAcreateserial -out daemon.pem -extfile daemon-ext.cnf 2>/dev/null

  openssl genrsa -out client-key.pem 4096 2>/dev/null
  openssl req -new -key client-key.pem -out client.csr -subj "/CN=supersonic-deploy" 2>/dev/null
  printf 'extendedKeyUsage=clientAuth\n' > client-ext.cnf
  openssl x509 -req -days 3650 -sha256 -in client.csr -CA ca.pem -CAkey ca-key.pem \
    -CAcreateserial -out client.pem -extfile client-ext.cnf 2>/dev/null

  rm -f daemon.csr client.csr daemon-ext.cnf client-ext.cnf
  chmod 600 ./*-key.pem
  log "certificates written to $CERT_DIR"
fi

# ---------------------------------------------------------------------------
# 3. Configuration
# ---------------------------------------------------------------------------
mkdir -p /etc/buildkit
cat > /etc/buildkit/buildkitd.toml <<EOF
debug = false

[grpc]
  address = [ "tcp://0.0.0.0:1234" ]
  [grpc.tls]
    cert = "$CERT_DIR/daemon.pem"
    key = "$CERT_DIR/daemon-key.pem"
    ca = "$CERT_DIR/ca.pem"

[worker.oci]
  enabled = true
  # The whole point of this host. Keeping a large local cache is what makes the
  # second build of an app cheap; the number is generous because a 200 GB SSD is
  # cheaper than the deploys spent re-downloading layers.
  gc = true
  [[worker.oci.gcpolicy]]
    keepBytes = 107374182400
    keepDuration = 604800
    filters = [ "type==source.local", "type==exec.cachemount" ]
  [[worker.oci.gcpolicy]]
    all = true
    keepBytes = 128849018880

[worker.containerd]
  enabled = false
EOF

cat > /etc/systemd/system/buildkitd.service <<'EOF'
[Unit]
Description=BuildKit daemon (the build plane)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/buildkitd --config /etc/buildkit/buildkitd.toml
Restart=always
RestartSec=5
# A build is arbitrary code and it needs to create mounts and namespaces.
# Isolation here is the HOST's job — this machine runs nothing else.
Delegate=yes
LimitNOFILE=1048576
StandardOutput=append:/var/log/buildkitd.log
StandardError=append:/var/log/buildkitd.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable buildkitd >/dev/null 2>&1 || true
# Started here, not merely enabled. provision.sh's proxy block was `enable`d and
# never started for months, and the node that resulted could run no app with a
# database.
log "starting buildkitd"
systemctl restart buildkitd

sleep 3
if [ "$(systemctl is-active buildkitd)" != "active" ]; then
  log "FATAL: buildkitd did not stay up"
  tail -20 /var/log/buildkitd.log >&2 || true
  exit 1
fi

log "buildkitd listening on ${LISTEN_ADDR}:1234 (mTLS)"
log "provision complete"
