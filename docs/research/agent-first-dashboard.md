# One object, two renderings: is an agent-first dashboard sound?

Research date: 2026-08-09. Read-only investigation. The repo was read first —
`CONTEXT.md`, `docs/adr/0002-the-room-is-served-by-the-edge-proxy.md`,
`services/proxy/src/{index,xray,xray-page,xray-panel}.ts`,
`apps/web/app/api/apps/route.ts`, `apps/web/app/apps/[slug]/page.tsx`,
`apps/web/components/Cockpit.tsx` — and every external claim below is cited to
the source that owns it.

Specs were fetched as text and quoted verbatim (`rfc-editor.org/rfc/rfc9110.txt`,
`rfc9111.txt`, `fetch.spec.whatwg.org`). Six claims were verified by live HTTP
probe rather than by reading a vendor's prose; those are marked
**[probed 2026-08-09]** and the exact request is given so they can be re-run.

---

## The one-paragraph answer

The bet is sound, and it is already shipped by real systems: Mastodon serves
HTML, RSS and ActivityStreams from one URL on `Accept` today, and GitHub's own
web app returns its React data payload as JSON from `github.com/rails/rails`
when you ask for `application/json` — both verified live. The mechanism is
specified (RFC 9110 §12.1), the CORS-preflight fear is unfounded (`Accept` is a
safelisted request header), and the browser-`fetch()`-sends-`*/*` hazard is real
but is already handled the safe way round in `services/proxy/src/index.ts:92`,
which tests for `text/html` rather than for JSON. **The strongest argument
against it is not HTTP, it is the contract**: every organisation that tried to
make one negotiated URL serve both a human and a documented, versioned API
either moved the API to a separate host (GitHub, Vercel, Netlify, Fly,
Cloudflare, Heroku — all six incumbents, without exception) or kept negotiation
only for an *undocumented internal* payload (GitHub's own dashboard). One URL
can carry two renderings of the same object; it cannot easily carry two
deprecation policies, two auth models and two versioning schemes. Mastodon's
own controller shows the seam: it needs a *different authentication path* for
the JSON representation than for the HTML one
(`require_account_signature!`, only `if request.format == :json`), and a
`Vary: Accept, Accept-Language, Cookie` that makes the response effectively
uncacheable by anyone but the browser that asked for it. That is affordable for
Supersonic — an owner-gated dashboard is uncacheable anyway — but it means the
saving is *representation drift*, not infrastructure. On settings: Apple's own
HIG argues both halves of the question and lands on a split, not an abolition —
put task-specific options in the task, and keep "general, infrequently changed"
options in a settings area, because people "must suspend what they're doing" to
reach one. Domains, billing, delete-app and CLI tokens are exactly the class the
HIG says keeps a settings area.

---

## 1. Content negotiation as a product decision

### 1a. What the specs actually say

RFC 9110 §12.1 defines proactive (server-driven) negotiation and then lists,
under its own heading, **"Proactive negotiation has serious disadvantages:"**

> *  It is impossible for the server to accurately determine what might be
>    "best" for any given user […]
> *  Having the user agent describe its capabilities in every request can be
>    both very inefficient […] and a potential risk to the user's privacy;
> *  It complicates the implementation of an origin server and the algorithms
>    for generating responses to a request; and,
> *  It limits the reusability of responses for shared caching.

(`https://www.rfc-editor.org/rfc/rfc9110.txt`, §12.1.) The same section warns
that "A user agent cannot rely on proactive negotiation preferences being
consistently honored".

Only the fourth disadvantage bites a private dashboard, and it bites nothing
that was cacheable to begin with.

`Vary` is defined in §12.5.5. Two clauses matter here:

> An origin server SHOULD generate a Vary header field on a cacheable response
> when it wishes that response to be selectively reused for subsequent requests.

> Vary might be elided when an origin server considers variance in content
> selection to be less significant than Vary's performance impact on caching,
> particularly when reuse is already limited by cache response directives
> (Section 5.2 of [CACHING]).

> There is no need to send the Authorization field name in Vary because reuse of
> that response for a different user is prohibited by the field definition.

So `Vary` is a *SHOULD on cacheable responses*, and the spec itself blesses
eliding it when `Cache-Control` already prevents reuse. `no-store` is such a
directive.

RFC 9111 §4.1 is where the intermediary hazard lives:

> the cache MUST NOT use that stored response without revalidation unless all
> the presented request header fields nominated by that Vary field value match
> those fields in the original request

> If (after any normalization that might take place) a header field is absent
> from a request, it can only match another request if it is also absent there.

> A stored response with a Vary header field value containing a member "*"
> always fails to match.

> Some resources mistakenly omit the Vary header field from their default
> response […] with the effect of choosing it for subsequent requests to that
> resource even when more preferable responses are available.

That last paragraph is the exact failure mode of a negotiated URL that forgets
`Vary` on *one* branch: the forgetful branch becomes the one everyone gets.

### 1b. What browsers actually send (the `*/*` hazard, measured)

The WHATWG Fetch Standard, in HTTP-network-or-cache fetch:

> If request's header list does not contain `Accept`, then:
>   Let value be `*/*`.
>   If request's initiator is "prefetch", then set value to the document
>   `Accept` header value.
>   Otherwise, the user agent should set value to the first matching statement,
>   if any, switching on request's destination:
>     "document" / "frame" / "iframe" → the document `Accept` header value
>     "image" → `image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5`
>     "json" → `application/json,*/*;q=0.5`
>     "style" → `text/css,*/*;q=0.1`
>     "text" → `text/plain,*/*;q=0.5`
>   Append (`Accept`, value) to request's header list.

and

> The document `Accept` header value is
> `text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`.

(`https://fetch.spec.whatwg.org/`.) A bare `fetch(url)` has destination `""`,
which matches none of the cases, so it sends `Accept: */*`. **A navigation sends
`text/html,…`; a `fetch()` sends `*/*`.** Any split must therefore be written as
"is `text/html` explicitly requested?" and not "is JSON explicitly requested?".

### 1c. CORS preflight — not a hazard

The brief lists CORS preflight as a concrete hazard. It is not, for `Accept`.
Fetch's *CORS-safelisted request-header* algorithm:

> If value's length is greater than 128, then return false.
> Byte-lowercase name and switch on the result:
>   `accept` → If value contains a CORS-unsafe request-header byte, then return
>   false.

`application/json` contains no unsafe byte and is far under 128 characters, so a
cross-origin `fetch(url, {headers: {Accept: "application/json"}})` is a simple
request and triggers **no preflight**. (Same source.) `Content-Type` is the
header that would have forced a preflight, and a GET has none.

### 1d. Who shipped it, and who walked away

**Mastodon — shipped, in production, today.** `app/controllers/accounts_controller.rb`
on `main` (`raw.githubusercontent.com/mastodon/mastodon/main/…`) is a
three-format `respond_to` on one URL:

```ruby
vary_by -> { public_fetch_mode? ? 'Accept, Accept-Language, Cookie' : 'Accept, Accept-Language, Cookie, Signature' }
before_action :require_account_signature!, if: -> { request.format == :json && authorized_fetch_mode? }

def show
  respond_to do |format|
    format.html { expires_in(15.seconds, public: true, …) unless user_signed_in? }
    format.rss  { expires_in 1.minute, public: true … }
    format.json { render_with_cache json: @account, content_type: 'application/activity+json', … }
  end
end
```

Three things in that snippet are the whole lesson of this section:
the `Vary` is hand-maintained and includes `Cookie`; the cache lifetime differs
per representation (15 s vs 60 s vs 3 min); and **the JSON representation has a
different authentication requirement than the HTML one** — HTTP Signatures, not
a session cookie.

**[probed 2026-08-09]** `curl -sI -H 'Accept: …' https://mastodon.social/@Gargron`:

| Request `Accept` | Response `Content-Type` | `Vary` | `Cache-Control` |
|---|---|---|---|
| `application/activity+json` | `application/activity+json` | `Accept, Accept-Language, Cookie, Origin` | `max-age=180, public` |
| `application/ld+json; profile="https://www.w3.org/ns/activitystreams"` | `application/activity+json` | — | — |
| `application/rss+xml` | `application/rss+xml` | `Accept, Accept-Language, Cookie, Origin` | — |
| `text/html,application/xhtml+xml,…` (browser) | `text/html` | `Accept, …, Accept-Encoding` | `max-age=15, public, stale-while-revalidate=30` |
| `*/*` (a bare `fetch()`) | **`text/html`** | `Accept, …` | `max-age=15, …` |
| `text/html,application/activity+json;q=0.9` | **`text/html`** | — | — |

The last two rows are the hazard in the field: an agent that forgets to set
`Accept` gets the human page, and an agent that lists HTML first gets HTML even
though it also asked for AS2.

The spec Mastodon implements, ActivityPub (W3C Recommendation), §3.2:

> Servers **MUST** present the ActivityStreams object representation in response
> to `application/ld+json; profile="https://www.w3.org/ns/activitystreams"`

> Servers **SHOULD** also present the ActivityStreams representation in response
> to `application/activity+json`

> Servers **MAY** implement other behavior for requests which do not comply with
> the above requirement. (For example, servers may implement additional legacy
> protocols, or **may use the same URI for both HTML and ActivityStreams
> representations of a resource**.)

(`https://www.w3.org/TR/activitypub/` §3.2, emphasis added.) Note that even the
spec that most depends on this pattern makes the same-URI part a MAY.

**GitHub — walked away for the public API, kept it for the private one.**
GitHub's documented REST API lives on `api.github.com` and is now versioned by a
*separate header*, not by `Accept`:

> You should use the `X-GitHub-Api-Version` header to specify an API version.
> Requests without the `X-GitHub-Api-Version` header will default to use the
> `2022-11-28` version.

(`https://docs.github.com/en/rest/about-the-rest-api/api-versions`; supported
versions listed there are `2026-03-10` and `2022-11-28`.)

But **[probed 2026-08-09]** `curl -H 'Accept: application/json' https://github.com/rails/rails`
returns `200 application/json` with a body beginning
`{"meta":{"title":"GitHub - rails/rails: Ruby on Rails"},"payload":{"codeViewRepoRoute":…`,
and `Vary: … Accept, X-Requested-With`. The same URL with `Accept: */*` returns
`text/html`. So GitHub's *web application* does exactly the split under
discussion — it is how their client does soft navigation — but that JSON is
undocumented, unversioned, and shaped like a React route's props rather than
like a resource. **That is the precise line this design has to sit on: a
negotiated JSON that is "the page's own data" is cheap and safe; a negotiated
JSON that is "the public API" acquires a deprecation policy the HTML does not
have.**

**Rails — the framework kept the block, removed the abstraction.** Rails 4.2
release notes, Removals (§5.1):

> `respond_with` and the class-level `respond_to` have been removed from Rails
> and moved to the `responders` gem (version 2.0).

(`https://guides.rubyonrails.org/4_2_release_notes.html`.) The *block* form
`respond_to do |format|` is still core Rails — it is what Mastodon uses above.
What was ejected was the higher-level "infer the whole response from the format"
magic. Read as evidence: negotiating is fine; letting a framework decide the
whole response shape from the negotiation is what got dropped.

**Stripe — never used `Accept` for this.** Versioning is a dedicated header:

> requests made with curl use your Stripe account's default API version […]
> unless you override it by setting the `Stripe-Version` header.

(`https://docs.stripe.com/api/versioning`.)

**Heroku — still versions by `Accept`, and it still works.**

> Clients must address requests to `api.heroku.com` using HTTPS and specify the
> `Accept: application/vnd.heroku+json; version=3` Accept header.

(`https://devcenter.heroku.com/articles/platform-api-reference`.) This is the
one large surviving production use of `Accept`-as-version. Note it is on a
dedicated API host; the dashboard is `dashboard.heroku.com`
(**[probed]** `200 text/html`).

**The HATEOAS/HAL/JSON-API lineage.** Roy Fielding's 2008 post is the origin
document:

> A REST API must not define fixed resource names or hierarchies (an obvious
> coupling of client and server).

> A REST API should never have "typed" resources that are significant to the
> client. […] The only types that are significant to a client are the current
> representation's media type and standardized relation names.

(`https://roy.gbiv.com/untangled/2008/rest-apis-must-be-hypertext-driven`.)
HAL never became a standard — `draft-kelly-json-hal` reached version 11
(2023-10-19) and its datatracker status line reads **"This Internet-Draft is no
longer active."** JSON:API did stabilise at v1.1 with media type
`application/vnd.api+json` and hard negotiation rules ("servers **MUST** respond
with `415 Unsupported Media Type`" / "**MUST** respond with a `406 Not
Acceptable`", `https://jsonapi.org/format/`), and is alive but niche.

**What the industry moved to instead.** Description documents on a separate
host, not negotiation: OpenAPI 3.2.0 (published 19 September 2025,
`https://spec.openapis.org/oas/latest.html`), whose stated purpose is a
"standard, language-agnostic interface to HTTP APIs which allows both humans and
computers to discover and understand the capabilities of the service without
access to source code, documentation, or through network traffic inspection" —
and GraphQL, where Railway went (§3).

I could **not** find a first-party statement from any of these vendors saying
*why* they moved. The available evidence is circumstantial but consistent: the
thing that changed was not the HTTP but the ownership — an API host can be
versioned, deprecated and rate-limited on its own schedule, and a dashboard URL
cannot. I am flagging this as unverified rather than asserting the reason.

### 1e. Intermediaries that ignore `Vary`

Cloudflare's documented behaviour (`https://developers.cloudflare.com/cache/concepts/vary/`):
`Vary` is respected when the listed headers are configured in Cache Rules with a
`normalize` / `passthrough` / `bypass` action, plus the built-in cases
(`Vary: Accept-Encoding`, and Vary for Images). A response with **`Vary: *`
always bypasses cache**. Configurable Vary-on-`Accept` for Cache Rules is recent
— changelog entry "Cache multiple versions of a URL with Vary", 2026-07-02.
Fastly states it "supports it per spec"
(`https://www.fastly.com/documentation/reference/http/http-headers/Vary/`).

Practical reading: on a CDN that does not honour `Vary: Accept` by default, a
negotiated public URL will serve whichever representation was cached first. On a
`no-store`, cookie-gated URL, this is a non-issue — which is the situation
`/_xray` and an authenticated dashboard are in.

---

## 2. How agents actually read web application state in 2026

The single most decision-relevant fact in this whole document is a content-type
constraint, not a convention.

**Anthropic's `web_fetch` server tool** documents an error code
`unsupported_content_type`, defined as:

> Content type not supported (only text, HTML, and PDF)

and a note:

> The web fetch tool currently does not support websites dynamically rendered
> with JavaScript.

(`https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool`.)
Two consequences. First, **the hosted agent fetch path is documented as
HTML-capable and is not documented as `application/json`-capable** — whether
`application/json` counts as "text" there is not stated, and I could not verify
it either way without an API key. Second, an agent reading a Next.js dashboard
sees only server-rendered HTML; anything the page fills in client-side (which,
in `Cockpit.tsx:88-97`, is the account, the app list and the worker list) is
invisible to it. That argues *for* a server-rendered representation and against
assuming JSON is the agent-friendly branch.

**`llms.txt`** — a proposal, not a standard: "a proposal to standardise on using
an `/llms.txt` file to provide information to help LLMs use a website at
inference time", authored by Jeremy Howard, 3 September 2024
(`https://llmstxt.org/`). Publication is now near-universal among exactly the
vendors in §3. **[probed 2026-08-09]**, `curl -sIL`:

| URL | Status | Bytes |
|---|---|---|
| `docs.anthropic.com/llms.txt` | 200 | 57,406 |
| `platform.openai.com/llms.txt` | **404** | — |
| `developers.cloudflare.com/llms.txt` | 200 | 15,714 |
| `docs.stripe.com/llms.txt` | 200 | 93,191 |
| `vercel.com/llms.txt` | 200 | 207,679 |
| `fly.io/llms.txt` | 200 | 37,743 |
| `docs.railway.com/llms.txt` | 200 | 70,145 |
| `devcenter.heroku.com/llms.txt` | 200 | 11,338 |
| `docs.netlify.com/llms.txt` | 200 | 24,634 |

Eight of nine publish it. **I found no primary source from any model provider
stating that its agents fetch `/llms.txt`.** llmstxt.org itself makes no such
claim. Treat publication rates as evidence of vendor hedging, not of
consumption. Also aspirational: **[probed]** `/.well-known/mcp.json` on
vercel.com and developers.cloudflare.com, and `/.well-known/agent.json` on
fly.io, all 404.

**Model Context Protocol resources** — real, specified, and deliberately *not*
the web. Resources are URI-identified and read over JSON-RPC
(`resources/list`, `resources/read`), and the spec is explicit that they are
"**application-driven**, with host applications determining how to incorporate
context". On HTTP URIs it says:

> Servers **SHOULD** use this scheme only when the client is able to fetch and
> load the resource directly from the web on its own — that is, it doesn't need
> to read the resource via the MCP server.

(`https://modelcontextprotocol.io/specification/2025-06-18/server/resources`.)
Read carefully, that clause *endorses* the plan of record here: if a Supersonic
URL is directly fetchable by an agent, MCP's own spec says don't proxy it
through an MCP server. Not building MCP yet costs less than it looks.

**OpenAPI** — 3.2.0, 19 September 2025. Real and consumed by tooling, and both
Netlify ("You can browse the OpenAPI reference for the Netlify API",
`https://docs.netlify.com/api/get-started/`) and Fly publish one — **[probed]**
`https://docs.machines.dev/swagger/doc.json` returns `200 application/json`,
`openapi: 3.0.1`, title `Machines API 1.0`. This describes an API; it does not
make a page readable.

**JSON-LD / schema.org** — the only item on this list with documented
industrial-scale consumption. Google:

> mark up your site's pages using one of three supported formats: JSON-LD
> (recommended), Microdata, RDFa

(`https://developers.google.com/search/docs/appearance/structured-data/sd-policies`.)
Scale, from Web Data Commons' Common Crawl extraction (October 2024 crawl):
1,245,622,627 URLs carrying structured data across 16,525,070 domains,
73,993,669,093 triples; JSON-LD growing fastest, microdata past its 2018–19
peak, "Microformat hCard is used by a steady number of websites while the growth
of RDFa markup format has stopped" (`https://webdatacommons.org/structureddata/`).
Consumption is by *search engines*, for *rich results* — I found no primary
source showing an LLM agent parsing JSON-LD from a page to drive an action.
schema.org has no vocabulary for "an app's build failed", so this would mean
inventing types nobody consumes.

**Microformats / microdata** — declining (above). Aspirational for this purpose.

**RSS/Atom** — the sleeper. It is the one machine format that *already* travels
by content negotiation on the same URL in production: Mastodon's
`format.rss` branch, **[probed]** `Accept: application/rss+xml` →
`application/rss+xml` (§1d). For a timeline-shaped object, Atom is a
standardised, agent-legible, cache-friendly encoding of exactly "what happened",
and it costs one more `respond_to` branch.

**Newer conventions** — the only standards-track work I could verify is IETF
**AIPREF**, chartered to "standardize building blocks that allow for the
expression of preferences about how content is collected and processed for
Artificial Intelligence (AI) model development, deployment, and use", producing
`draft-ietf-aipref-vocab` and `draft-ietf-aipref-attach`, both targeted at IESG
by 31 August 2026 (`https://datatracker.ietf.org/wg/aipref/about/`). That is
about *permission*, not about *state*. There is no standards-track convention
for "here is my application's current state, machine-readably" as of this date.

**Blunt summary.** For a non-MCP agent-readable dashboard in 2026 the honest
options are: (a) clean server-rendered HTML, which is what agent fetch tools are
documented to read; (b) JSON on the same URL, which works today but rests on
nothing standard beyond RFC 9110; (c) Atom/RSS for the timeline, which is
standard, negotiable, and boring. `llms.txt`, JSON-LD-for-app-state, and
`.well-known` agent manifests are aspirational.

---

## 3. How the incumbents structure "application state"

Every one of the six puts the API on a different host from the dashboard. No
exceptions found.

| | Dashboard | API | Shape | One state object? |
|---|---|---|---|---|
| Vercel | `vercel.com/<team>/<project>` | `api.vercel.com` | REST | **Nearly.** `GET /v9/projects/{idOrName}` returns `latestDeployments`, `targets`, `env`, `alias` and project config in one call |
| Netlify | `app.netlify.com` | `api.netlify.com/api/v1/` | REST + OpenAPI | No |
| Fly.io | `fly.io/dashboard` | `api.machines.dev/v1` | REST + OpenAPI 3.0.1 | No — but see below |
| Railway | `railway.com` | `backboard.railway.com/graphql/v2` | GraphQL | Caller-defined |
| Cloudflare | `dash.cloudflare.com` | `api.cloudflare.com/client/v4` | REST, enveloped | No |
| Heroku | `dashboard.heroku.com` | `api.heroku.com` | REST + JSON Hyper-Schema | No |

Sources: `https://vercel.com/docs/rest-api/reference/endpoints/projects/find-a-project-by-id-or-name`;
`https://docs.netlify.com/api/get-started/` ("All URLs start with
`https://api.netlify.com/api/v1/`. SSL only."); `https://docs.machines.dev/`
("All requests are made against: https://api.machines.dev/v1");
`https://docs.railway.com/reference/public-api`;
`https://devcenter.heroku.com/articles/platform-api-reference`.
Hosts and envelopes **[probed 2026-08-09]**: `api.vercel.com/v2/user` → `403
application/json`; `api.cloudflare.com/client/v4/user` →
`{"success":false,"errors":[…],"messages":[],"result":null}`;
`dashboard.heroku.com/` → `200 text/html`.

**Nobody negotiates content on a dashboard URL.** I could not find a single
vendor doc describing this, and the dashboards are behind auth so it is not
directly probeable. Treat "no incumbent does this" as *not disproven* rather
than proven.

**Railway is the closest thing to the bet, done a different way.** Its docs say
plainly:

> The Railway public API is built with GraphQL and is the same API that powers
> the Railway dashboard.

(`https://docs.railway.com/reference/public-api`.) One representation, two
consumers — achieved by making the human UI a *client* of the machine API, not
by making one URL answer twice. That is the alternative architecture to weigh
against the `Accept` split, and it is the one with a shipped precedent.

**Fly.io — the interesting bit is not the API, it is the CLI and the embedded
events.** From the Machines API OpenAPI document **[probed]**, the `App` object
is thin — `id, internal_numeric_id, machine_count, name, network, organization,
status, volume_count` — so there is no fat app-state object. But the `Machine`
object embeds its own history:

```
Machine: checks[], config, cordoned, created_at, events[], host_status,
         id, image_ref, instance_id, lease, name, private_ip, region,
         state, updated_at
MachineEvent: id, request, source, status, timestamp, type
```

**State and timeline arrive in the same object.** That is direct prior art for
"one object carries both what is true now and what happened" — and note the
timeline is a bounded array *inside* the state, not a separate paginated
resource. Separately, `fly status` "Show the application's current status
including application details, tasks, most recent deployment details and in
which regions it is currently allocated" and takes a `--json` flag
(`https://fly.io/docs/flyctl/status/`) — the same object, two renderings, split
on a flag instead of a header.

**Heroku is genuinely hypermedia-ish, and it is worth copying the cheap part.**
**[probed]** `curl -H 'Accept: application/vnd.heroku+json; version=3'
https://api.heroku.com/schema` returns, unauthenticated, a 100-definition
document declaring `"$schema": "http://interagent.github.io/interagent-hyper-schema"`,
in which every resource carries its own link set — for `app`:

```
POST   /apps                        rel=create    "Create"
DELETE /apps/{id}                   rel=destroy   "Delete"
GET    /apps/{id}                   rel=self      "Info"
GET    /apps                        rel=instances "List"
PATCH  /apps/{id}                   rel=update    "Update"
POST   /apps/{id}/acm               rel=update    "Enable ACM"
…
```

The docs confirm the intent: "The API has a machine-readable JSON schema that
describes what resources are available via the API, what their URLs are, how
they are represented and what operations they support." The Heroku docs never
use the word HATEOAS and I found no first-party claim that the API is
hypermedia-driven — the schema is a *description*, fetched once, not links
embedded in each response. Worth knowing before copying: this is
schema-at-a-known-URL, which is much cheaper than true hypermedia and delivers
most of the agent benefit.

---

## 4. Timeline-as-primary-screen prior art

Every product that puts a feed first adds something back. The pattern is the
finding.

**Vercel.** Deployments are a list, but the project's landing view is not it:
"On your **Project Overview** page, you can see the latest production
deployment, including the generated URL and commit details, and deployment logs
for debugging", while "From the **Deployments** section in the sidebar" you
redeploy, inspect, assign a custom domain, promote to production
(`https://vercel.com/docs/deployments`). **Current state gets its own screen
above the feed.**

**Sentry.** Sentry does not show a raw event stream at all; it groups:

> We group similar events into issues based on a fingerprint. This grouping of
> events into issues allows you to see how frequently a problem is happening and
> how many users it's affecting.

and adds tabs for state ("All Unresolved", "For Review", "Regressed",
"Archived", "Escalating") plus persisted queries — "save your issue queries and
access them later by clicking the 'Saved Searches' button"
(`https://docs.sentry.io/product/issues/`). **The compensations are: an identity
for recurring events (fingerprint), a lifecycle state per group, and saved
views.**

**Linear.** Shipped a fix to its own activity feed on 2025-04-03: the problem
was "When there's a lot of activity in an issue, it's easy to lose track of
important changes", and the fix — "We now group similar consecutive events and
collapse older activity between comment threads"
(`https://linear.app/changelog/2025-04-03-collapsed-issue-history`).
**A product built around fast, dense records had to collapse its own timeline.**

**Stripe.** The event log is explicitly *not* the record of truth: "You can
access events through the Retrieve Event API for 30 days"
(`https://docs.stripe.com/api/events`). Objects are the record; events are a
notification stream with a retention window.

**GitHub Actions.** Same shape: "the artifacts and log files generated by
workflows are retained for 90 days before they are automatically deleted",
configurable 1–90 days (public repos) or 1–400 days (private)
(`https://docs.github.com/…/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization`).

**Datadog.** The Events Explorer is one component among six — the docs list
"Ingest events", "Triage Inbox", "Pipelines and Processors", "Events Explorer",
"Using events", "Correlation", with Correlation existing to "reduce alert
fatigue and the number of tickets/notifications you receive"
(`https://docs.datadoghq.com/service_management/events/`).

### Where the timeline breaks down

Five questions a chronological feed answers badly, each with the compensation
the market converged on:

1. **"What is true right now?"** — a feed answers with the *last* event, which
   is wrong whenever the last event failed and the previous state survived.
   → *Compensation: a status header or overview screen (Vercel, `fly status`).*
2. **"Is this the same problem as yesterday?"** — chronology has no identity.
   → *Compensation: grouping by fingerprint, with per-group lifecycle (Sentry).*
3. **"What has never happened?"** — a domain never configured, a token never
   created, a limit never hit produce no events, so they are invisible.
   → *Compensation: this is the settings-index problem; see §5.*
4. **"Show me only what matters."** — density defeats the feed at scale.
   → *Compensation: collapse/grouping (Linear), filters and saved searches
   (Sentry), correlation (Datadog).*
5. **"What happened three months ago?"** — retention is finite everywhere
   (Stripe 30 days, Actions 90 days).
   → *Compensation: the durable record is the object, not the feed.*

---

## 5. Settings without a settings page

The most considered account I found is a vendor HIG, and it argues **both**
halves and lands on a split. Apple's Human Interface Guidelines, "Settings"
(fetched via `developer.apple.com/tutorials/data/design/human-interface-guidelines/settings.json`;
the HTML page is JS-rendered and yields no text):

For inline:

> If you need to offer settings that affect only a specific task, you can
> provide these options within the task itself, so people don't have to leave
> the experience to customize it.

> **When possible, prefer letting people modify task-specific options without
> going to your settings area.** For example, if people can adjust things like
> showing or hiding parts of the current view, reordering a collection of items,
> or filtering a list, make these options available in the screens they affect,
> where they're discoverable and convenient. Putting this type of option in a
> separate settings area disconnects it from its context, requiring people to
> suspend their task to make adjustments, and often hiding the results until
> people resume the task.

> **Minimize the number of settings you offer.** Although people appreciate
> having control over an app or game, too many settings can make the experience
> feel less approachable, while also making it hard to find a particular
> setting.

For keeping one:

> **Put general, infrequently changed settings in your custom settings area.**
> People must suspend what they're doing to open an app's or game's settings
> area, so you want to include options that people don't need to change all the
> time.

> **Make settings available in ways people expect.** For example, when a
> physical keyboard is connected, people often use the standard Command-Comma
> (,) keyboard shortcut to open an app's settings […]

> People rely on a stable settings interface to help them find what they need.

That is the whole trade-off, from the party with the most usage data, and its
answer is a **partition by frequency-of-change**, not an abolition.

**The measured cost of hiding navigation.** Nielsen Norman Group, Pernice &
Budiu, 26 June 2016, 179 participants across 6 sites on smartphone and desktop:
content discoverability with hidden navigation was more than 20% lower than
visible or combo navigation; perceived task difficulty rose 21% (2.6 vs 2.1 on a
7-point scale); desktop users were "at least 39% slower", mobile users 15%
slower (`https://www.nngroup.com/articles/hamburger-menus/`). This is about nav,
not settings specifically, but it is the closest thing to a *measurement* of the
discoverability cost of removing an index. NN/g's complex-application guidance
(Kate Kaplan, 8 November 2020) recommends staged disclosure — showing advanced
settings "only when relevant to the current task" — under the heading "Reduce
Clutter Without Reducing Capability"
(`https://www.nngroup.com/articles/complex-application-design/`).

**What the incumbents actually do — a settings index with search and deep
links.** Vercel's environment variables live at a settings URL and the docs
deep-link to it: "Select **Environment Variables** in the sidebar" linking to
`/[team]/[project]/settings/environment-variables`, with "You can search for an
existing Environment Variable by name using the search input and/or filter by
Environment"
(`https://vercel.com/docs/environment-variables/managing-environment-variables`).
Two of the brief's listed losses are visible in that one paragraph: **support
instructions need a deep link**, and **finding a setting needs a search box over
an index**.

**What is genuinely lost without a settings index**, stated plainly:

- **Settings never yet touched are invisible.** Nothing surfaces a setting whose
  default has never been changed and that no event references. This is §4's
  failure #3 in a different costume.
- **"Where do I change X" has no answer.** There is no page to search. Vercel
  needed a search box *within* its settings list.
- **Support and docs lose their deep link.** "Go to Settings → Domains" is a
  sentence a human can follow and an agent can encode; "wait for a certificate
  event and click the thing beside it" is not.
- **Auditability.** "Show me everything configured on this app" has no surface.
- **Accessibility and convention.** The HIG's "Make settings available in ways
  people expect" and "People rely on a stable settings interface" are exactly
  the predictability that inline-only discards.

**I could not find a published, considered account of shipping a product with no
settings index at all.** Linear, Notion, Figma and Slack all ship both inline
controls and a settings index; I found no first-party writing from any of them
defending the absence of one, because none of them has that absence. Treat the
"no settings page" idea as **unattested in the primary literature** — not
refuted, but nobody has written down having tried it.

---

## 6. What this means for Supersonic specifically

### 6a. The `/_xray` split generalises — with three fixes

The existing split is at `services/proxy/src/index.ts:86-98`:

```ts
if ((req.url ?? "/") === "/_xray") {
  const viewer = await readVisitor(req);
  if (viewer && viewer.userId === app.owner_id) {
    if (/text\/html/i.test(String(req.headers.accept ?? ""))) {
      return html(res, 200, xrayPage(slug));
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(xray(slug)));
```

Three things about this are already right, and worth stating because they are
the parts most implementations get wrong:

1. **The test is on `text/html`, not on JSON.** Per the Fetch Standard (§1b), a
   bare `fetch()` sends `Accept: */*`, and the panel's own poll at
   `services/proxy/src/xray-panel.ts:116` is exactly that
   (`fetch('/_xray',{credentials:'include'})`). Written the other way round —
   "if the client asks for JSON, send JSON" — that poll would have received the
   HTML page. The safe default (unknown ⇒ machine) is the one in the tree.
2. **Both renderings come from one function.** `xray(slug)`
   (`services/proxy/src/xray.ts:133`) is the single object; `xray-page.ts` and
   `xray-panel.ts` are frames over it, and `xray-panel.ts:1-14` records why —
   "Two copies would drift within a week, and the one that drifted would be the
   one nobody was looking at."
3. **The JSON branch is `no-store`.** RFC 9110 §12.5.5 explicitly allows eliding
   `Vary` "when reuse is already limited by cache response directives".

Three fixes before generalising:

- **The HTML branch has no cache headers at all.** `html()` at
  `services/proxy/src/index.ts:24-27` writes only `Content-Type`. An owner-only
  page with no `Cache-Control` and no `Vary` is exactly RFC 9111 §4.1's
  "resources [that] mistakenly omit the Vary header field from their default
  response". Give it `Cache-Control: private, no-store` and `Vary: Accept,
  Cookie`. Cheap, and it closes the one real correctness hole.
- **Send `Vary: Accept` on both branches anyway.** RFC 9110 §12.5.5 purpose (2):
  it tells *user agents* the response was negotiated. Mastodon does this and
  adds `Cookie` (§1d) — verified live.
- **Decide, and write down, whether the JSON is a contract.** GitHub's
  `github.com` JSON is the page's data; `api.github.com`'s JSON is an API with a
  version header and a deprecation policy (§1d). Today `Xray`
  (`services/proxy/src/xray.ts:122-130`) is the former. If a CLI or an agent is
  ever told to depend on it, it silently becomes the latter, and every field
  rename becomes a breaking change made by someone editing a panel. This is the
  strongest argument against generalising, and it is contractual, not technical.

On an **authenticated dashboard page** specifically, the split is *safer* than
on `/_xray`, not riskier: the page is cookie-gated and uncacheable by any shared
cache, so every §1a caching disadvantage and every §1e CDN hazard is already
priced in. The transferable warning from Mastodon is the auth one — its JSON
branch needs HTTP Signatures where its HTML branch needs a cookie. Supersonic
will hit the same fork the moment a CLI token or an agent token has to read the
dashboard: the browser carries a session, the agent carries a bearer token, and
`readVisitor` (`services/proxy/src/session.ts`, used at `index.ts:87`) resolves
only the first. **The `Accept` split does not create that problem, but it will
be the place it surfaces.**

Two Supersonic-specific notes:

- Per §2, Anthropic's `web_fetch` documents support for "only text, HTML, and
  PDF" and no JavaScript rendering. The dashboard's server render
  (`apps/web/app/apps/[slug]/page.tsx:56-93`) is therefore agent-legible today;
  the client-side fills in `Cockpit.tsx:88-97` are not. Whether that fetch path
  accepts `application/json` is **unverified**. That is an argument for the HTML
  rendering being genuinely good, not a fallback.
- Serving the timeline as Atom on the same URL is the one *standardised* piece
  of this design (§2), and Mastodon proves it composes with the HTML/JSON split
  in a single `respond_to`.

### 6b. One object kills a real, already-documented bug

`apps/web/app/api/apps/route.ts:24-28` is the argument, in the tree, in the
team's own words:

> The same three reads the server render does. This route is what the dashboard
> polls while something is building, and it replaces the whole list — so
> anything the first render has and this does not VANISHES from every row the
> moment a deploy starts. That is exactly what happened to the "deployed" line,
> which the server had and this route did not.

That is the two-code-paths failure, already paid for once. It is the same class
of failure as `xray-panel.ts:1-14`'s "two copies would drift within a week", and
the same class the `lane` retirement in `CONTEXT.md:113-119` exists to prevent —
"Two exported types share this name today […] Neither TypeScript nor Postgres
can catch the disagreement."

**But note which fix the route needs.** The bug is not "HTML and JSON disagree";
it is "the render and the poll build the same list twice". Railway's answer
(§3) — one API, the human UI is a client of it — fixes that directly and does
not require negotiation at all. The `Accept` split fixes it too, *provided the
HTML branch is rendered from the same object the JSON branch serialises*. If
the HTML render reaches past the object for anything (as `page.tsx:67-77` does
today, calling `describeService` only on the Cloud Run path), the bug is back
with a new coat. **The load-bearing commitment is "one object", not "one URL".**

### 6c. Where settings that no event produces can live

Supersonic already has both surfaces: a per-app Settings tab
(`Cockpit.tsx:31`, `Cockpit.tsx:289-293` → `SettingsSection`) and a global
settings page (`Cockpit.tsx:161` links to `/settings`,
`apps/web/app/settings/page.tsx`). The question is what happens to the first.

Apply the HIG's partition (§5) rather than the binary:

- **Task-specific, event-adjacent → inline, next to the event.** Secrets
  (`CONTEXT.md:86-88` — "The only thing that cannot be written in the code")
  belong beside the build that needed one. A failed certificate belongs beside
  the domain that failed. This is the HIG's "provide these options within the
  task itself".
- **General, infrequently changed → a settings surface.** Domains, billing,
  deleting an app, CLI tokens. These are the HIG's canonical case: "People must
  suspend what they're doing to open an app's […] settings area, so you want to
  include options that people don't need to change all the time." They also
  produce no event *until* they exist, which is §4 failure #3 — a domain never
  added generates nothing to sit beside. And deleting an app is not a setting at
  all; it is a destructive act that wants a stable, findable, deliberately
  awkward location.

Concretely, three placements that keep the "no settings page" spirit without
paying NN/g's 20%-discoverability tax:

1. **Keep the surface, drop the nav item.** The page-level deep-link machinery
   already exists — `Cockpit.tsx:100-103` reads `?tab=` and ignores unknown
   values. A stable, deep-linkable URL is what support instructions and agents
   need (§5, Vercel); a *sidebar entry* is not. That is the cheap 80%.
2. **Make the settings surface itself an item on the object.** If the app's one
   state object carries `domains`, `tokens`, `plan` and `secrets` as fields,
   then "what have I never configured" is answerable by a machine and
   renderable as a section — and the agent gets the audit view for free. This is
   the thing a timeline structurally cannot do.
3. **Do not put billing on the app page.** It is account-scoped, not app-scoped;
   `/settings` already exists for it and Heroku, Vercel and Netlify all separate
   team-level from project-level settings (§3 sources).

One vocabulary warning: `CONTEXT.md:86-88` lists "settings" among the words to
*avoid* (under **Secrets**), and `CONTEXT.md:84` retires "dashboard", "console"
and "panel" under **X-ray**. Whatever this surface is called in front of a
person, "Settings" is currently a word the glossary rules out — while
`Cockpit.tsx:31` and `Cockpit.tsx:161` both ship it. That inconsistency is
already in the tree and this design has to resolve it either way.

---

## 7. What I could not verify from a primary source

Stated explicitly, as asked:

- **Why the industry moved from `Accept`-negotiated APIs to separate API hosts.**
  I verified the *destinations* (GitHub, Stripe, Vercel, Netlify, Fly,
  Cloudflare, Railway all on separate hosts; Heroku still versioning by
  `Accept`) but found no first-party statement of the reason. My
  technical-vs-organisational reading in §1d is inference, not evidence.
- **Whether any incumbent negotiates content on a dashboard URL.** All six
  dashboards are behind auth, so this is not probeable, and no doc addresses it.
  "Nobody does this" is not disproven; it is untested.
- **Whether Anthropic's `web_fetch` accepts `application/json`.** The docs say
  "only text, HTML, and PDF" and do not say whether JSON counts as text. Testing
  needs an API key.
- **Whether any LLM agent consumes `/llms.txt`.** Eight of nine vendors publish
  one; no provider documents fetching one; llmstxt.org claims no adoption.
- **Whether any agent parses JSON-LD from a page to drive an action.** Google
  documents consuming it for search rich results. Nothing else was verifiable.
- **A published, considered account of shipping without a settings index.** Not
  found. Apple's HIG is the closest primary reasoning and it argues for a split,
  not an abolition (§5).
- **GNOME HIG and Material guidance on preferences.** Both URLs I tried 404'd;
  the Apple HIG and NN/g stand alone here rather than being corroborated by a
  second design system.
- **Linear's product docs on the activity feed.** `linear.app/docs/activity-and-comments`
  404s. The Linear claim in §4 rests on their changelog entry, which is
  first-party but brief.
- **GitHub's `github.com` JSON payload.** Observed live, undocumented by GitHub.
  It could change or disappear without notice; do not build on it, cite it only
  as evidence that the pattern is deployable.
