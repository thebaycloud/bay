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
# Run this after changing the control plane's configuration, or to recreate the
# job from scratch. Routine image updates do NOT need it — cloudbuild.yaml moves
# the job's image with the service on every deploy from main.
#
#   ./scripts/setup-deploy-job.sh
set -euo pipefail

PROJECT=supersonic-deploy-prod
REGION=us-central1
SERVICE=supersonic-control-plane
JOB=${JOB:-supersonic-deploy-job}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "reading the control plane's configuration…"
gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format=json > "$WORK/service.json"

# Read the whole service and emit the flag VALUES, rather than trying to coax
# them out of --format strings. Three things make that the only workable route:
# a value may legally contain a comma, most of the interesting variables are
# Secret Manager references rather than literals (so they need --set-secrets, and
# a flatten() of them produces confident nonsense), and the Cloud SQL instance
# lives in an annotation rather than anywhere env-shaped. Getting any of the
# three wrong yields a job that starts and then cannot reach the database.
python3 - "$WORK/service.json" "$WORK" <<'PY'
import json, sys
service, out = sys.argv[1], sys.argv[2]
d = json.load(open(service))
tpl = d["spec"]["template"]
c = tpl["spec"]["containers"][0]
ann = tpl["metadata"].get("annotations") or {}

def write(name, text):
    open(f"{out}/{name}", "w").write(text)

# A YAML file, not --set-env-vars. Every delimiter gcloud offers has to be a
# character that appears in no value, and these values include commas, colons,
# slashes and an `@` (APP_RUNTIME_SERVICE_ACCOUNT is an email address) — the
# first attempt at this picked `@` and produced a job whose runtime service
# account had become an environment variable name. A file has no delimiter.
write("env.yaml", "".join(
    f'{e["name"]}: {json.dumps(e["value"])}\n' for e in c["env"] if "value" in e))
write("secrets", ",".join(
    f'{e["name"]}={e["valueFrom"]["secretKeyRef"]["name"]}:{e["valueFrom"]["secretKeyRef"]["key"]}'
    for e in c["env"] if "valueFrom" in e))
write("image", c["image"])
write("sa", tpl["spec"].get("serviceAccountName", ""))
write("cloudsql", ann.get("run.googleapis.com/cloudsql-instances", ""))
print(f'  {len([e for e in c["env"] if "value" in e])} env vars, '
      f'{len([e for e in c["env"] if "valueFrom" in e])} secrets')
PY

IMAGE=$(cat "$WORK/image"); SA=$(cat "$WORK/sa"); CLOUDSQL=$(cat "$WORK/cloudsql")
SECRETS=$(cat "$WORK/secrets")
[ -n "$IMAGE" ] || { echo "could not read the service image — is $SERVICE deployed?" >&2; exit 1; }
echo "  image: $IMAGE"
echo "  service account: ${SA:-<default>}"
echo "  cloud sql: ${CLOUDSQL:-<none>}"

# --max-retries 0 is not a preference. A retried execution would claim the same
# run again and deploy a second time, and a deploy is not idempotent: it pushes
# images, runs migrations and moves live traffic.
#
# --task-timeout 60m is the point of the whole exercise: the request handler this
# replaces was capped at 600s, which a cold monorepo build is already within
# minutes of.
#
# The --args here must match DEPLOY_JOB_ARGS in apps/web/lib/deploy-runs.ts. Each
# execution passes that list plus the run id, because `--args` on an execution
# REPLACES the job's arguments rather than appending to them.
#
# AND IT REPLACES MORE THAN THAT. `--set-secrets` and `--env-vars-file` are both
# whole-set operations, so everything the JOB carries that the SERVICE does not
# is destroyed by running this. That list is not empty and grows:
#
#   FLEET_EDGE_SECRET   a secret the job needs and the service does not
#   BUILDER, BUILDKIT_HOST, RAILPACK_APPS, FLEET_APPS, FLEET_PLACEMENT
#   /buildkit/{ca,cert,key}   mTLS material for the build plane, mounted as files
#   --network / --subnet / --vpc-egress   how the job reaches that build plane
#
# This script is a BOOTSTRAP — "make a job that matches the service" — and not a
# reconciler. Re-running it on a live job silently removes the above.
#
# On 12 Aug a hand-run `--set-secrets` for the build-plane certificates wiped all
# twelve of the job's secrets, including PG_PASSWORD, and every deploy failed
# with `Postgres config missing` until they were put back. cloudbuild.yaml
# already carries a paragraph saying `--update-env-vars, never --set-env-vars`
# for precisely this reason; the same is true of secrets and was learned twice.
gcloud run jobs deploy "$JOB" \
  --image "$IMAGE" \
  --region "$REGION" --project "$PROJECT" \
  ${SA:+--service-account "$SA"} \
  --command node \
  --args=--import,tsx,scripts/deploy-job.ts \
  --memory 4Gi --cpu 2 \
  --max-retries 0 \
  --task-timeout 60m \
  --env-vars-file "$WORK/env.yaml" \
  ${SECRETS:+--set-secrets "$SECRETS"} \
  ${CLOUDSQL:+--set-cloudsql-instances "$CLOUDSQL"} \
  --quiet

echo
echo "checking the job matches the service…"
python3 - "$JOB" "$REGION" "$PROJECT" <<'PY'
import json, subprocess, sys
job, region, project = sys.argv[1:4]
d = json.loads(subprocess.check_output([
    "gcloud", "run", "jobs", "describe", job, "--region", region,
    "--project", project, "--format=json"]))
spec = d["spec"]["template"]["spec"]["template"]["spec"]
env = spec["containers"][0].get("env", [])
plain = [e for e in env if "value" in e]
secret = [e for e in env if "valueFrom" in e]
ann = d["spec"]["template"]["metadata"].get("annotations") or {}
print(f'  {len(plain)} env vars, {len(secret)} secrets, '
      f'cloudsql={ann.get("run.googleapis.com/cloudsql-instances", "<none>")}')
missing = [n for n in ("PG_CONN", "PG_PASSWORD", "ASSETS_BUCKET") if n not in {e["name"] for e in env}]
if missing:
    print(f"  MISSING: {', '.join(missing)} — the job cannot run a deploy without these", file=sys.stderr)
    sys.exit(1)
PY

echo
echo "done. Switch deploys over with:"
echo "  gcloud run services update $SERVICE --region $REGION --project $PROJECT --update-env-vars DEPLOY_JOB=1"
echo "and back off with --update-env-vars DEPLOY_JOB=0 if anything looks wrong."
