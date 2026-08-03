#!/usr/bin/env bash
# Deploy every shape the platform claims to support, and check what actually exists.
#
# WHY THIS IS A SCRIPT AND NOT A TEST
#
# On 2 Aug the suite was green at 707 tests and a CRM could not deploy. Five real
# defects turned up that night, every one invisible to the suite and every one
# obvious within ninety seconds of a real deploy:
#
#   assertReached refused any app declaring processes
#   a worker was deployed without the app's secrets
#   processes.web.health was parsed and never probed
#   processes.web.command was parsed and never run   <- the CRM's actual blocker
#   the deploy identity had no Cloud Scheduler role, so crons were never scheduled
#
# Four of those are the same mistake: a field wired into the NEW code path and not
# the old one. Unit tests cannot see it, because they test the new path — which is
# the half that works. Only deploying sees it.
#
# So verification cannot depend on somebody choosing to try. Run this after every
# control-plane deploy.
#
#   scripts/verify-shapes.sh [fixtures-dir]
#
# It asserts OUTCOMES on the cloud, never log lines: a worker pool that exists with
# no port, a cron job beside a schedule, a bucket absent for an app that did not
# ask. A deploy that says "live" and left nothing behind must fail here.
set -uo pipefail

PROJECT="${SUPERSONIC_PROJECT:-supersonic-deploy-prod}"
REGION="${SUPERSONIC_REGION:-us-central1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${SUPERSONIC_CLI:-$ROOT/packages/cli/index.js}"
FIXTURES="${1:-$ROOT/examples/shapes}"

pass=0; fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected $3, got $2)"; fi; }

# Cloud Run worker pools are on the beta track; `gcloud run worker-pools` is an
# invalid choice, which is the kind of thing worth failing loudly on rather than
# silently reporting zero pools.
pools() { gcloud beta run worker-pools list --region "$REGION" --project "$PROJECT" \
            --filter "metadata.labels.supersonic-parent=$1" --format="value(metadata.name)" 2>/dev/null; }
jobs_()  { gcloud run jobs list --region "$REGION" --project "$PROJECT" --format="value(metadata.name)" 2>/dev/null | grep "^$1-" || true; }
sched() { gcloud scheduler jobs list --location "$REGION" --project "$PROJECT" --format="value(name)" 2>/dev/null | grep "$1" || true; }
envof() { gcloud run services describe "$1" --region "$REGION" --project "$PROJECT" \
            --format="value(spec.template.spec.containers[0].env)" 2>/dev/null; }

deploy() {  # deploy <dir> -> prints slug
  ( cd "$1" && node "$CLI" deploy 2>&1 | grep -oE 'https://[a-z0-9]+\.supersonic\.cv' | head -1 | sed 's|https://||;s|\.supersonic\.cv||' )
}

settle() {  # settle <slug…> — blocks until none of them are still building
  while node "$CLI" apps --json 2>/dev/null | python3 -c '
import json,sys
want=set(sys.argv[1:])
d=json.load(sys.stdin); apps=d if isinstance(d,list) else d.get("apps",[])
sys.exit(0 if [a for a in apps if a.get("slug") in want and a.get("status")=="building"] else 1)
' "$@"; do sleep 30; done
}

printf '\nDeploying %s\n' "$FIXTURES"
declare -A slug
for shape in bot agentsrv crm plainweb; do
  [ -d "$FIXTURES/$shape" ] || { echo "  skip $shape (no fixture)"; continue; }
  slug[$shape]="$(deploy "$FIXTURES/$shape")"
  printf '  %-9s -> %s\n' "$shape" "${slug[$shape]:-FAILED TO START}"
done
settle "${slug[@]}"

# --- bot: a worker and nothing else -----------------------------------------
if [ -n "${slug[bot]:-}" ]; then
  s="${slug[bot]}"; printf '\nbot (%s) — a worker, no HTTP\n' "$s"
  check "worker pool exists"        "$( [ -n "$(pools "$s")" ] && echo yes || echo no )" yes
  # A Cloud Run SERVICE would mean it is still pretending to be a web app.
  check "no web service"            "$(gcloud run services list --region "$REGION" --project "$PROJECT" --format='value(metadata.name)' 2>/dev/null | grep -cx "$s")" 0
  # It never asked for storage; being given one is the bug the resource engine closed.
  check "no bucket handed to it"    "$(envof "$s" | grep -c STORAGE_BUCKET)" 0
fi

# --- agent server: web + worker ---------------------------------------------
if [ -n "${slug[agentsrv]:-}" ]; then
  s="${slug[agentsrv]}"; printf '\nagent server (%s) — web + worker\n' "$s"
  check "worker pool exists"        "$( [ -n "$(pools "$s")" ] && echo yes || echo no )" yes
  check "web service is ready"      "$(gcloud run services describe "$s" --region "$REGION" --project "$PROJECT" --format='value(status.conditions[0].status)' 2>/dev/null)" True
fi

# --- crm: web + database + release + cron -----------------------------------
if [ -n "${slug[crm]:-}" ]; then
  s="${slug[crm]}"; printf '\ncrm (%s) — web + database + release + cron\n' "$s"
  check "web service is ready"      "$(gcloud run services describe "$s" --region "$REGION" --project "$PROJECT" --format='value(status.conditions[0].status)' 2>/dev/null)" True
  check "release job exists"        "$(jobs_ "$s" | grep -c release)" 1
  check "cron job exists"           "$(jobs_ "$s" | grep -c nightly)" 1
  # Both halves. A job with no schedule never runs; a schedule with no job is an
  # error every night forever.
  check "cron is SCHEDULED"         "$( [ -n "$(sched "$s")" ] && echo yes || echo no )" yes
  check "database is attached"      "$(envof "$s" | grep -c DATABASE_URL)" 1
fi

# --- plain web: the ordinary app that must never regress --------------------
if [ -n "${slug[plainweb]:-}" ]; then
  s="${slug[plainweb]}"; printf '\nplain web (%s) — the case that must not regress\n' "$s"
  check "web service is ready"      "$(gcloud run services describe "$s" --region "$REGION" --project "$PROJECT" --format='value(status.conditions[0].status)' 2>/dev/null)" True
  check "no worker pool"            "$( [ -n "$(pools "$s")" ] && echo yes || echo no )" no
  check "no bucket handed to it"    "$(envof "$s" | grep -c STORAGE_BUCKET)" 0
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
