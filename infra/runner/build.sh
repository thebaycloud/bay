#!/usr/bin/env bash
# Build + push the prebuilt runner base images to Artifact Registry.
#
# These are built rarely — once, then on a schedule to refresh the warm package
# set — NOT per deploy. A deploy just points a Cloud Run revision at
# runner-node:latest / runner-python:latest and hands it the code (see the runner
# lane in apps/web/app/api/deploy/route.ts).
#
# Usage:  ./build.sh            # both
#         ./build.sh node       # one
set -euo pipefail

PROJECT="${PROJECT:-supersonic-deploy-prod}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-cloud-run-source-deploy}"
REG="$REGION-docker.pkg.dev/$PROJECT/$REPO"
here="$(cd "$(dirname "$0")" && pwd)"

langs=("${@:-node python}")
for lang in ${langs[@]}; do
  img="$REG/runner-$lang:latest"
  echo "== building $img (context: $here, dockerfile: $lang/Dockerfile) =="
  cfg="$(mktemp)"
  cat > "$cfg" <<YAML
steps:
  - name: gcr.io/cloud-builders/docker
    args: ["build", "-f", "$lang/Dockerfile", "-t", "$img", "."]
images: ["$img"]
options:
  logging: CLOUD_LOGGING_ONLY
YAML
  gcloud builds submit "$here" --project "$PROJECT" --region "$REGION" --config "$cfg"
  rm -f "$cfg"
  echo "== pushed $img =="
done
