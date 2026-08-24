#!/usr/bin/env bash
#
# Which apps still run on the prebuilt runner, and therefore what still depends
# on infra/runner/ existing.
#
# THE QUESTION THIS ANSWERS, AND WHY IT NEEDS ASKING
#
# `RUNNER=0` changes what the NEXT deploy of an app does. It changes nothing
# about the apps already running, and nothing in this repository redeploys an app
# on its own — so "nothing is using the runner any more" never becomes true by
# waiting. The population of live runner revisions does not shrink.
#
# That matters because two things must not be deleted while this returns rows:
#
#   infra/runner/build.sh is the only thing that builds runner-node:latest and
#   runner-python:latest, and every live runner revision cold-starts FROM those
#   images. Delete the directory and they can never be patched again.
#
#   Every live runner revision also fetches a GCS artifact at start —
#   ready/<slug>/<release>.tgz — which only deleteApp removes. So the registry
#   retention policy has to exempt the runner images and that prefix until this
#   query is empty, or scale-from-zero breaks for every un-migrated app.
#
# Usage:  scripts/runner-decommission.sh          # report
#         scripts/runner-decommission.sh --slugs  # just the slugs, for scripting
set -euo pipefail

PROJECT=${PROJECT:-supersonic-deploy-prod}
REGION=${REGION:-us-central1}

# Matched on the image the revision actually runs, which is the only statement
# that cannot be stale. A deploy row saying "runner" describes what a deploy
# INTENDED; the revision's image is what it did.
mapfile -t rows < <(
  gcloud run services list \
    --project "$PROJECT" --region "$REGION" \
    --format="value(metadata.name,spec.template.spec.containers[0].image)" 2>/dev/null \
  | grep -E 'runner-(node|python)' || true
)

if [[ "${1:-}" == "--slugs" ]]; then
  printf '%s\n' "${rows[@]}" | awk 'NF{print $1}'
  exit 0
fi

if [[ ${#rows[@]} -eq 0 ]]; then
  echo "No service runs a runner image."
  echo
  echo "Safe to delete now:"
  echo "  infra/runner/                      (2 Dockerfiles, entrypoint.sh, prepare.sh, build.sh, popular-*.txt)"
  echo "  runnerPrepareConfig                   apps/web/lib/build-config.ts"
  echo "  runnerServes, runtimeRouting          apps/web/lib/repo-runtime.ts"
  echo "  RUNTIME_VERSIONS                      apps/web/lib/plan-deps.ts (+ the two vendored copies)"
  echo "  SUPERSONIC_CODE_* minting             apps/web/lib/deploy-pipeline.ts"
  echo
  echo "And the registry retention policy may stop exempting runner-node / runner-python."
  exit 0
fi

echo "${#rows[@]} service(s) still on the runner. infra/runner/ must NOT be deleted."
echo
printf '  %-24s %s\n' "SERVICE" "IMAGE"
printf '%s\n' "${rows[@]}" | awk 'NF{printf "  %-24s %s\n", $1, $2}'
echo
echo "Each of these keeps working until it is redeployed. To migrate one:"
echo "  the OWNER redeploys it — 'supersonic deploy' from the app's directory."
echo
echo "There is deliberately no --migrate-all here, and the reason is not caution:"
echo "the platform cannot redeploy most of these by itself. An upload-path app's"
echo "source exists only as the encrypted runner bundle in ready/<slug>/, which is"
echo "keyed per deploy and readable only by that app's own revision. A git-deployed"
echo "app could be re-cloned; an uploaded one cannot be reconstructed from anything"
echo "the platform holds. Whoever writes the backfill has to decide what to do"
echo "about that, and pretending a loop over slugs is sufficient would hide it."
