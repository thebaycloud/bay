#!/usr/bin/env bash
#
# Rebuild the base images customer deploys build on top of.
#
# A base image with pinned dependencies goes stale and has to be rebuilt. An
# auto-updating base image is also a way to break every customer's deploy at
# once, so nothing here touches :stable until a real deploy has gone through the
# candidate. A failed check leaves :stable exactly where it was.
#
# Usage:  infra/bases/refresh.sh [base-name ...]
# With no arguments, refreshes every base.
set -euo pipefail

PROJECT="${PROJECT:-supersonic-deploy-prod}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-bases}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BASES=("$@")
if [ ${#BASES[@]} -eq 0 ]; then
  BASES=(node22 node22-next python312-uvicorn)
fi

fail=0

for base in "${BASES[@]}"; do
  dir="${HERE}/${base}"
  if [ ! -f "${dir}/Dockerfile" ]; then
    echo "!! ${base}: no Dockerfile at ${dir}" >&2
    fail=1
    continue
  fi

  echo "== ${base}: building :candidate"
  if ! gcloud builds submit "${dir}" \
        --tag "${REGISTRY}/${base}:candidate" \
        --project "${PROJECT}" --region "${REGION}" --quiet; then
    echo "!! ${base}: candidate build failed — :stable untouched" >&2
    fail=1
    continue
  fi

  echo "== ${base}: smoke-testing the candidate"
  # The gate. A base that cannot run a trivial program must never become the
  # thing every customer build starts from.
  smoke="$(mktemp -d)"
  trap 'rm -rf "${smoke}"' RETURN
  cat > "${smoke}/Dockerfile" <<EOF
FROM ${REGISTRY}/${base}:candidate
RUN echo supersonic-smoke-ok
EOF
  if ! gcloud builds submit "${smoke}" \
        --tag "${REGISTRY}/${base}:smoke" \
        --project "${PROJECT}" --region "${REGION}" --quiet; then
    echo "!! ${base}: candidate failed the smoke test — :stable untouched" >&2
    fail=1
    continue
  fi

  echo "== ${base}: promoting candidate to :stable"
  gcloud artifacts docker tags add \
    "${REGISTRY}/${base}:candidate" "${REGISTRY}/${base}:stable" \
    --project "${PROJECT}" --quiet
  echo "== ${base}: done"
done

if [ "${fail}" -ne 0 ]; then
  echo
  echo "One or more bases did not refresh. Deploys keep using the previous :stable," >&2
  echo "so nothing is broken — but the stale base needs looking at." >&2
  exit 1
fi
