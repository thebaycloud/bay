#!/usr/bin/env bash
# Collect the current fleet agent, if it is not the one already installed.
#
# THIS SCRIPT ITSELF HAS NO DELIVERY PATH, which is worth knowing before you edit
# it. `provision.sh` installs it, and provision.sh is run by hand — so a change
# here reaches a node only when somebody puts it there. The agent BINARY updates
# itself through this file every two minutes; the file does not.
#
# It bit twice on 13 Aug. A message fixed here still read the old way on every
# node until the script was copied out by hand, and the same shape had already
# cost a rebuilt node its `agent.env` that morning. Deliberately not made
# self-updating: an updater that replaces itself cannot be trusted to recover
# from replacing itself badly.
#
# PULL, NOT PUSH, and for the same reason the agent pulls its desired state:
# nothing reaches into a node. A node that was unreachable during a release
# collects it on its next tick instead of missing it, and CI needs no route to
# any machine.
#
# WHY THIS DOES NOT KILL ANYTHING
#
# The systemd unit carries KillMode=process, so restarting the agent leaves its
# sandboxes running, and Runtime.Adoptable() takes them back on the next start —
# on an exact match of image and declared command, so a sandbox that should have
# changed is still replaced. That property is why an agent update can be routine.
#
# services/fleet/bench/restart-agent.sh does the opposite ON PURPOSE: it kills
# every runsc container, unmounts the bundles and deletes routes.json. It is the
# recovery tool for a node in a bad state. It must never be the deploy path, and
# this script exists so it no longer has to be.
set -uo pipefail

BASE="${AGENT_BASE:-gs://supersonic-static-assets/agent}"
FETCH="${AGENT_FETCH:-gcloud storage cp}"
DIR="${AGENT_DIR:-/opt/agent}"
RESTART="${AGENT_RESTART:-systemctl restart supersonicd}"
HEALTH="${AGENT_HEALTH_URL-http://127.0.0.1:9900/status}"

log() { echo "update-agent: $*"; }

mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. What should be running.
if ! $FETCH "$BASE/current" "$TMP/current" >/dev/null 2>&1; then
  log "could not read the pointer at $BASE/current — leaving this node alone"
  exit 1
fi
WANT="$(head -1 "$TMP/current" | tr -d '[:space:]')"
COMMIT="$(sed -n 2p "$TMP/current" | tr -d '[:space:]')"
# No pipe: under `pipefail`, `grep -q` closing the pipe early makes the producer
# exit 141 and inverts the answer. provision.sh lost a node to that exact shape.
if [[ ! "$WANT" =~ ^[0-9a-f]{64}$ ]]; then
  log "the pointer does not name a sha256 ($WANT) — refusing"
  exit 1
fi

# 2. What is running. A missing record counts as nothing installed, which is
#    correct on a fresh node and harmless on one that lost the file: the digest
#    check below makes a redundant download idempotent rather than wrong.
#
#    READ BEFORE THE ROLLOUT CHECK, because that check reports what this node is
#    staying on. It used to be read afterwards, so a node that declined an update
#    always said "staying on none" — including three that were running perfectly
#    well at the time.
HAVE="$(cat "$DIR/installed.sha256" 2>/dev/null | tr -d '[:space:]' || true)"

# 1b. Is this node in the rollout yet?
#
# The pointer's third line is the percentage of the fleet that should be running
# this build. Absent or unparseable means 100 — everyone — which is what every
# publish meant before this existed and is the safe reading: a percentage nobody
# can parse must not silently freeze the fleet on an old agent while looking
# like nothing is wrong.
#
# THE NODE DECIDES FOR ITSELF, from a hash of its own name and the digest it is
# being offered. No coordinator, no list to keep in step with reality — the same
# node reaches the same answer on every run, so it does not flip in and out of a
# rollout between two ticks of the timer.
#
# A PERCENTAGE IS AN EXPECTATION, NOT A COUNT. 34% of three nodes is about one,
# and the hash is free to put none or two of them under the threshold — it put
# TWO on the second live rollout. That is the bargain a hash-based rollout makes:
# no coordination, in exchange for a number that is only exact in the aggregate.
# If an exact count ever matters, this is the wrong mechanism to get it from.
#
# Hashed with the DIGEST and not the name alone, so the canary moves between
# builds. A permanently-first node is the node a bad build always breaks, and if
# it happens to be the one holding apps that cannot move — see the volume pin —
# that is the worst case every single time.
#
# This is what replaces FLEET_APPS, deleted with the Cloud Run lane. Twice in one
# day its absence cost something: a schema-dependent write broke every deploy at
# once, and an agent rollout reached all three nodes inside two minutes and
# contaminated the measurement being taken at the time.
PERCENT="$(sed -n 3p "$TMP/current" | tr -d '[:space:]')"
if [[ ! "$PERCENT" =~ ^[0-9]+$ ]] || [ "$PERCENT" -gt 100 ]; then PERCENT=100; fi
if [ "$PERCENT" -lt 100 ]; then
  # Four hex digits of sha256 over "<node>:<digest>" — the first 16 bits are as
  # uniform as the whole hash and fit in a shell integer without arithmetic games.
  BUCKET=$(( 0x$(printf '%s' "$(hostname):$WANT" | sha256sum | cut -c1-4) % 100 ))
  if [ "$BUCKET" -ge "$PERCENT" ]; then
    log "not in this rollout yet (bucket $BUCKET, rolling to $PERCENT%) — staying on ${HAVE:-none}"
    exit 0
  fi
  log "in this rollout (bucket $BUCKET < $PERCENT%)"
fi

if [ "$WANT" = "$HAVE" ] && [ -x "$DIR/supersonicd" ]; then
  log "already current ($WANT, commit ${COMMIT:-unknown})"
  exit 0
fi

log "want $WANT (commit ${COMMIT:-unknown}), have ${HAVE:-none}"

# 3. Fetch it.
if ! $FETCH "$BASE/$WANT/supersonicd" "$TMP/supersonicd" >/dev/null 2>&1; then
  log "could not fetch the binary — leaving this node alone"
  exit 1
fi

# 4. Prove it is what the pointer named. A truncated download is the ordinary
#    failure here, not an exotic one, and it produces a file that exists.
GOT="$(sha256sum "$TMP/supersonicd" | cut -d' ' -f1)"
if [ "$GOT" != "$WANT" ]; then
  log "checksum mismatch: got $GOT, wanted $WANT — refusing"
  exit 1
fi

# 5. Prove it runs at all, before it replaces something that does. This is the
#    only check between a bad build and a node with no agent, and it is cheap:
#    -version touches no state, no bridge and no containerd.
chmod +x "$TMP/supersonicd"
VERSION_SAYS="$("$TMP/supersonicd" -version 2>/dev/null || true)"
if [[ "$VERSION_SAYS" != supersonicd\ * ]]; then
  log "the downloaded binary does not answer -version — refusing"
  exit 1
fi

# 6. Swap, keeping the one that was working. Same filesystem, so the move is
#    atomic and there is no window where /opt/agent/supersonicd is absent.
[ -f "$DIR/supersonicd" ] && cp -f "$DIR/supersonicd" "$DIR/supersonicd.previous"
mv -f "$TMP/supersonicd" "$DIR/supersonicd.new"
mv -f "$DIR/supersonicd.new" "$DIR/supersonicd"
echo "$WANT" > "$DIR/installed.sha256"
log "installed $("$DIR/supersonicd" -version)"

# 7. Restart, then check it came back. systemd's Restart=always will keep
#    relaunching a broken agent forever, which looks like a running service and
#    is not one — so health is asked of the agent, not of systemd.
$RESTART || { log "restart failed"; exit 1; }

if [ -n "$HEALTH" ]; then
  ok=0
  for _ in $(seq 1 20); do
    sleep 1
    if curl -fsS --max-time 2 "$HEALTH" >/dev/null 2>&1; then ok=1; break; fi
  done
  if [ "$ok" != "1" ]; then
    log "the new agent did not answer $HEALTH within 20s — rolling back"
    if [ -f "$DIR/supersonicd.previous" ]; then
      mv -f "$DIR/supersonicd.previous" "$DIR/supersonicd"
      echo "${HAVE:-}" > "$DIR/installed.sha256"
      $RESTART || true
      log "rolled back to the previous binary"
    else
      log "no previous binary to roll back to — this node needs a human"
    fi
    exit 1
  fi
fi

log "up on $WANT (commit ${COMMIT:-unknown})"
