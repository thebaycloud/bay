#!/usr/bin/env bash
#
# Everything that goes into a fleet node image.
#
# Runs on Ubuntu 24.04 LTS. Idempotent: safe to re-run on a live node, which is
# how it gets iterated on before it is baked.
#
# Ubuntu and not Container-Optimized OS, deliberately. COS has no package
# manager, a locked kernel, a read-only root, and an /etc that is stateless
# tmpfs — a containerd runtime handler would have to be reinstalled by cloud-init
# on every boot, with no support behind it. See docs/VM-FLEET.md section A.

set -euo pipefail

log() { echo "[provision] $*" >&2; }

ARCH="$(uname -m)"
GVISOR_URL="https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}"
CLOUD_SQL_PROXY_VERSION="${CLOUD_SQL_PROXY_VERSION:-v2.14.1}"

# ---------------------------------------------------------------------------
# 1. Base packages
# ---------------------------------------------------------------------------

log "waiting for any boot-time apt/dpkg lock to clear"
for _ in $(seq 1 60); do
  if ! fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then break; fi
  sleep 5
done

export DEBIAN_FRONTEND=noninteractive
log "installing base packages"
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg wget bzip2 jq nftables \
  sqlite3 fio python3 uidmap

# ---------------------------------------------------------------------------
# 2. containerd — PINNED to the 1.7 line
#
# From Docker's repository rather than Ubuntu's, because gVisor documents a
# minimum containerd version and the shim protocol is the interface we depend on.
#
# PINNED, and the pin is load-bearing. containerd 2.2.6 installs and runs runc
# fine, and every runsc container started through it hangs: the shim connects
# (`connecting to shim … protocol=ttrpc version=2` — while runc's shim negotiates
# version=3 on the same daemon), the task never starts, no runsc log is ever
# written, and 40 seconds later containerd reports `failed to delete task:
# context deadline exceeded`. `runsc do` works standalone on the same host, and
# the same image runs under runc, so it is neither gVisor nor the image.
#
# 1.7.x is what GKE Sandbox runs and what gVisor's own CI targets. Moving off
# this pin means re-running services/fleet/bench/debug-runsc.sh and getting three
# passes, not just reading a changelog.
# ---------------------------------------------------------------------------

CONTAINERD_VERSION="${CONTAINERD_VERSION:-1.7.29-1~ubuntu.24.04~noble}"

install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq

if [ "$(dpkg-query -W -f='${Version}' containerd.io 2>/dev/null || true)" != "$CONTAINERD_VERSION" ]; then
  log "installing containerd.io ${CONTAINERD_VERSION}"
  apt-get install -y -qq --allow-downgrades "containerd.io=${CONTAINERD_VERSION}"
fi
# Hold it, so an unattended-upgrade cannot walk the node onto a version that
# silently stops running sandboxes.
apt-mark hold containerd.io >/dev/null
containerd --version

# ---------------------------------------------------------------------------
# 3. gVisor
#
# Post-2026-07 the release is a multi-file tarball: runsc, the containerd shim,
# and a gvisor-bin/ directory that runsc looks for NEXT TO ITS OWN BINARY. The
# auto-download fallback that papers over a partial install is removed at the end
# of September 2026, so the whole tarball is unpacked into one directory and kept
# there. Any automation that copies only `runsc` breaks.
# ---------------------------------------------------------------------------

if ! command -v runsc >/dev/null 2>&1; then
  log "installing gVisor"
  tmp="$(mktemp -d)"
  pushd "$tmp" >/dev/null
  wget -q "${GVISOR_URL}/gvisor.tar.bz2" "${GVISOR_URL}/gvisor.tar.bz2.sha512"
  sha512sum -c gvisor.tar.bz2.sha512
  tar -xjf gvisor.tar.bz2 -C /usr/local/bin
  popd >/dev/null
  rm -rf "$tmp"
fi
runsc --version
test -d /usr/local/bin/gvisor-bin \
  || { log "FATAL: gvisor-bin/ missing next to runsc"; exit 1; }

# ---------------------------------------------------------------------------
# 4. containerd configuration
#
# The config schema version moved with containerd 2.x. Detect rather than guess:
# writing a version=2 config on containerd 2.x silently loses the runtime
# handler, and the failure surfaces much later as "runsc not found".
# ---------------------------------------------------------------------------

log "configuring containerd for the runsc handler"
CTRD_MAJOR="$(containerd --version | awk '{print $3}' | sed 's/^v//' | cut -d. -f1)"
mkdir -p /etc/containerd

if [ "$CTRD_MAJOR" -ge 2 ]; then
  CRI_PLUGIN='io.containerd.cri.v1.runtime'
  cat > /etc/containerd/config.toml <<EOF
version = 3

[plugins.'${CRI_PLUGIN}']
  [plugins.'${CRI_PLUGIN}'.containerd]
    default_runtime_name = 'runc'
    [plugins.'${CRI_PLUGIN}'.containerd.runtimes.runc]
      runtime_type = 'io.containerd.runc.v2'
      [plugins.'${CRI_PLUGIN}'.containerd.runtimes.runc.options]
        SystemdCgroup = true
    [plugins.'${CRI_PLUGIN}'.containerd.runtimes.runsc]
      runtime_type = 'io.containerd.runsc.v1'
EOF
else
  cat > /etc/containerd/config.toml <<'EOF'
version = 2

[plugins."io.containerd.grpc.v1.cri".containerd]
  default_runtime_name = "runc"
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
    runtime_type = "io.containerd.runc.v2"
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
      SystemdCgroup = true
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
    runtime_type = "io.containerd.runsc.v1"
EOF
fi

# runsc's own configuration. Every value here is a decision recorded in
# docs/VM-FLEET.md:
#   platform=systrap  — the default since 2023; ptrace is the slow legacy path.
#   directfs          — default since 2023-06; the sentry makes FD-relative host
#                       syscalls instead of RPCing the gofer per operation.
#   network=sandbox   — netstack, NOT --network=host. This is what makes the
#                       metadata block in step 6 an actual boundary: all
#                       non-loopback traffic leaves through one host interface.
mkdir -p /etc/containerd/runsc
cat > /usr/local/bin/runsc-config.json <<'EOF'
{
  "comment": "reference only; the shim reads /etc/containerd/runsc.toml"
}
EOF
cat > /etc/containerd/runsc.toml <<'EOF'
log_path = "/var/log/runsc/%ID%.log"
log_level = "warning"

[runsc_config]
  platform = "systrap"
  directfs = "true"
  network = "sandbox"
  watchdog-action = "log"
EOF
mkdir -p /var/log/runsc

systemctl restart containerd
systemctl enable containerd

# ---------------------------------------------------------------------------
# 5. Local SSD
#
# Attach-only-at-creation, never detachable, never snapshottable, and preserved
# across live migration but NOT across a stop. It is the fast path for app state
# and it is explicitly not the durable copy — see docs/VM-FLEET.md section D.
# ---------------------------------------------------------------------------

SSD_LINK=/dev/disk/by-id/google-local-nvme-ssd-0
if [ -e "$SSD_LINK" ]; then
  SSD_DEV="$(readlink -f "$SSD_LINK")"
  if ! blkid "$SSD_DEV" >/dev/null 2>&1; then
    log "formatting local SSD $SSD_DEV"
    mkfs.ext4 -F -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "$SSD_DEV"
  fi
  mkdir -p /srv
  if ! mountpoint -q /srv; then
    log "mounting local SSD at /srv"
    mount -o discard,defaults,nobarrier "$SSD_DEV" /srv
  fi
  # No fstab entry on purpose: a node whose local SSD is gone (post-stop) must
  # still boot. The agent's job is to notice /srv is empty and re-place, not to
  # sit in emergency mode because a mount that cannot exist did not happen.
  mkdir -p /srv/apps /srv/state
else
  log "WARNING: no local SSD attached; /srv will live on the boot disk"
  mkdir -p /srv/apps /srv/state
fi

# ---------------------------------------------------------------------------
# 6. Block the metadata server from tenant traffic
#
# VPC firewall rules DO NOT APPLY to 169.254.169.254 — Google always allows that
# traffic, and there is no per-instance switch. Google's own guidance is "You
# must sandbox any process that shouldn't be able to access the metadata server."
#
# This is the single control that stops a tenant reading the node's service
# account token and owning the project. gVisor's netstack is what makes it
# enforceable: the sandbox has no host sockets of its own, so everything it emits
# crosses a host interface we own, and this rule sits on that path.
#
# BLOCK BY PORT, NOT BY ADDRESS. On GCE the metadata server is also the DNS
# resolver — 169.254.169.254:53 is what systemd-resolved forwards to. A blanket
# drop on that address takes DNS out on the host and in every sandbox, which is
# exactly what the first version of this file did: apt worked (it had run before
# the rule landed), and every subsequent name lookup failed with "Temporary
# failure in name resolution".
#
# The credentials live behind the HTTP API on port 80. So: 53 is open to
# everyone because everyone needs to resolve names, 80 is open only to the host's
# own processes by UID, and everything else on that address is dropped.
# ---------------------------------------------------------------------------

log "installing the metadata-server block"
cat > /etc/nftables.conf <<'EOF'
#!/usr/sbin/nft -f
flush ruleset

define METADATA = 169.254.169.254

table inet supersonic {
  chain output {
    type filter hook output priority 0; policy accept;

    # DNS. The metadata server is GCE's resolver; without this the host cannot
    # resolve anything, including the registry it pulls images from.
    ip daddr $METADATA udp dport 53 accept
    ip daddr $METADATA tcp dport 53 accept

    # The credentials API. Host-owned processes only: root, and the `supersonic`
    # user the agent and cloud-sql-proxy run as.
    ip daddr $METADATA meta skuid { 0, 987 } accept
    ip daddr $METADATA counter drop
  }

  chain forward {
    type filter hook forward priority 0; policy accept;

    # A sandbox's packets are forwarded rather than output, so the same policy
    # has to exist on this hook. Nothing here is UID-scoped: a forwarded packet
    # has no meaningful skuid, and anything arriving on this hook came from a
    # tenant.
    ip daddr $METADATA udp dport 53 accept
    ip daddr $METADATA tcp dport 53 accept
    ip daddr $METADATA counter drop

    # The rest of link-local. Nothing a tenant needs lives here.
    ip daddr 169.254.0.0/16 counter drop
  }

  chain input {
    type filter hook input priority 0; policy accept;

    # The Cloud SQL proxy binds 0.0.0.0 because ssbr0 does not exist at boot —
    # the agent creates it. So the bind is wide and the door is narrow: only a
    # sandbox, or the host itself, may reach 5432.
    #
    # INPUT, and the hook is the whole rule. The proxy's socket is on this host,
    # so a sandbox's packet to 10.200.0.1:5432 is addressed to a LOCAL address
    # and the kernel delivers it here. `forward` sees only packets being routed
    # onward, which is exactly why the metadata block belongs there —
    # 169.254.169.254 is never a local address. The same line in `forward`
    # matches nothing at all, and a rule that matches nothing reads precisely
    # like a rule that works.
    #
    # `lo` stays open so someone debugging on the node can still reach Postgres;
    # a sandbox has its own network namespace and cannot use the host's loopback
    # to get here.
    tcp dport 5432 iifname != { "lo", "ssbr0" } drop
  }
}
EOF
systemctl enable nftables
systemctl restart nftables

# ---------------------------------------------------------------------------
# 7. cloud-sql-proxy — one per HOST, not one sidecar per app
#
# On Cloud Run this is attached at four separate emission points, three of which
# need a startup probe and one of which cannot have one, so ordering is done by a
# shell wait loop prefixed to the command. On a node it is a systemd unit that is
# up before any app is.
# ---------------------------------------------------------------------------

if [ ! -x /usr/local/bin/cloud-sql-proxy ]; then
  log "installing cloud-sql-proxy ${CLOUD_SQL_PROXY_VERSION}"
  curl -fsSL -o /usr/local/bin/cloud-sql-proxy \
    "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/${CLOUD_SQL_PROXY_VERSION}/cloud-sql-proxy.linux.amd64"
  chmod +x /usr/local/bin/cloud-sql-proxy
fi

id -u supersonic >/dev/null 2>&1 || useradd --system --uid 987 --no-create-home --shell /usr/sbin/nologin supersonic

cat > /etc/systemd/system/cloud-sql-proxy.service <<'EOF'
[Unit]
Description=Cloud SQL Auth Proxy (one per host)
After=network-online.target
Wants=network-online.target

[Service]
User=supersonic
EnvironmentFile=/etc/supersonic/fleet.env
ExecStart=/usr/local/bin/cloud-sql-proxy --address 0.0.0.0 --port 5432 \
  --health-check --http-address 127.0.0.1 --http-port 9801 ${PG_INSTANCE}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /etc/supersonic
if [ ! -f /etc/supersonic/fleet.env ]; then
  cat > /etc/supersonic/fleet.env <<'EOF'
PG_INSTANCE=supersonic-deploy-prod:us-central1:supersonic-shared-pg
EOF
fi

# ---------------------------------------------------------------------------
# 7b. The agent
#
# A node that reboots must come back serving without anyone logging in. Local
# SSD survives live migration but not a stop, so on a cold boot /srv may be empty
# and every app has to be re-placed from desired state — which is exactly what
# the reconcile loop does on its first pass, so the unit needs no special
# handling for it.
# ---------------------------------------------------------------------------

cat > /etc/systemd/system/supersonicd.service <<'EOF'
[Unit]
Description=Supersonic fleet agent
After=containerd.service network-online.target
Wants=network-online.target
Requires=containerd.service

[Service]
Type=simple
# Root, because it creates network namespaces, mounts snapshots and drives
# runsc. The tenant boundary is the sandbox, not this process.
User=root
ExecStart=/opt/agent/supersonicd -interval 10s
Restart=always
RestartSec=5
# The agent supervises sandboxes; killing its children on restart would take
# every app on the node down with it for no reason.
KillMode=process
LimitNOFILE=1048576
StandardOutput=append:/var/log/supersonicd.log
StandardError=append:/var/log/supersonicd.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cloud-sql-proxy >/dev/null 2>&1 || true
systemctl enable supersonicd >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 8. Kernel and cgroup posture
# ---------------------------------------------------------------------------

log "applying kernel settings"
cat > /etc/sysctl.d/99-supersonic-fleet.conf <<'EOF'
# Many resident sandboxes, each with its own netstack and file descriptors.
fs.file-max = 2097152
fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches = 524288
net.core.somaxconn = 4096
net.ipv4.ip_local_port_range = 15000 65000
# gVisor's app-huge-pages flag requires this, and it is off by default.
vm.max_map_count = 262144
EOF
sysctl -p /etc/sysctl.d/99-supersonic-fleet.conf >/dev/null

# gVisor uses hugepages for application memory when the host allows it.
echo advise > /sys/kernel/mm/transparent_hugepage/shmem_enabled 2>/dev/null || true

# cgroup v2 is the default on Ubuntu 24.04. Assert it rather than assume — every
# limit the agent sets is a cgroup v2 write.
if [ ! -f /sys/fs/cgroup/cgroup.controllers ]; then
  log "FATAL: cgroup v2 unified hierarchy not mounted"
  exit 1
fi
log "cgroup v2 controllers: $(cat /sys/fs/cgroup/cgroup.controllers)"

log "provision complete"
