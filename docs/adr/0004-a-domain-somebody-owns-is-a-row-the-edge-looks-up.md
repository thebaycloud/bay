# A domain somebody owns is a row the edge looks up, and one DNS record they create

Until now the platform had exactly one way to name an app. `slugFromHost` in
`services/proxy` chopped `.supersonic.cv` off the Host header and everything the
request needed followed from what came out. That works because we issue those
names; it cannot work for a name we did not issue, because there is nothing in
`acme.com` to derive an app from. So a custom domain is a lookup — `app_domains`,
keyed by hostname — and the edge now resolves a request one of two ways depending
on which kind of address it arrived at (`services/proxy/src/door.ts`).

Everything else follows from two decisions.

## The certificate is authorized by the load balancer, not by DNS

Certificate Manager can prove a domain two ways. **DNS authorization** needs a
`_acme-challenge` CNAME in the customer's zone; **load-balancer authorization**
needs only that the domain already resolves to our load balancer and that the
certificate is in the map attached to it. We use the second.

The trade is exact and worth stating in both directions. Load-balancer
authorization costs the person **one** DNS record instead of two, which is the
whole flow: paste the domain, create one record, done — the same thing Vercel and
Railway ask for, and the thing a person already knows how to do. The price is
that a domain **already serving traffic somewhere else** cannot have its
certificate issued before the cutover, so between their DNS moving here and
HTTPS working here there is a window of minutes. For a domain that is not yet
serving anything — which is nearly every domain anybody attaches to an app they
just built — the window does not exist.

If that window ever becomes a real complaint, the answer is not to switch: it is
to offer DNS authorization as a second path for a domain that is already live,
and keep this one as the default. The state machine already has the shape for it;
what it would need is a second set of instructions on the page.

## There is no worker, and the states say so

`reconcileDomain` runs when somebody asks — opening the app's settings, pressing
the button, the page polling while a domain is not yet live. Every step is
idempotent, so running it twice is running it once.

That is not a queue we skipped building. The only thing this loop does after the
first `ensure` pair is **observe**: Google issues the certificate on its own
clock whether anybody is watching or not. So a person who closes the tab still
gets their certificate; what they do not get is a row that says so until
something looks again. `checked_at` is on every row for that reason, and a state
is always an argument from what was true a moment ago rather than a claim about
now.

`live` means Google is serving the certificate — not that we created one. It is
the only version of that claim a browser will agree with.

## Consequences worth stating

**A non-public app cannot be opened on a custom domain**, and the edge sends
those requests back to `<slug>.supersonic.cv` (302, path preserved). The session
cookie is scoped to `.supersonic.cv` and a browser will not send it to acme.com —
correctly. Without the redirect, a private app on a custom domain would show the
sign-in gate, sign-in would set a cookie on the wrong domain, and the visitor
would return exactly as anonymous as they left: a loop with no exit. The redirect
is the honest end of it, not a workaround.

**The platform address is not replaced.** `<slug>.supersonic.cv` goes on
answering for every app whatever domains are attached to it. It is what the room,
the x-ray, the CLI, every share link and every deploy log are built from, and it
is the only address whose DNS we control. A custom domain is an additional
**door**, not a new canonical one — which is also why nothing about attaching one
requires a rebuild: no `PUBLIC_URL` moves, no bundle is rewritten, no deploy runs.

**A hostname belongs to one app, decided by the primary key.** A second claim is
a constraint violation, not a race. The person who loses is told the name is
already connected and not which app has it — which app claimed a hostname is not
a stranger's business.

**A claim proves nothing until DNS points here**, and the edge's query says so:
rows in `pending_dns` are not served. Anyone can type `google.com` into their own
app's settings, and anyone can send our load balancer a request carrying
`Host: google.com`. What separates a claim from control is the domain resolving
to us, which is the only proof DNS can offer and the same proof the certificate
is issued against.

**Certificates are one per hostname**, named deterministically from it
(`certIdFor`), so creating one twice is the same resource. Certificate Manager
bounds how many entries a map may hold; well beyond where we are, and the number
is worth watching before it is worth designing around.

**IPv6 is not checked.** The load balancer answers on one IPv4 address today, so
"points here" means an A record. An owner who also publishes an AAAA record
pointing somewhere else would send v6 clients there, and nothing in the product
would say so. Worth fixing when the edge gets a v6 address; a check we cannot
state a correct answer for would be worse than none.
