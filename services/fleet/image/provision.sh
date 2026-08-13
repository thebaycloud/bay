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

# THE CONTENT STORE GOES ON THE FAST DISK, and this is §4's second finding:
# containerd's root was left at its default, so images lived on the BOOT disk —
# which carries autoDelete=true, so replacing an instance loses every image — and
# layer unpacking, the most I/O-heavy part of a start, ran on the slower device.
# Meanwhile the local NVMe mounted specifically for rebuildable state held 127 MB
# against 369 GB free, while /var/lib/containerd held 20 GB.
#
# Images are exactly what /srv/state is for. The comment on that mount already
# says so — "losing /srv/state costs an image pull, not an app's data" — which is
# the definition of rebuildable state.
#
# ORDERING IS LOAD-BEARING: the mount must exist before containerd starts, or it
# will create its root on the boot disk under that path and the mount will then
# shadow files it is holding open. `supersonic-state.service` below owns the
# mount and containerd is ordered after it.
# IS THERE A FAST DISK? The content store only moves if there is somewhere
# better to put it. On a node without a local SSD, /srv/state is the boot disk —
# the same device the default root is already on — so pointing containerd at it
# would move 26 GB of cached images from one directory to another for no gain and
# throw the cache away in the process. Measured on fleet-lab-2, which has no SSD.
STATE_ON_SSD=""
for cand in /dev/disk/by-id/google-local-nvme-ssd-0 /dev/nvme0n1; do
  [ -e "$cand" ] && { STATE_ON_SSD="yes"; break; }
done
if [ -n "$STATE_ON_SSD" ]; then
  CTRD_ROOT="root = '/srv/state/containerd'"
  CTRD_ROOT_V2='root = "/srv/state/containerd"'
  log "content store will live on the local SSD"
else
  CTRD_ROOT=""
  CTRD_ROOT_V2=""
  log "no local SSD: leaving the content store where it is (boot disk)"
fi

log "configuring containerd for the runsc handler"
CTRD_MAJOR="$(containerd --version | awk '{print $3}' | sed 's/^v//' | cut -d. -f1)"
mkdir -p /etc/containerd

if [ "$CTRD_MAJOR" -ge 2 ]; then
  CRI_PLUGIN='io.containerd.cri.v1.runtime'
  cat > /etc/containerd/config.toml <<EOF
version = 3

${CTRD_ROOT}

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
  cat > /etc/containerd/config.toml <<EOF
version = 2

${CTRD_ROOT_V2}

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

# NOT RESTARTED HERE. The config written above puts containerd's content store
# under /srv/state, and that mount is set up further down — restarting now would
# create the store on the boot disk and then have the disk mounted over the top
# of files containerd is holding open. The restart moved to just after the mount;
# `enable` is safe at any point and stays.
systemctl enable containerd

# ---------------------------------------------------------------------------
# 5. Local SSD
#
# Attach-only-at-creation, never detachable, never snapshottable, and preserved
# across live migration but NOT across a stop. It is the fast path for app state
# and it is explicitly not the durable copy — see docs/VM-FLEET.md section D.
# ---------------------------------------------------------------------------

# Two kinds of state, and they do not belong on the same disk.
#
# /srv/state is bundles and rootfs overlays. Every byte of it can be rebuilt by
# pulling the image again, so it wants speed and does not want durability —
# local SSD exactly.
#
# /srv/apps is the app's own data directory and its logs. Nothing can rebuild
# that. It was sharing whatever /srv happened to be, which on this node was the
# BOOT disk, because the by-id name below did not match and the else branch ran
# silently. So app data survived a reboot by accident and would have started
# dying the moment the SSD mounted — a durability model that changes under you
# with no deploy and no message is worse than either of the two it switches
# between.
#
# The boot disk is not the answer either: it carries autoDelete=true, so
# replacing the instance takes every app's data with it. A separate persistent
# disk survives stop, reboot AND node replacement, and can be reattached to the
# machine that takes over.

mkdir -p /srv /srv/apps /srv/state

# Rebuildable state on the fast disk. Both spellings of the device, because the
# by-id name differs between images and the earlier one silently found nothing.
SSD_DEV=""
for cand in /dev/disk/by-id/google-local-nvme-ssd-0 /dev/nvme0n1; do
  if [ -e "$cand" ]; then SSD_DEV="$(readlink -f "$cand")"; break; fi
done
if [ -n "$SSD_DEV" ]; then
  if ! blkid "$SSD_DEV" >/dev/null 2>&1; then
    log "formatting local SSD $SSD_DEV"
    mkfs.ext4 -F -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "$SSD_DEV"
  fi
  if ! mountpoint -q /srv/state; then
    log "mounting local SSD at /srv/state"
    mount -o discard,defaults,nobarrier "$SSD_DEV" /srv/state
  fi
  mkdir -p /srv/state/containerd
  # No fstab entry on purpose: a node whose local SSD is gone (post-stop) must
  # still boot. Losing /srv/state costs an image pull, not an app's data.
  #
  # BUT SOMETHING HAS TO REMOUNT IT, and nothing did. This script is run by hand
  # — there is no startup-script metadata on any node — so after a reboot the
  # disk stayed unmounted and every bundle, overlay and (now) image silently went
  # to the boot disk instead. Found live: fleet-lab-3 had been serving from the
  # boot disk since it was stopped and started earlier the same day, and nothing
  # anywhere said so.
  #
  # The unit below does at boot exactly what this block does by hand, which is
  # also what makes the containerd root above safe: the mount is guaranteed to
  # exist before containerd starts, rather than happening to.
else
  log "no local SSD; /srv/state will live on the boot disk (slower, still correct)"
fi

# --------------------------------------------------------------------------
# The fast disk, at every boot rather than only when a human runs this script.
# --------------------------------------------------------------------------
#
# A local SSD is BLANK after a stop — the data does not survive, and the device
# comes back unformatted — so this cannot be an fstab line. It has to be able to
# format before it mounts, which is a program, not a table.
#
# `nofail` is the property the fstab comment wanted and could not express: a node
# whose SSD is missing degrades to the boot disk and still boots. Here that is
# the `|| exit 0` — every step is best-effort, and a failure leaves the node
# running on the slower disk exactly as it does today.
log "installing supersonic-state.service (mounts the fast disk at boot)"
cat > /usr/local/sbin/supersonic-mount-state <<'MOUNTEOF'
#!/usr/bin/env bash
# Mount the local NVMe at /srv/state, formatting it first if it is blank.
# Idempotent, and silent about a node that has no such disk.
set -uo pipefail
mkdir -p /srv/state
mountpoint -q /srv/state && { mkdir -p /srv/state/containerd; exit 0; }
dev=""
for cand in /dev/disk/by-id/google-local-nvme-ssd-0 /dev/nvme0n1; do
  [ -e "$cand" ] && { dev="$(readlink -f "$cand")"; break; }
done
[ -n "$dev" ] || { echo "no local SSD; /srv/state stays on the boot disk"; exit 0; }
blkid "$dev" >/dev/null 2>&1 || mkfs.ext4 -F -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "$dev"
mount -o discard,defaults,nobarrier "$dev" /srv/state || { echo "could not mount $dev; staying on the boot disk"; exit 0; }
mkdir -p /srv/state/containerd
echo "mounted $dev at /srv/state"
MOUNTEOF
chmod 0755 /usr/local/sbin/supersonic-mount-state

cat > /etc/systemd/system/supersonic-state.service <<'UNITEOF'
[Unit]
Description=Mount the node's fast rebuildable-state disk
DefaultDependencies=no
After=local-fs.target
Before=containerd.service
# containerd's content store lives under this mount. Ordered, not required:
# a node without the disk must still boot and serve from the slower one.
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/supersonic-mount-state
[Install]
WantedBy=multi-user.target
UNITEOF

mkdir -p /etc/systemd/system/containerd.service.d
cat > /etc/systemd/system/containerd.service.d/10-state-disk.conf <<'DROPEOF'
# containerd writes its images under /srv/state, so it must not start before the
# disk is there. Without this it would create the directory on the boot disk and
# then have the mount pulled over the top of files it is holding open.
[Unit]
After=supersonic-state.service
Wants=supersonic-state.service
DROPEOF

systemctl daemon-reload
systemctl enable supersonic-state.service >/dev/null 2>&1 || true
systemctl start supersonic-state.service || log "WARNING: could not mount the fast disk; the node stays on the boot disk"

# NOW containerd may start, with its store on a disk that exists. This is the
# restart moved down from the configuration block — see the note there.
#
# THE EXISTING CACHE MOVES WITH IT rather than being abandoned. A node that has
# been serving has tens of gigabytes of images already unpacked — 20 GB on
# fleet-lab-1 — and starting containerd on an empty root would make every app on
# it re-pull. Moved only when the destination is empty, so a re-run never
# disturbs a store that is already in the right place.
if [ -n "$STATE_ON_SSD" ] && [ -d /var/lib/containerd ] && [ ! -d /srv/state/containerd/io.containerd.content.v1.content ]; then
  log "moving the existing content store onto the state disk (this can take a minute)"
  systemctl stop containerd || true
  mkdir -p /srv/state/containerd
  # `cp -a` then remove, rather than `mv`: these are different filesystems, and a
  # move that fails halfway would leave neither root usable. The old one stays
  # until the copy is complete.
  if cp -a /var/lib/containerd/. /srv/state/containerd/; then
    rm -rf /var/lib/containerd.migrated && mv /var/lib/containerd /var/lib/containerd.migrated
    log "content store moved; the previous one is kept at /var/lib/containerd.migrated"
  else
    log "WARNING: could not copy the content store; leaving it where it is"
  fi
fi

log "restarting containerd onto the state disk"
systemctl restart containerd
# AND THE AGENT, because stopping containerd stopped it too. `supersonicd`
# declares `Requires=containerd.service`, and Requires propagates a STOP without
# propagating the start back — so the migration above took the agent down with
# containerd and left it down. The node then stopped heartbeating, its lease
# expired after two minutes, and the reconciler moved all nineteen of its apps to
# another node. That is the failover behaving exactly as designed, triggered by a
# maintenance script that did not put back what it took away.
systemctl start supersonicd || log "WARNING: the agent did not start — this node will lose its placements"

# App data on a disk that outlives the node. Named by device rather than found
# by guessing, so a wrong disk cannot be adopted as this one.
APPDATA_LINK=/dev/disk/by-id/google-appdata
if [ -e "$APPDATA_LINK" ]; then
  APPDATA_DEV="$(readlink -f "$APPDATA_LINK")"
  if ! blkid "$APPDATA_DEV" >/dev/null 2>&1; then
    log "formatting app-data disk $APPDATA_DEV"
    mkfs.ext4 -F -m 0 "$APPDATA_DEV"
  fi
  if ! mountpoint -q /srv/apps; then
    log "mounting app-data disk at /srv/apps"
    mount -o discard,defaults "$APPDATA_DEV" /srv/apps
  fi
  # fstab HERE, unlike the SSD: this mount can always exist, and a node that
  # boots without it would hand every app an empty data directory and call it
  # normal. `nofail` so a missing disk is a degraded boot rather than no boot.
  if ! grep -q " /srv/apps " /etc/fstab; then
    echo "$(blkid -o export "$APPDATA_DEV" | grep ^UUID=) /srv/apps ext4 discard,defaults,nofail 0 2" >> /etc/fstab
  fi
else
  log "WARNING: no app-data disk attached; /srv/apps is on the boot disk and dies with the instance"
  log "WARNING: attach one with device-name=appdata — see docs/VM-FLEET.md"
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
# 7a. Log shipping
#
# App stdout and stderr land in /srv/apps/<slug>/<process>.log, written by the
# agent. Without this they stay there: `supersonic logs` filters Cloud Logging
# for cloud_run_revision, so an app on a node produces nothing at all — not an
# error, nothing. Three separate incidents on 2026-08-04 were diagnosable only
# over ssh, and one of them had been looping unnoticed for hours.
#
# The agent's own log ships too, deliberately. Every one of those incidents was
# read from /var/log/supersonicd.log rather than from an app's output: it is the
# file that says WHY an app is not running.
#
# No IAM step here — the node's service account already holds
# roles/logging.logWriter. If entries stop arriving, check that first anyway: it
# is the one dependency this section does not create for itself.
# ---------------------------------------------------------------------------

# A NOTE ON `| grep -q` IN THIS FILE, because it cost a node.
#
# This script runs under `set -euo pipefail`. `grep -q` exits the moment it
# matches, which sends SIGPIPE to whatever is still writing into the pipe; that
# producer then exits 141, and `pipefail` makes the whole pipeline 141. So
#
#     if systemctl list-unit-files | grep -q '^cloud-sql-proxy'; then
#
# is FALSE precisely when the unit EXISTS — the answer is inverted by success.
# Verified on fleet-lab-3: the same test is true with `pipefail` off and false
# with it on.
#
# It cost exactly what the comment further down predicted: a node that could not
# start any app with a database, reporting `this node's database path
# (10.200.0.1:5432) is not answering`. It also made the ops-agent check below
# reinstall a 119 MB package on every run, since there the inverted answer is
# harmless and merely wasteful.
#
# Existence is therefore asked of systemd directly — `systemctl cat` — with no
# pipe to break.

if ! systemctl cat google-cloud-ops-agent.service >/dev/null 2>&1; then
  log "installing google-cloud-ops-agent"
  curl -fsSL -o /tmp/add-google-cloud-ops-agent-repo.sh \
    https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
  bash /tmp/add-google-cloud-ops-agent-repo.sh --also-install
  rm -f /tmp/add-google-cloud-ops-agent-repo.sh
fi

mkdir -p /etc/google-cloud-ops-agent
cat > /etc/google-cloud-ops-agent/config.yaml <<'EOF'
logging:
  receivers:
    supersonic_apps:
      type: files
      # Without this an entry carries NOTHING that says which app it came from:
      # resource.type is gce_instance, resource.labels are instance/zone/project,
      # and logName is the receiver name — identical for all twenty apps. Measured
      # on 2026-08-04 before this line was added. With it, each entry gets
      # labels."agent.googleapis.com/log_file_path" = /srv/apps/<slug>/<proc>.log,
      # which is the only discriminator that exists.
      record_log_file_path: true
      include_paths:
        - /srv/apps/*/*.log
    supersonic_agent:
      type: files
      # Without this an entry carries NOTHING that says which app it came from:
      # resource.type is gce_instance, resource.labels are instance/zone/project,
      # and logName is the receiver name — identical for all twenty apps. Measured
      # on 2026-08-04 before this line was added. With it, each entry gets
      # labels."agent.googleapis.com/log_file_path" = /srv/apps/<slug>/<proc>.log,
      # which is the only discriminator that exists.
      record_log_file_path: true
      include_paths:
        - /var/log/supersonicd.log
  service:
    pipelines:
      supersonic:
        receivers: [supersonic_apps, supersonic_agent]
EOF

systemctl enable google-cloud-ops-agent >/dev/null 2>&1 || true
systemctl restart google-cloud-ops-agent || true

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
# BOTH files, and both optional (`-`), because this heredoc REPLACES the unit
# every time provision.sh runs.
#
# agent.env holds FLEET_ENDPOINT and FLEET_TOKEN. It was added to the live unit
# by hand and was never in this file, so re-provisioning fleet-lab-1 without
# this line would have restarted the agent with no control plane to ask. That
# does not fail loudly: `Source.Fetch` treats an empty Endpoint as "this node
# has no control plane" and reads /srv/state/desired.json instead — deliberately
# NOT the cache, which is the fallback for a control plane that is merely
# unreachable. On 2026-08-04 that local file listed 3 apps while the control
# plane listed 20, and reconcileOnce stops what is no longer desired before it
# starts anything. Seventeen apps would have gone down, quietly, as a
# side effect of running this script.
#
# fleet.env is where the rollout writes FLEET_EDGE_SECRET.
EnvironmentFile=-/etc/supersonic/agent.env
EnvironmentFile=-/etc/supersonic/fleet.env
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
# 7c. Collecting the agent
#
# The agent was the last component with no deploy path: it was updated by
# copying .go files to a node and building there, so "merged" and "running" were
# different questions. It cost the fleet-pull and fleet-boot stages, which
# shipped, wrote zero rows, and looked like broken instrumentation.
#
# The updater PULLS, like everything else here. A node unreachable during a
# release collects it on the next tick rather than missing it, and CI needs no
# route to any machine.
#
# Two minutes, with a randomised delay: without the jitter every node in a site
# would fetch the same object at the same second, which is a self-inflicted
# thundering herd for no gain — nothing here is urgent to the second.
# ---------------------------------------------------------------------------

log "installing the agent updater"
install -m 0755 "$(dirname "$0")/update-agent.sh" /usr/local/bin/supersonic-update-agent 2>/dev/null \
  || log "update-agent.sh not beside provision.sh; copy it to /usr/local/bin/supersonic-update-agent by hand"

cat > /etc/systemd/system/supersonic-update-agent.service <<'EOF'
[Unit]
Description=Collect the current Supersonic fleet agent
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
ExecStart=/usr/local/bin/supersonic-update-agent
StandardOutput=append:/var/log/supersonicd.log
StandardError=append:/var/log/supersonicd.log
EOF

cat > /etc/systemd/system/supersonic-update-agent.timer <<'EOF'
[Unit]
Description=Collect the current Supersonic fleet agent, periodically

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
RandomizedDelaySec=60
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now supersonic-update-agent.timer >/dev/null 2>&1 || true

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

# The SQL proxy needs /etc/supersonic/fleet.env, which is written per node and
# may not exist the first time this runs. Enabling it here means a node that
# gains the file later starts serving databases on the next boot without anyone
# remembering to — and a node provisioned before the file existed said so, at
# the only moment it mattered:
#
#   FLEET_NODE_FAULT: fleet-lab-2 reports this app cannot start on it —
#   this node's database path (10.200.0.1:5432) is not answering
#
# which is the right answer and still a node nobody could deploy a database app
# to. Enabled, then started only if its config is present.
if systemctl cat cloud-sql-proxy.service >/dev/null 2>&1; then
  systemctl enable cloud-sql-proxy >/dev/null 2>&1 || true
  if [ -s /etc/supersonic/fleet.env ] && grep -q '^PG_INSTANCE=..*' /etc/supersonic/fleet.env; then
    log "starting cloud-sql-proxy"
    systemctl restart cloud-sql-proxy || log "WARNING: cloud-sql-proxy would not start"
  else
    log "WARNING: no PG_INSTANCE in /etc/supersonic/fleet.env — this node cannot serve a database app"
  fi
fi

log "provision complete"
