#!/usr/bin/env bash
# Runs update-agent.sh against a local directory standing in for the bucket.
#
# `AGENT_FETCH` defaults to `gcloud storage cp` and the test sets it to `cp`,
# which takes the same two arguments in the same order — so the code under test
# is the code that runs in production, with one word swapped.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1"; echo "  want: $3"; echo "  got:  $2"; fi; }

setup() {
  ROOT="$(mktemp -d)"
  mkdir -p "$ROOT/bucket" "$ROOT/opt"
  # A stand-in agent: it answers -version and nothing else.
  printf '#!/bin/sh\n[ "$1" = "-version" ] && echo "supersonicd %s"\n' "$1" > "$ROOT/new"
  chmod +x "$ROOT/new"
  D="$(sha256sum "$ROOT/new" | cut -d" " -f1)"
  mkdir -p "$ROOT/bucket/$D"
  cp "$ROOT/new" "$ROOT/bucket/$D/supersonicd"
  printf '%s\ncommitsha\n' "$D" > "$ROOT/bucket/current"
  export AGENT_BASE="$ROOT/bucket" AGENT_FETCH="cp" AGENT_DIR="$ROOT/opt" \
         AGENT_RESTART="true" AGENT_HEALTH_URL=""
}

# 1. A node with no agent installs one.
setup v1
out="$(bash "$HERE/update-agent.sh" 2>&1)"
check "installs when absent" "$(cat "$ROOT/opt/supersonicd" | head -1)" "#!/bin/sh"
check "records what it installed" "$(cat "$ROOT/opt/installed.sha256")" "$D"

# 2. Running it again changes nothing and says so.
out="$(bash "$HERE/update-agent.sh" 2>&1)"
check "second run is a no-op" "$(echo "$out" | grep -c 'already current')" "1"

# 3. A new publish is picked up, and the old binary is kept.
OLD_D="$D"
setup v2
printf '#!/bin/sh\n[ "$1" = "-version" ] && echo "supersonicd v1"\n' > "$ROOT/opt/supersonicd"
chmod +x "$ROOT/opt/supersonicd"
echo "$OLD_D" > "$ROOT/opt/installed.sha256"
out="$(bash "$HERE/update-agent.sh" 2>&1)"
check "upgrades to the new digest" "$(cat "$ROOT/opt/installed.sha256")" "$D"
check "keeps the previous binary" "$([ -x "$ROOT/opt/supersonicd.previous" ] && echo yes)" "yes"

# 4. A corrupt download is refused and the running agent is untouched.
setup v3
printf '#!/bin/sh\necho old\n' > "$ROOT/opt/supersonicd"; chmod +x "$ROOT/opt/supersonicd"
echo "notthedigest" > "$ROOT/opt/installed.sha256"
echo "corrupted" > "$ROOT/bucket/$D/supersonicd"
out="$(bash "$HERE/update-agent.sh" 2>&1)"; rc=$?
check "refuses a checksum mismatch" "$rc" "1"
check "leaves the running binary alone" "$(sh "$ROOT/opt/supersonicd")" "old"

# 5. A binary that does not run is refused before it replaces anything.
setup v4
printf '#!/bin/sh\necho old\n' > "$ROOT/opt/supersonicd"; chmod +x "$ROOT/opt/supersonicd"
echo "notthedigest" > "$ROOT/opt/installed.sha256"
printf 'not an executable' > "$ROOT/bucket/current.tmp"
D2="$(sha256sum "$ROOT/bucket/current.tmp" | cut -d" " -f1)"
mkdir -p "$ROOT/bucket/$D2"; cp "$ROOT/bucket/current.tmp" "$ROOT/bucket/$D2/supersonicd"
printf '%s\ncommitsha\n' "$D2" > "$ROOT/bucket/current"
out="$(bash "$HERE/update-agent.sh" 2>&1)"; rc=$?
check "refuses a binary that will not run" "$rc" "1"
check "still leaves the running binary alone" "$(sh "$ROOT/opt/supersonicd")" "old"

[ "$FAIL" -eq 0 ]

# --------------------------------------------------------------------------
# A staged rollout. The pointer's third line is the percentage of nodes that
# should be running this build; a node decides for itself whether it is one of
# them, from a hash of its own name and the digest it is being offered.
#
# The gap this closes: FLEET_APPS was deleted with the Cloud Run lane and nothing
# replaced it, so every change reached every node at once. Twice in one day that
# cost something — a schema-dependent write broke all deploys, and an agent
# rollout to all three nodes contaminated the measurement being taken at the time.
# --------------------------------------------------------------------------

# 8. A node outside the percentage does not take the new build.
setup v3
OLD_D="$(sha256sum "$ROOT/new" | cut -d" " -f1)"   # placeholder; overwritten below
printf '#!/bin/sh\n[ "$1" = "-version" ] && echo "supersonicd old"\n' > "$ROOT/opt/supersonicd"
chmod +x "$ROOT/opt/supersonicd"
echo "deadbeef" > "$ROOT/opt/installed.sha256"
printf '%s\ncommitsha\n0\n' "$D" > "$ROOT/bucket/current"
out="$(bash "$HERE/update-agent.sh" 2>&1)"
check "0% leaves every node alone" "$(cat "$ROOT/opt/installed.sha256")" "deadbeef"
check "and says why" "$(echo "$out" | grep -c 'not in this rollout')" "1"
# …and says what it is staying ON. `HAVE` used to be read after this check, so a
# node that declined an update always reported "staying on none" — including
# three that were running perfectly well at the time.
check "and names what it stays on" "$(echo "$out" | grep -c 'staying on deadbeef')" "1"

# 9. At 100 the rollout is everyone, which is what an unstaged publish means.
printf '%s\ncommitsha\n100\n' "$D" > "$ROOT/bucket/current"
out="$(bash "$HERE/update-agent.sh" 2>&1)"
check "100% installs" "$(cat "$ROOT/opt/installed.sha256")" "$D"

# 10. A pointer with no percentage behaves exactly as it did before this existed.
setup v4
echo "deadbeef" > "$ROOT/opt/installed.sha256"
printf '%s\ncommitsha\n' "$D" > "$ROOT/bucket/current"
out="$(bash "$HERE/update-agent.sh" 2>&1)"
check "no percentage means everyone" "$(cat "$ROOT/opt/installed.sha256")" "$D"

# 11. Nonsense is not a rollout instruction. A percentage nobody can parse must
#     not silently mean 0 — that would freeze the fleet on an old agent and look
#     like nothing was wrong.
setup v5
echo "deadbeef" > "$ROOT/opt/installed.sha256"
printf '%s\ncommitsha\nhalf\n' "$D" > "$ROOT/bucket/current"
out="$(bash "$HERE/update-agent.sh" 2>&1)"
check "an unparseable percentage means everyone" "$(cat "$ROOT/opt/installed.sha256")" "$D"

echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
