# The box

A machine you develop on instead of your laptop, whose dev servers come out at
real Bay addresses.

The whole idea is two halves that already existed, joined:

- **[herdr](https://github.com/herdrdev/herdr) holds the terminals open.** The
  panes, the coding agents and the dev servers live on a VM. `bay box` attaches
  this laptop's terminal to that server, so closing the lid detaches a client
  rather than killing the work, and `bay box` again comes back to it.
- **The edge already fronts every `*.thebay.cloud`.** It resolves the slug from
  the Host header, reads the app row, and forwards to whatever `run_url` says
  (`services/proxy/src/forward.ts`). It does not care what is on the other end.
  So a preview is an app row whose `run_url` is this box, and `router.js` is the
  other end: slug in, dev server out.

Nothing new is asked of the platform. No tunnel, no second DNS story, no
`trycloudflare` link to paste into chat — the preview is at a Bay address,
behind Bay's sign-in, private to its owner.

## Using it

```
bay box                     attach to the box (herdr, session "main")
bay box status              services, previews, agents
bay box ssh [cmd]           a plain shell over there

bay task "add a login page" on the box: worktree + agent + dev server + address
bay preview 3000 [--as x]   publish a port by hand, if you ever need to
```

`bay task` is the one to reach for. It makes the worktree, opens a herdr
workspace for it, starts the agent on the task, starts the dev server beside it
on a port of its own, and prints the address the result will be at.

The address does not have to be asked for. `watch.js` notices any socket that
starts listening in the dev range, follows it back to the checkout it was
started in (`/proc/<pid>/cwd`), takes the branch name as the slug, and
publishes. A dev server started over ssh, from a script, or by an agent that
never went through a pane is published on exactly the same terms as one started
by hand. Drop a `.bay-no-preview` file in a checkout to opt it out.

Three agents on three branches therefore get three addresses without anybody
naming anything — which is why `bay task` hands each task a free `PORT` instead
of letting all three race for 3000.

## What is on the box

| Path | What it is |
| --- | --- |
| `/srv/box/router.js` | the edge's other end, `:8080` (`box-router.service`) |
| `/srv/box/watch.js` | publishes dev servers as they appear (`bay-watch.service`) |
| `/srv/box/routes.json` | slug → port, world-readable, written atomically |
| `/srv/box/router.env` | `FLEET_EDGE_SECRET`, mode 600 |
| `/srv/box/env` | `BAY_OWNER_ID`, `BAY_WORKSPACE_ID` — whose previews these are |
| `/usr/local/bin/bay*` | the box-side CLI |
| herdr server | `herdr.service`, session `main` |
| cloud-sql-proxy | `bay-sql-proxy.service`, control plane on `:5433` |

Port 8080 answers the open internet — Cloud Run has no static egress range to
firewall down to — so the edge secret is the entire authorisation, checked in
constant time before the routing table is consulted at all. See the comment at
the top of `router.js`.

A preview row is written with `runtime = 'cloudrun'` on purpose: the fleet
reconciler selects on `runtime = 'fleet'` (`apps/web/lib/reconcile.ts`), so
nothing tries to place, converge, or take away an app that is really a dev
server on somebody's box.

## Making one

```sh
gcloud compute instances create box-1 \
  --project supersonic-deploy-prod --zone us-central1-a \
  --machine-type e2-standard-4 \
  --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
  --boot-disk-size 50GB --boot-disk-type pd-balanced \
  --tags box \
  --metadata enable-oslogin=TRUE \
  --scopes https://www.googleapis.com/auth/cloud-platform

# The edge reaches the router over the public internet; the secret is what
# makes that safe.
gcloud compute firewall-rules create allow-edge-to-box \
  --project supersonic-deploy-prod --network default \
  --allow tcp:8080 --source-ranges 0.0.0.0/0 --target-tags box
```

There is no public SSH port; reach it through IAP:

```
Host bay-box
  User <you>
  IdentityFile ~/.ssh/google_compute_engine
  ProxyCommand gcloud compute start-iap-tunnel box-1 %p --listen-on-stdin \
    --project=supersonic-deploy-prod --zone=us-central1-a --verbosity=warning
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  ServerAliveInterval 30
```

Then, on the box:

```sh
./provision.sh                      # node 22, herdr (pinned), claude code
sudo install -m755 bin/bay bin/bay-preview bin/bay-task /usr/local/bin/
sudo install -m644 router.js watch.js /srv/box/
sudo install -m644 systemd/*.service /etc/systemd/system/
printf 'BAY_OWNER_ID=%s\nBAY_WORKSPACE_ID=%s\n' "$OWNER" "$WORKSPACE" | sudo tee /srv/box/env
printf 'FLEET_EDGE_SECRET=%s\n' "$SECRET" | sudo tee /srv/box/router.env
sudo chmod 600 /srv/box/router.env
sudo systemctl enable --now herdr bay-sql-proxy box-router bay-watch
```

herdr is pinned in `provision.sh` because client and server negotiate a
protocol number, and a mismatch fails the attach with a message that does not
say so — the box's version must match the one on the laptop.

And on the laptop, `client/bay` and `client/bay-box` go in `~/.local/bin`. Both
`bay` shims add a verb rather than standing in front of one: anything that is
not `box` (or `preview`/`task` on the box) is handed to the real
`@thebaycloud/cli` when it is installed.

## Status

A working end-to-end demo, run by hand — not yet a product surface. There is no
button in the app that makes a box, one box exists (`box-1`), and it points at
the production control plane, which is the reason the staging work started.
