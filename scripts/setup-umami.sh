#!/usr/bin/env bash
# Stand up the one umami instance that serves every hosted app's analytics.
#
# ONE INSTANCE, NOT ONE PER APP. Umami's own model is a "website" row per site
# with its own id, so thirty-two apps is thirty-two rows — not thirty-two
# containers, thirty-two revisions and thirty-two things to upgrade. The rows are
# created by the control plane on `createAppRecord`; this script only creates the
# thing they live in.
#
# ON CLOUD RUN, NOT THE FLEET. ADR 0001 moved TENANT compute off Cloud Run. This
# is platform compute, like the proxy and the control plane, and it belongs where
# they are.
#
# IAM IS THE SECURITY MODEL. The tracker never talks to this service directly —
# it talks to `<slug>.supersonic.cv/_bay` and the proxy forwards, signing each
# call with a Google ID token. So nothing reaches umami without an account we
# granted run.invoker, and the collection endpoint cannot be hammered by anyone
# who has not first been routed through an app that exists. See
# services/proxy/src/bay.ts, and the note above the deploy for why this is not
# `--ingress internal`.
#
# Idempotent: safe to re-run. It creates what is missing and updates what is not.
#
#   ./scripts/setup-umami.sh
set -euo pipefail

PROJECT=${PROJECT:-supersonic-deploy-prod}
REGION=${REGION:-us-central1}
INSTANCE=${INSTANCE:-supersonic-platform-pg}
SERVICE=${SERVICE:-supersonic-umami}
DB=umami
DBUSER=umami
# Pinned to the Postgres build. `latest` on that repo is the MySQL image, and an
# umami pointed at Postgres with the MySQL Prisma client fails at migrate time
# with an error about a driver rather than about the database.
IMAGE=${IMAGE:-ghcr.io/umami-software/umami:postgresql-latest}

say() { printf '\n== %s\n' "$1"; }

say "database and role on $INSTANCE"
CONN=$(gcloud sql instances describe "$INSTANCE" --project "$PROJECT" --format='value(connectionName)')
echo "  connection: $CONN"

# The password is generated here and never printed. It goes straight into Secret
# Manager and into the role, and if this script is re-run on an instance that
# already has the role, the SET PASSWORD keeps the two in step rather than
# leaving a secret nothing can authenticate with.
if ! gcloud secrets describe umami-db-password --project "$PROJECT" >/dev/null 2>&1; then
  openssl rand -base64 32 | tr -d '\n' | \
    gcloud secrets create umami-db-password --project "$PROJECT" --data-file=- --replication-policy=automatic
  echo "  created secret umami-db-password"
fi
DBPASS=$(gcloud secrets versions access latest --secret umami-db-password --project "$PROJECT")

gcloud sql users create "$DBUSER" --instance "$INSTANCE" --project "$PROJECT" --password "$DBPASS" 2>/dev/null \
  || gcloud sql users set-password "$DBUSER" --instance "$INSTANCE" --project "$PROJECT" --password "$DBPASS" --quiet
gcloud sql databases create "$DB" --instance "$INSTANCE" --project "$PROJECT" 2>/dev/null \
  && echo "  created database $DB" || echo "  database $DB already exists"

# UMAMI OWNS AND MIGRATES THIS SCHEMA. We never write to it, never read its
# tables directly, and never add a column to it. Everything we want out of it
# comes through the REST API — which means an umami upgrade is an image tag and
# not a coordination problem with our own migrations.
say "secrets"
if ! gcloud secrets describe umami-app-secret --project "$PROJECT" >/dev/null 2>&1; then
  openssl rand -hex 32 | tr -d '\n' | \
    gcloud secrets create umami-app-secret --project "$PROJECT" --data-file=- --replication-policy=automatic
  echo "  created secret umami-app-secret"
fi
# The URL-encoding matters: a generated password containing '/' or '+' inside a
# DATABASE_URL silently truncates the credentials and umami reports it as a
# host it cannot reach.
ENCPASS=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$DBPASS")
DBURL="postgresql://${DBUSER}:${ENCPASS}@localhost/${DB}?host=/cloudsql/${CONN}"
# `printf %s`, NOT a here-string. `<<<` appends a newline, and this repo has
# already paid for that once: see the note on FLEET_EDGE_SECRET in
# services/proxy/src/config.ts, where a trailing newline from `openssl rand`
# made Node refuse to build a header and 502'd every fleet app. Here the newline
# lands inside a DATABASE_URL, where the failure is quieter and worse — a
# connection string that looks right in the console and is rejected by the
# driver for a reason it will not name.
if ! gcloud secrets describe umami-database-url --project "$PROJECT" >/dev/null 2>&1; then
  printf %s "$DBURL" | gcloud secrets create umami-database-url --project "$PROJECT" --data-file=- --replication-policy=automatic
else
  printf %s "$DBURL" | gcloud secrets versions add umami-database-url --project "$PROJECT" --data-file=-
fi
echo "  umami-database-url points at $DB on $INSTANCE"

# The revision's service account has to be able to READ those two secrets, and
# creating a secret does not grant that — not even to the account that created
# it. Without this the deploy fails at "Creating Revision" with a permission
# error naming env[3] and env[4], which reads like a bad secret name and is not.
#
# Granted per secret rather than project-wide: this account already runs every
# tenant's app, and there is no reason for it to be able to read the platform's
# other secrets.
say "letting the runtime read those secrets"
RUNTIME_SA=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com
for S in umami-database-url umami-app-secret; do
  gcloud secrets add-iam-policy-binding "$S" \
    --member="serviceAccount:$RUNTIME_SA" \
    --role=roles/secretmanager.secretAccessor \
    --project "$PROJECT" --quiet >/dev/null
  echo "  $S → $RUNTIME_SA"
done

say "cloud run service $SERVICE"
# IAM IS THE GATE. `--no-allow-unauthenticated` means every request needs a
# Google-signed ID token for this service, minted by an account we granted
# run.invoker — the proxy, the control plane, and a human running the backfill.
# Nothing else reaches it, and that is what "internal only" actually has to mean
# here.
#
# `--ingress internal` was the first version of this line and it was wrong twice
# over. Cloud Run→Cloud Run traffic leaves over the public path unless the
# CALLER is configured to route all egress through a VPC connector, which the
# proxy is not — so internal ingress rejects the proxy's own reads, correctly
# signed, and the failure looks exactly like a wrong password. It also locks a
# human out of the admin UI from a laptop, which is where the default
# admin/umami password has to be changed. Two gates are only better than one
# when both let the right callers through.
#
# min-instances 1, AND THE REASONING THAT SAID 0 WAS WRONG.
#
# It said: a background service with no latency budget of its own — the tracker
# POST is fire-and-forget and the panel's read is cached for a minute, so a cold
# start costs nobody a render. Both halves of that are true and the conclusion
# did not follow, because the read is not the only thing that has to happen
# first. A cold umami has to LOG IN, and a login here is a container start plus a
# Prisma connection plus one bcrypt: 13, 20, 25 and 26 seconds, measured against
# this service on 24 Aug (warm: 90–440ms). Nothing that a person is waiting on
# can absorb that, so the edge gave up at ten seconds and told owners their
# visitors could not be counted — and because analytics is looked at rarely, the
# cold path was the ONLY path most owners ever took.
#
# The edge no longer waits for a login (services/proxy/src/analytics.ts), which
# is the half of the fix that belongs in code. This is the other half: an
# instance that is already up has nothing to wake. ~$8/month for a service whose
# entire job is to be readable when somebody looks.
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" --project "$PROJECT" \
  --ingress all \
  --no-allow-unauthenticated \
  --min-instances 1 --max-instances 4 \
  --memory 1Gi --cpu 1 \
  --set-cloudsql-instances "$CONN" \
  --set-env-vars "DATABASE_TYPE=postgresql,TRACKER_SCRIPT_NAME=a,COLLECT_API_ENDPOINT=/a" \
  --set-secrets "DATABASE_URL=umami-database-url:latest,APP_SECRET=umami-app-secret:latest" \
  --quiet

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format='value(status.url)')
echo "  $URL  (IAM-gated — an unauthenticated request is a 403)"

# Both callers reach umami with an ID token minted for THIS service, and Cloud
# Run checks run.invoker before the container sees the request. Without these two
# grants every read is a 403 that looks exactly like a wrong umami password —
# which is the single most expensive hour available in this whole setup.
say "letting the proxy and the control plane call it"
for CALLER in supersonic-proxy supersonic-control-plane; do
  SA=$(gcloud run services describe "$CALLER" --region "$REGION" --project "$PROJECT" \
        --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null)
  SA=${SA:-$RUNTIME_SA}
  gcloud run services add-iam-policy-binding "$SERVICE" \
    --region "$REGION" --project "$PROJECT" \
    --member="serviceAccount:$SA" --role=roles/run.invoker --quiet >/dev/null
  echo "  $CALLER ($SA) may invoke $SERVICE"
done

# And you, so the admin UI opens in a browser and the backfill runs from a
# laptop. `gcloud auth print-identity-token` is what apps/web/lib/gcp-rest.ts
# falls back to when there is no metadata server.
ME=$(gcloud config get-value account 2>/dev/null)
[ -n "$ME" ] && gcloud run services add-iam-policy-binding "$SERVICE" \
  --region "$REGION" --project "$PROJECT" \
  --member="user:$ME" --role=roles/run.invoker --quiet >/dev/null && echo "  $ME may invoke $SERVICE"

say "what is left, and it is not optional"
cat <<EOF
1. Umami creates an admin/umami account on first boot. Change that password NOW
   and put the new one in Secret Manager — this account can read every hosted
   app's visitor data:

     printf %s 'THE-NEW-PASSWORD' | gcloud secrets create umami-admin-password \\
       --project $PROJECT --data-file=- --replication-policy=automatic

   Then let the two callers READ it. Creating a secret grants nobody access to
   it, not even its creator's services, and the deploy in step 2 fails with a
   permission error naming an env index rather than the secret:

     for SA in supersonic-proxy supersonic-deployer; do
       gcloud secrets add-iam-policy-binding umami-admin-password \\
         --member="serviceAccount:\$SA@$PROJECT.iam.gserviceaccount.com" \\
         --role=roles/secretmanager.secretAccessor --project $PROJECT --quiet
     done

2. Point the proxy and the control plane at it. Both need the same three:

     gcloud run services update supersonic-proxy --region $REGION --project $PROJECT \\
       --update-env-vars UMAMI_URL=$URL,UMAMI_USER=admin \\
       --update-secrets UMAMI_PASSWORD=umami-admin-password:latest

     gcloud run services update supersonic-control-plane --region $REGION --project $PROJECT \\
       --update-env-vars UMAMI_URL=$URL,UMAMI_USER=admin \\
       --update-secrets UMAMI_PASSWORD=umami-admin-password:latest

   Both service accounts need run.invoker on $SERVICE, or every call is a 403
   that looks exactly like a wrong password.

3. Give the apps that already exist a site to be counted in — provisioning only
   runs on deploy, so without this the ~32 running apps never get one:

     npm --workspace @supersonic/web exec -- node --import tsx db/backfill-umami.ts

4. Verify both halves of the gate:
     signed:      curl -s -o /dev/null -w '%{http_code}\\n' -H "Authorization: Bearer \$(gcloud auth print-identity-token)" $URL/api/heartbeat   → 200
     unsigned:    curl -s -o /dev/null -w '%{http_code}\\n' $URL/api/heartbeat   → 403, never 200
EOF
