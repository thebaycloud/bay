#!/usr/bin/env bash
# Create (or refresh) the Cloud Run Job that runs deploys.
#
# The job and the control plane are the SAME image with a different command, so
# they can never drift in code. What they can drift in is configuration, which is
# why this is a script in the repo and not a command someone once ran: the job
# needs the same environment as the service (database, buckets, lane flags), and
# the only way to keep those in step is to copy them from the live service every
# time rather than maintain a second list by hand.
#
# Run this after adding an env var to the control plane, or to recreate the job
# from scratch. Routine image updates do NOT need it — cloudbuild.yaml updates the
# job's image on every deploy from main, the same way it updates the service.
#
#   ./scripts/setup-deploy-job.sh
set -euo pipefail

PROJECT=supersonic-deploy-prod
REGION=us-central1
SERVICE=supersonic-control-plane
JOB=${JOB:-supersonic-deploy-job}

echo "reading the control plane's configuration…"
IMAGE=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --format='value(spec.template.spec.containers[0].image)')
SA=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --format='value(spec.template.spec.serviceAccountName)')
# name=value pairs, comma-separated, with any commas inside a value escaped the
# way gcloud expects. A missing PG_PASSWORD here is a job that cannot reach the
# database and a deploy that dies before it prints anything.
ENV_VARS=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --format='value[delimiter=","](spec.template.spec.containers[0].env.flatten("name","value",separator="="))' \
  | sed 's/,/^@^/g')

[ -n "$IMAGE" ] || { echo "could not read the service image — is $SERVICE deployed?" >&2; exit 1; }
echo "  image: $IMAGE"
echo "  service account: ${SA:-<default>}"

# --max-retries 0 is not a preference. A retried execution would claim the same
# run again and deploy a second time, and a deploy is not idempotent: it pushes
# images, runs migrations and moves live traffic.
#
# --task-timeout 60m is the point of the whole exercise: the request handler this
# replaces was capped at 600s, which a cold monorepo build is already within
# minutes of.
gcloud run jobs deploy "$JOB" \
  --image "$IMAGE" \
  --region "$REGION" --project "$PROJECT" \
  ${SA:+--service-account "$SA"} \
  --command node \
  --args --import,tsx,scripts/deploy-job.ts \
  --memory 4Gi --cpu 2 \
  --max-retries 0 \
  --task-timeout 60m \
  --set-env-vars "^@^${ENV_VARS}" \
  --quiet

echo
echo "done. Switch deploys over with:"
echo "  gcloud run services update $SERVICE --region $REGION --project $PROJECT --update-env-vars DEPLOY_JOB=1"
echo "and back off with --update-env-vars DEPLOY_JOB=0 if anything looks wrong."
