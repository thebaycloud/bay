#!/usr/bin/env bash
#
# fleetctl — move one app between runtimes, and look at the fleet.
#
# The cutover tool. docs/VM-FLEET.md commits to a big-bang DECISION and a per-app
# MECHANISM, and this is the mechanism: one app at a time, reversible in one
# command, so a bad app is a bad minute rather than a fleet-wide revert.
#
# Runs psql through a cloud-sql-proxy on 127.0.0.1:5432. Needs the platform
# Postgres password on stdin or in PGPASSWORD.
#
#   fleetctl.sh nodes
#   fleetctl.sh list
#   fleetctl.sh place <slug> [node]
#   fleetctl.sh unplace <slug>          # back to Cloud Run
#
set -uo pipefail

PROJECT=supersonic-deploy-prod
REGION=us-central1
REPO="${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy"
PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-postgres}
PGDATABASE=${PGDATABASE:-supersonic_platform}
export PGHOST PGPORT PGUSER PGDATABASE

if [ -z "${PGPASSWORD:-}" ]; then
  read -rs -p "platform postgres password: " PGPASSWORD; echo
  export PGPASSWORD
fi

q() { psql -qtA -F$'\t' -c "$1"; }

case "${1:-}" in

nodes)
  echo -e "NODE\tZONE\tIP\tCPUS\tGiB\tDRAIN\tPLACED\tLAST SEEN"
  q "SELECT n.name, n.zone, n.internal_ip, n.cpus,
            round(n.memory_bytes/1073741824.0)::int,
            n.drain, count(p.slug),
            to_char(n.last_seen,'HH24:MI:SS')
       FROM fleet_nodes n
       LEFT JOIN fleet_placements p ON p.node = n.name
      GROUP BY n.name ORDER BY n.name"
  ;;

list)
  echo -e "SLUG\tRUNTIME\tNODE\tIMAGE"
  q "SELECT a.slug, a.runtime, coalesce(p.node,'-'),
            coalesce(p.spec->>'image','-')
       FROM apps a
       LEFT JOIN fleet_placements p ON p.slug = a.slug
      ORDER BY a.runtime DESC, a.slug"
  ;;

place)
  SLUG="${2:?usage: fleetctl.sh place <slug> [node]}"
  NODE="${3:-}"

  if [ -z "$NODE" ]; then
    # Least-loaded live node. Same rule as lib/fleet.ts chooseNode, and it has to
    # stay the same rule — two placement policies would put an app somewhere the
    # control plane does not expect.
    NODE=$(q "SELECT n.name FROM fleet_nodes n
                LEFT JOIN fleet_placements p ON p.node = n.name
               WHERE n.drain = false
                 AND n.last_seen > now() - interval '90 seconds'
               GROUP BY n.name ORDER BY count(p.slug) ASC, n.name ASC LIMIT 1")
  fi
  if [ -z "$NODE" ]; then
    echo "no live node to place on — is an agent running and heartbeating?" >&2
    exit 1
  fi

  # The image is the one the existing build already produced. This is what makes
  # the move a RUNTIME change and not a rebuild: same artifact, different place
  # to run it.
  IMAGE="${REPO}/${SLUG}:latest"
  # Check by listing tags, not `images describe`: describe takes a different
  # argument shape and prints its usage on a plain IMAGE:tag, which looks exactly
  # like "no such image" — it rejected an image the agent had already pulled.
  #
  # "I looked and it is not there" and "I could not look" are different answers
  # and must not share an exit path. Run from a node, this gcloud has no
  # Artifact Registry permission, and collapsing the two turns a missing IAM
  # binding into a confident lie about the app.
  TAGS=$(gcloud artifacts docker images list "${REPO}/${SLUG}" --include-tags \
          --project="$PROJECT" --format="value(tags)" 2>/tmp/fleetctl.imgerr)
  if [ -s /tmp/fleetctl.imgerr ] && ! echo "$TAGS" | grep -q .; then
    echo "warning: could not verify the image ($(head -1 /tmp/fleetctl.imgerr | cut -c1-90))" >&2
    echo "         placing anyway — the agent will report a real pull failure" >&2
  elif ! echo "$TAGS" | grep -qw latest; then
    echo "no :latest tag at ${REPO}/${SLUG} — this app has never produced an image" >&2
    echo "(static apps publish to GCS and runner-lane apps fetch a bundle at start;" >&2
    echo " neither can be placed until it builds a real image)" >&2
    exit 1
  fi

  # 2Gi and 1024 shares mirror DEFAULT_SCALE, so an app that never declared a
  # size gets exactly what Cloud Run was giving it.
  SPEC=$(printf '{"slug":"%s","image":"%s","port":8080,"memoryBytes":2147483648,"cpuShares":1024,"healthPath":"/"}' "$SLUG" "$IMAGE")

  q "INSERT INTO fleet_placements(slug,node,spec)
     VALUES ('$SLUG','$NODE','$SPEC'::jsonb)
     ON CONFLICT (slug,node) DO UPDATE SET spec = EXCLUDED.spec, placed_at = now()" >/dev/null
  q "UPDATE apps SET runtime='fleet' WHERE slug='$SLUG'" >/dev/null
  echo "$SLUG -> fleet on $NODE"
  echo "  the node picks this up on its next reconcile (<=10s)"
  ;;

unplace)
  SLUG="${2:?usage: fleetctl.sh unplace <slug>}"
  # Runtime first, then the placement. In this order the app is already marked
  # 'cloudrun' when the placement disappears, so a node reconciling in between
  # sees an app it should not run and stops it — rather than a placement with no
  # runtime, which reads as a bug.
  q "UPDATE apps SET runtime='cloudrun' WHERE slug='$SLUG'" >/dev/null
  q "DELETE FROM fleet_placements WHERE slug='$SLUG'" >/dev/null
  echo "$SLUG -> cloudrun (placement dropped; the node stops it on its next reconcile)"
  ;;

*)
  sed -n '2,20p' "$0"
  exit 1
  ;;
esac
