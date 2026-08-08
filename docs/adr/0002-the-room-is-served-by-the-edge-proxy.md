# The room is served by the edge proxy, not by the node agent

An app's address answers before the app does. A deploy reserves its slug up front,
so `<slug>.supersonic.cv` exists from the first second, and something has to be
there. Today that something is `pageBuilding()` in `services/proxy` — a dark page
that says "Deploying…" and reloads itself every three seconds. We are replacing it
with the **room**: a live rendering of the build, at the app's own address, which
**opens** into the app the moment a process first answers.

Two places could serve it. The node agent already owns a family of holding pages
(`page()` in `services/fleet/agent/router.go`), and putting the room there would
sit it closest to the work being rendered. We are putting it in the edge proxy
instead, and the reason is not architectural taste.

The edge proxy fronts every `*.supersonic.cv` and ships on an ordinary push to
`main`. The node agent has no deploy path at all — it is updated by hand, by
copying `.go` files to each node and running a restart script, and two merged
changes are currently in `main` and on no node. A visual surface is edited
constantly: sprite timings, copy, the pacing of the opening. Putting the room in
the agent would mean a manual copy to every node for each of those edits, and
would block the whole feature behind a pipeline that does not exist. Putting it
in the proxy costs nothing and needs no Go changes whatsoever.

The edge is also the correct layer on the facts. It already decides what a slug
serves — tunnel, holding, failed, stalled, no-web, live — and an app that has
never come up never reaches a node at all.

## Consequences worth stating

The room cannot show anything the edge cannot see. Fine-grained build events have
to reach the proxy to be rendered, which is a data path that does not exist today;
the room is only as honest as that feed, and if the feed is coarse the room must
be visibly idle rather than invent motion to fill the gap.

An app whose *process* is misbehaving after it has come up is a node concern, and
the node's own pages stay where they are. The room covers one state only: an app
that has never successfully served. Everything after that belongs to the x-ray,
which is a separate surface and a separate decision.

The proxy holds tunnel state in memory at `min-instances=1`. The room adds live
connections to that same process. If the proxy is ever scaled out, both need
shared state, and the room will make that limit arrive sooner than the tunnel
would have on its own.

This does not reopen the node agent's missing deploy path. It routes around it for
one feature. The gap is still there, and every future change to the agent is still
dark until it is fixed.
