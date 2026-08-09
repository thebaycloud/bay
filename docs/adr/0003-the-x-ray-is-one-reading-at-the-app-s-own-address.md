# The X-ray is one reading, served at the app's own address

An app has had two places that describe it. `apps/web/app/apps/[slug]` is a page
in the control plane with four tabs — Overview, Issues, Data, Settings — and
`/_xray` is a live view served by the edge proxy at the app's own address. They
overlap on almost everything an owner wants to know, they are built by different
code in different services, and three of the four tab names are words
`CONTEXT.md` forbids showing a person.

We are collapsing them into one thing at one address: **the X-ray**, served by
the edge proxy at `<slug>.supersonic.cv`, assembled once into a single
**reading** and rendered twice — HTML for a person, JSON for the owner's agent,
split on `Accept`. The control plane keeps the list of apps and the account, and
its per-app page becomes a redirect.

The decision that carries weight is not the address. It is **one object, not one
URL.** This repo has paid for two-code-paths three times and written it down each
time: `apps/web/app/api/apps/route.ts:24-28`, where the server render and the
polling route built the same list and the "deployed" line vanished from every row
the moment a deploy started; `services/proxy/src/xray-panel.ts:1-14`, "two copies
would drift within a week, and the one that drifted would be the one nobody was
looking at"; and the retired term **Lane** in `CONTEXT.md`, two exported types
sharing a name that neither TypeScript nor Postgres can catch disagreeing. A
negotiated URL is worth nothing if the HTML branch reaches past the object for
anything — and `apps/web/app/apps/[slug]/page.tsx:67-77` does exactly that today,
calling `describeService` only on the Cloud Run path. That call moves inside the
assembler, or this decision is decoration.

Two places could assemble the reading. The control plane owns authentication, the
app list, and every action that changes something — `undo`, secrets, delete. The
edge proxy owns what no one else can see: `here` and `paths` live in its memory,
per instance, and it is the only process on the path of every request to every
hosted app. It also already reads Postgres directly (`services/proxy/src/db.ts`),
already serves `/_xray`, and already splits on `Accept` the safe way round —
testing for `text/html` rather than for JSON, which matters because a bare
`fetch()` sends `Accept: */*`, our own poll at `xray-panel.ts:116` included.
Written the other way, that poll would have received the HTML page.

We are putting it in the proxy. The live half cannot be moved; the durable half
can be read from anywhere; and the app's own address showing the truth about the
app is the same structural move as the room, decided in `0002`. The centre of the
page is then the app on its own origin rather than a foreign iframe.

The cost is real and we are paying it deliberately: `undo`, secrets and delete
are control-plane routes, and the proxy will forward them so the browser stays on
one origin. Routing on our side is cheaper than CORS on the owner's.

Two further consequences we accept. `readVisitor` resolves only a session cookie
today and must also accept a bearer token, since a person arrives with a cookie
and an agent with a CLI token — the same fork Mastodon's controller has, found in
`docs/research/agent-first-dashboard.md`. And the JSON is **page internals, not a
contract**, recorded as such next to the serialiser: no CLI reads any dashboard
route today, so the choice is still free, and it stops being free silently the
first time one does.
