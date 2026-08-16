#!/usr/bin/env bash
# Create the warm deploy worker: the same image and the same pipeline as the
# Cloud Run Job, on a container that is already running.
#
# WHY IT IS WORTH AN ALWAYS-ON INSTANCE. The Job costs ~118 s before the
# pipeline's first line, and `job-launch` attributes ~116 s of that to Cloud Run
# scheduling an execution and pulling the image. That is roughly half of a 238 s
# deploy. One idle instance is cheaper than paying that on every deploy, and the
# fallback means it is never the difference between deploying and not.
#
# DERIVED FROM THE JOB, not from the control-plane service, and that is the
# whole reason this script exists rather than a `gcloud run deploy` in a
# runbook. The job is the thing that runs this pipeline: it carries
# FLEET_EDGE_SECRET, the lane flags, BUILDKIT_HOST, the mTLS certificates for
# the build plane and the VPC egress that reaches it — none of which the service
# has. A worker built from the service would start, accept a deploy, and fail it
# on something the job has and it does not.
#
# Re-runnable. `gcloud run deploy` on an existing service replaces its
# configuration, which is correct here: this script IS the definition.
set -euo pipefail

# No `| grep -q` anywhere in this file. Under `set -euo pipefail` it inverts its
# own answer — grep exits at the first match, the producer takes SIGPIPE and
# exits 141, and pipefail promotes that to the pipeline's status. It cost the
# fleet a node; see services/fleet/image/provision.sh.

PROJECT="${PROJECT:-supersonic-deploy-prod}"
REGION="${REGION:-us-central1}"
JOB="${JOB:-supersonic-deploy-job}"
WORKER="${WORKER:-supersonic-deploy-worker}"
CONTROL_PLANE="${CONTROL_PLANE:-supersonic-control-plane}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "reading ${JOB}…"
gcloud run jobs describe "$JOB" --region "$REGION" --project "$PROJECT" --format=json > "$WORK/job.json"

python3 - "$WORK/job.json" "$WORK" <<'PY'
import json, sys
job, out = sys.argv[1], sys.argv[2]
d = json.load(open(job))
# The job nests one level deeper than a service and puts its annotations on the
# OUTER template only: spec.template.metadata.annotations, then
# spec.template.spec.template.spec for the container. The inner template has no
# metadata at all, which is what the first version of this script assumed and
# died on.
outer = d["spec"]["template"]
top = (outer.get("metadata") or {}).get("annotations") or {}
tpl = outer["spec"]["template"]
c = tpl["spec"]["containers"][0]
ann = (tpl.get("metadata") or {}).get("annotations") or {}

def write(name, text):
    open(f"{out}/{name}", "w").write(text)

# A YAML file rather than --set-env-vars: every delimiter gcloud offers has to be
# a character appearing in no value, and these include commas, colons, slashes
# and an `@`. A file has no delimiter. (setup-deploy-job.sh learned this by
# picking `@` and turning a service account into a variable name.)
write("env.yaml", "".join(
    f'{e["name"]}: {json.dumps(e["value"])}\n' for e in c["env"] if "value" in e))

# Env-var secrets and FILE-mounted secrets are different flags with the same
# name, and the build plane's certificates are the second kind.
env_secrets = [
    f'{e["name"]}={e["valueFrom"]["secretKeyRef"]["name"]}:{e["valueFrom"]["secretKeyRef"]["key"]}'
    for e in c["env"] if "valueFrom" in e]

vols = {v["name"]: v for v in (tpl["spec"].get("volumes") or [])}
file_secrets = []
for m in (c.get("volumeMounts") or []):
    v = vols.get(m["name"], {})
    sec = v.get("secret")
    if not sec:
        continue
    for item in sec.get("items") or []:
        file_secrets.append(f'{m["mountPath"]}/{item["path"]}={sec["secretName"]}:{item.get("key","latest")}')

write("secrets", ",".join(env_secrets + file_secrets))
write("image", c["image"])
write("sa", tpl["spec"].get("serviceAccountName", ""))
write("cloudsql", ann.get("run.googleapis.com/cloudsql-instances", "")
      or top.get("run.googleapis.com/cloudsql-instances", ""))
write("vpc", json.dumps(top.get("run.googleapis.com/network-interfaces", "")))
print(f'  {len([e for e in c["env"] if "value" in e])} env vars, '
      f'{len(env_secrets)} secrets, {len(file_secrets)} mounted files')
PY

IMAGE=$(cat "$WORK/image")
SA=$(cat "$WORK/sa")
SECRETS=$(cat "$WORK/secrets")
CLOUDSQL=$(cat "$WORK/cloudsql")

echo "deploying ${WORKER} from ${IMAGE}…"
# --no-cpu-throttling IS NOT OPTIONAL. The worker answers 202 and then runs the
# pipeline for minutes with no request in flight; throttled, Cloud Run takes its
# CPU away the moment the response is sent and the deploy stops mid-build.
#
# --min-instances=1 is the point of the whole thing: an instance that has to
# start is a Job with extra steps.
#
# --max-instances=1 with --concurrency=1 means one deploy at a time, which the
# worker also enforces in-process. Two guards for one rule because they fail
# differently: the in-process one refuses cleanly with 429, and this one is what
# stops Cloud Run answering a refusal by starting a second container.
gcloud run deploy "$WORKER" \
  --image "$IMAGE" \
  --region "$REGION" --project "$PROJECT" \
  ${SA:+--service-account "$SA"} \
  --command node \
  --args=--import,tsx,scripts/deploy-worker.ts \
  --memory 4Gi --cpu 2 \
  --no-cpu-throttling \
  --min-instances 1 --max-instances 1 --concurrency 1 \
  --timeout 3600 \
  --no-allow-unauthenticated \
  --env-vars-file "$WORK/env.yaml" \
  ${SECRETS:+--set-secrets "$SECRETS"} \
  ${CLOUDSQL:+--set-cloudsql-instances "$CLOUDSQL"} \
  --network default --subnet default --vpc-egress private-ranges-only \
  --quiet

URL=$(gcloud run services describe "$WORKER" --region "$REGION" --project "$PROJECT" --format='value(status.url)')
echo
echo "worker at $URL"
echo
echo "It will not receive anything until the control plane is told where it is:"
echo
echo "  gcloud run services update $CONTROL_PLANE \\"
echo "    --region $REGION --project $PROJECT \\"
echo "    --update-env-vars DEPLOY_WORKER_URL=$URL"
echo
echo "and the control plane's service account needs run.invoker on it:"
echo
echo "  gcloud run services add-iam-policy-binding $WORKER \\"
echo "    --region $REGION --project $PROJECT \\"
echo "    --member=serviceAccount:${SA:-<control-plane-sa>} --role=roles/run.invoker"
echo
echo "Both are deliberate steps: until they run, every deploy takes the Job,"
echo "which is what happened before this service existed."
