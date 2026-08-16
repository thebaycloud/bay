# How Railway, Render and Vercel actually shape their dashboards

Research date: 2026-08-10. All three dashboards are behind a login and this
investigation had no accounts on any of them. Nothing below is a description of
a screen someone looked at. Every claim is traced to a public primary source —
official documentation, official changelog entries, official design-system
pages, or the products' own published API schemas.

**What was verifiable.** Object models and URL nouns; the names of pages, tabs
and sidebar items where the docs write them as UI labels; the full list of
metrics each product collects and where the docs place them; deployment state
enums; log filter grammars; retention and plan gates; the exact copy of a
number of buttons, empty states and build-output lines that the docs quote
verbatim; both public design systems (Vercel's Geist, Railway's `/design`); the
Vercel deployment object's provenance fields, from Vercel's own OpenAPI schema.

**What was not verifiable.** Anything that exists only as pixels. All three doc
sets embed screenshots, and in the machine-readable versions of those docs the
images are reduced to `[image: ...]` placeholders or bare `<Image>` tags whose
alt text is generic ("Screenshot of Project Canvas"). So: the default landing
tab of a Render service, whether Railway's canvas tiles show a clickable
domain, the exact column set of Vercel's deployments list, and every empty-state
string not quoted in prose are all marked **not established** below rather than
guessed. Where a screenshot's *existence* proves a feature is placed somewhere,
that is flagged as such.

A note on sources: the `.md` suffix works on all three doc sites
(`docs.railway.com/services.md`, `render.com/docs/deploys.md`,
`vercel.com/docs/projects.md`) and returns the authored markdown, including UI
labels in their original emphasis markers. That is the substrate for most of
the verbatim strings below. Vercel additionally publishes its REST schema at
`vercel.com/docs/rest-api/reference/endpoints/deployments/get-a-deployment-by-id-or-url.md`,
which turned out to be the single richest provenance source in the whole study.

---

## The one-paragraph answer

All three organise around a **project that contains things that run**, all three
land you on a **list**, and all three make **logs and metrics separate
destinations** reached by clicking down through that list. They differ in what
the middle layer is: Railway makes it a spatial canvas of connected services,
Render makes it a flat service list with a chronological event timeline, Vercel
makes it a stack of immutable deployments each with its own URL. The running app
is, in all three, a link you click *out* to — never a thing the dashboard shows
you. On the two questions the reader cares about most: **per-path latency exists
only on Vercel, only at p75, and only on the paid Observability Plus tier**
([Vercel](https://vercel.com/docs/observability/observability-plus)); Render has
service-wide latency percentiles but no documented per-path latency, and Railway
states outright that it does not collect request latency at all
([Railway](https://docs.railway.com/observability/metrics)). **"Who is in the
app right now" does not exist on any of the three.** Railway ships a feature
literally called "Realtime Multiplayer Awareness" — it shows your *teammates'*
avatars on the dashboard canvas, not your app's users
([Railway changelog, 2024-12-06](https://railway.com/changelog/2024-12-06-multi-region-replicas)).
And the one product that puts controls on the running app — Vercel's Toolbar —
puts *authoring* controls there (comments, feature flags, draft mode, edit
mode), never operational ones: no traffic, no latency, no errors, no deploy
history ([Vercel](https://vercel.com/docs/vercel-toolbar)).

---

## 1. Railway

### 1a. The top-level object

Railway's own "The Basics" page enumerates the model in order, and it is a
four-level nesting: **Dashboard → Project → Service → Deployment**, with
**Environments** cutting across projects and **Volumes** hanging off services
([docs.railway.com/overview/the-basics](https://docs.railway.com/overview/the-basics)).
The definitions are terse and infrastructural:

- Project — "A collection of services under the same network."
- Service — "A target for a deployment source (e.g. Web Application)." Elsewhere:
  "A Railway service is a deployment target. Under the hood, services are
  containers deployed from an image."
  ([docs.railway.com/services](https://docs.railway.com/services))
- Deployment — "Built and deliverable unit of a service."

The URL noun is `project`. The docs link to `railway.com/dashboard` for the
project list; the project itself is reached from there
([docs.railway.com/projects](https://docs.railway.com/projects)). The
project-scoped URL shape beyond `/dashboard` is **not established** from public
docs.

### 1b. First screen

"Your main entrypoint to Railway where all your projects are shown **in the
order they were last opened**"
([the-basics](https://docs.railway.com/overview/the-basics)). Note the ordering
rule — recency of *your attention*, not deploy time, not alphabetical.

Opening a project lands you on the **project canvas**: "the default view for a
project. Within it, a user can manage services and environments or select a
service to view its configuration"
([projects](https://docs.railway.com/projects)). The quick-start is more
evocative and worth quoting because it states the product thesis directly:
"Whether you deploy your project through the dashboard with GitHub or locally
using the CLI, you'll ultimately arrive at your project canvas... This is your
_mission control_. Your project's infrastructure, environments, and deployments
are all controlled from here."
([quick-start](https://docs.railway.com/quick-start)).

So the first thing shown after opening a project is **a diagram of resources**,
not a status summary and not a log. Clicking a service tile opens a service
panel over the canvas.

### 1c. Navigation depth

Counting only documented paths:

- **Seeing the running app: 4+ clicks, and only after you opt in to the app
  having a URL at all.** Railway does not give a deployed service a public
  address by default. The documented path is: "1. Go to your service's
  **Settings** / 2. Find **Networking → Public Networking** / 3. Click
  **Generate Domain** to get a Railway-provided domain"
  ([public-networking](https://docs.railway.com/networking/public-networking)).
  Quick-start repeats it: "If applicable, generate a domain by clicking
  **Generate Domain** within the service settings panel." So: dashboard →
  project → service tile → Settings tab → Networking → Generate Domain → then
  click the domain. Whether the canvas tile subsequently renders that domain as
  a clickable link is **not established** from doc prose (a screenshot exists at
  `docs/quick-start/project_canvas_nextjs_c6bjbq.png` but its content cannot be
  read from the source).
- **Logs: 3 clicks (environment-wide) or 4 (per-deployment).** Railway
  documents three routes: "**Build/Deploy Panel** → Click on a deployment in the
  dashboard / **Log Explorer** → Click on the Observability tab in the top
  navigation / **CLI** → Run the `railway logs` command"
  ([observability/logs](https://docs.railway.com/observability/logs)). Log
  Explorer is dashboard → project → Observability. Per-deployment logs are
  dashboard → project → service → deployment.
- **Metrics: 4 clicks.** "Access a service's metrics by clicking on a service in
  the project canvas, and going to the 'Metrics' tab"
  ([observability/metrics](https://docs.railway.com/observability/metrics)).
- **Who deployed the current version: not established in the UI.** See §1f.

### 1d. The app detail screen

The service panel's tabs, as named in prose across the docs, are **Deployments**
("Service Deployments tab"), **Variables** ("Service Variables"), **Metrics**,
**Settings**, and — only when a volume is attached — **Backups**
([the-basics](https://docs.railway.com/overview/the-basics),
[services](https://docs.railway.com/services)). Inside an open deployment there
are further tabs: **Build Logs**
([logs](https://docs.railway.com/observability/logs)) and **Network**, whose
**DNS** view carries DNS query logs. The exact left-to-right order is
**not established**; the-basics lists them as Service Variables → Backups →
Service Metrics → Service Settings, which is a documentation ordering, not
necessarily the UI's.

Project settings is a separate destination reached from a `Settings` button "at
the top right of the project canvas", with tabs **General**, **Environments**,
**Members**, **Webhooks**, and **Danger**
([projects](https://docs.railway.com/projects),
[observability/webhooks](https://docs.railway.com/observability/webhooks)).

Deployment states are fully enumerated: `Initializing`, `Building`, `Deploying`,
`Failed`, `Active`, `Completed`, `Crashed`, `Removing`, `Removed`
([deployments/reference](https://docs.railway.com/deployments/reference)). The
per-deployment action menu is **View logs**, **Restart**, **Redeploy**,
**Rollback**, **Remove**, **Abort**.

### 1e. Observability placement

Two places, and they are different products.

**Per-service Metrics tab**: exactly four metrics, all resource-level — "**CPU**
– Processor usage / **Memory** – RAM consumption / **Disk Usage** – Storage
utilization / **Network** – Inbound and outbound traffic". Then, unambiguously:
"**Application-level metrics such as request latency, error rates, or business
KPIs are not collected by Railway.** To capture these, ship telemetry to a
third-party tool."
([observability/metrics](https://docs.railway.com/observability/metrics)).
Retention is 30 days per project. Graphs carry "dotted lines to indicate when
new deployments began... so users can see which commit may have caused a spike
in resources" — the one place deploy identity and behaviour share an axis. With
replicas there are **Sum** and **Replica** views; Sum is the default and is the
only one with public network traffic.

**Project-level Observability tab** in the top navigation: a build-your-own
widget dashboard. Empty state copy is quoted in the docs: on a new environment
you get "Start with a simple dashboard" or "Add new item", where the first
"auto-generates initial widgets with spend, service metrics, and logs". Widgets
are drawn from CPU Usage, Memory Usage, Network In/Out, Disk Usage, Logs, and
"Project Usage: report the spend of your project and track the overall resource
usage"
([observability](https://docs.railway.com/observability)). Monitors (Pro plan)
alert on CPU, RAM, disk and network egress — again, no application-level signal.

The interesting inversion is that Railway's *logs* know everything its *metrics*
don't. HTTP logs carry `@method`, `@path`, `@host`, `@httpStatus`,
`@responseTime` ("Time to first byte in milliseconds"), `@totalDuration`,
`@upstreamRqDuration`, `@txBytes`, `@rxBytes`, `@srcIp`, `@clientUa`,
`@edgeRegion`, with numeric comparison operators and ranges. The docs give
worked examples that are, functionally, per-path latency queries:
`@path:/api/v1/users AND @httpStatus:500`, `@responseTime:100..500`,
`@totalDuration:>5000 @httpStatus:>=500`
([observability/logs](https://docs.railway.com/observability/logs)). The data
is there; it is never aggregated into a percentile or a chart. Log retention is
7 days (Hobby/Trial), 30 (Pro), up to 90 (Enterprise), with a hard rate limit of
"500 log lines per second per replica across all plans".

### 1f. Provenance

Railway's data model knows who did it; the documented UI mostly doesn't say so.

The webhook payload is explicit
([observability/webhooks](https://docs.railway.com/observability/webhooks)):

```json
{ "type": "Deployment.failed",
  "details": { "id": "...", "source": "GitHub", "status": "SUCCESS",
               "branch": "...", "commitHash": "...",
               "commitAuthor": "...", "commitMessage": "..." }, ... }
```

`source` and `commitAuthor` are exactly a provenance pair. Whether either
renders in the deployment card is **not established**.

What *is* documented in the UI: a project **activity feed** — "shows all the
changes that have been made to a project. This includes changes to services and
volumes. You can click on a change to see everything that was committed"
([projects](https://docs.railway.com/projects)). Note this tracks
*configuration* changes, not deploy authorship.

Railway does distinguish one non-human actor in the UI, and it is itself:
"Occasionally, Railway will initiate a new deployment to migrate your service
from one host to another... These Railway-initiated deployments will display
with a banner above the Active deployment to clearly identify them"
([deployments/reference](https://docs.railway.com/deployments/reference)). That
is a documented platform-vs-you distinction, surfaced as a banner, for one case.

Railway also has a documented human-identity gate on deploys: if a GitHub repo
member has no linked Railway account, "Railway will then create a Deployment
Approval within a Service prompting a user to determine if they want to deploy
their commit or not", with an "Approve" button and a "Reject" item in the
three-dot menu ([services](https://docs.railway.com/services)).

### 1g. Empty and in-progress states

Documented verbatim: the Observability empty state ("Start with a simple
dashboard" / "Add new item"). The new-project flow: "Click **New Project**",
then "Choose either **Deploy Now** or **Add variables**", and "When you click
**Deploy Now**, Railway will create a new project for you and kick off an
initial deploy after the project is created. **Once the project is created you
will land on your Project Canvas**"
([quick-start](https://docs.railway.com/quick-start)). Under capacity pressure
on free/hobby tiers: "You'll see a '**Limited Access**' indicator in your
dashboard" and "New deployments will be queued rather than immediately
processed" ([deployments/reference](https://docs.railway.com/deployments/reference)).
Log throughput overflow prints into your own log stream: "Railway rate limit of
500 logs/sec reached for replica, update your application to reduce the logging
rate. Messages dropped: 50".

The copy for a brand-new project with nothing deployed is **not established**.

### 1h. Copywriting register — verbatim

`New` · `Empty Service` · `Connect Repo` · **Generate Domain** · **Deploy Now** ·
**Add Variables** · **Add a Service** · `Update Info` · "Approve" / "Reject" ·
`Restore` · `Edit schedule` · `Transfer Ownership` · `Transfer Project` ·
`Delete Project` · `Save Webhook` · `Test Webhook` · "Limited Access" ·
"Wipe Volume" · "Mount path" · "Volume Size" · "Start with a simple dashboard" ·
"Add new item"
(sources: [services](https://docs.railway.com/services),
[projects](https://docs.railway.com/projects),
[quick-start](https://docs.railway.com/quick-start),
[the-basics](https://docs.railway.com/overview/the-basics),
[observability](https://docs.railway.com/observability),
[public-networking](https://docs.railway.com/networking/public-networking)).

The register is **infrastructure, almost without exception**: service, replica,
container, image, volume, private network, ephemeral storage, outbound network
bandwidth, canvas, mount path. "Your app" appears in prose, never as a UI object.
The one plain-language flourish is documentation, not UI: "This is your _mission
control_."

### 1i. Visual language

Railway publishes a design system at
[railway.com/design](https://railway.com/design), covering Color, Type, Banner,
Button, Link, Forms, Accordion, Modals, Charts, Avatars, Spacing, Autocomplete,
and a Palette, with a "Toggle Theme" control. The colour page
([railway.com/design/color](https://railway.com/design/color)) exposes gray
50→950 plus pink, blue, cyan, green, yellow and red ramps on the same 50–950
convention, semantic tokens (`background`, `secondaryBg`, `foreground`), and —
tellingly for a product whose surface is largely a log viewer — a documented set
of ANSI terminal colours. Light and dark both exist. Which is *default* is
**not established** from the design site; Railway's own community feedback board
carries requests for a system-following theme option, which suggests the app
ships an explicit default rather than following the OS, but that is inference,
not a primary claim.

Density and border-radius specifics are **not established**. Two dated
changelog facts about the shell: the dashboard was redesigned on 2026-03-20 —
"The Railway dashboard has been redesigned to make navigation cleaner and more
intuitive", including "a nice sparkling new sidebar with some reconstituted
information architecture"
([railway.com/changelog/2026-03-20-new-dashboard-layout](https://railway.com/changelog/2026-03-20-new-dashboard-layout))
— and the canvas gained live teammate presence on 2024-12-06: "You'll now see
the other members of your team collaborating in a project with you", rendered as
collaborator avatars on the canvas
([railway.com/changelog/2024-12-06-multi-region-replicas](https://railway.com/changelog/2024-12-06-multi-region-replicas)).

---

## 2. Render

### 2a. The top-level object

Render's is the flattest model of the three, and the primary object is the
**service**. The dashboard "lists **the services in your workspace**, along with
any projects you've organized them into"
([render-dashboard](https://render.com/docs/render-dashboard)) — projects are
optional grouping applied to services, not containers services are born into.
Above that sits a **workspace**; below the optional project sits an
**environment**. Render is explicit that the environment carries no magic:
"Render does not apply special logic to any environment based on its name"
([projects](https://render.com/docs/projects)).

The URL host is `dashboard.render.com`. Confirmed sub-paths from docs links are
account-scoped (`/u/settings#appearance`, `/billing#included-usage`,
`/register`); the per-service URL noun is **not established** from public docs.

### 2b. First screen

After sign-in: the workspace homepage, "Your dashboard's main page lists the
services in your workspace, along with any projects you've organized them into.
Click any service to view its details, logs, and settings." Projects sit above
services: "Your workspace's homepage in the Render Dashboard lists all projects
at the top... Services belonging to a project appear on that project's page,
_not_ on your workspace's homepage"
([projects](https://render.com/docs/projects)).

**Which page a service opens on is not established.** The docs repeatedly send
you to the *Events* page for deploy-related work ("You can view the deploy's
progress from your service's *Events* page",
[web-services](https://render.com/docs/web-services)), which is suggestive but
not a statement about the default tab.

### 2c. Navigation depth

Render has the shortest documented path to the running app of the three, and it
is short for a structural reason: the URL exists automatically.

- **Seeing the running app: 2 clicks.** "Every Render web service and static
  site receives a unique `onrender.com` URL. You can find this URL on your
  service's page in the Render Dashboard"
  ([your-first-deploy](https://render.com/docs/your-first-deploy)). Workspace
  home → service → click URL. No opt-in step.
- **Logs: 2 clicks.** "View, search, and filter your service's runtime logs from
  its *Logs* page in the Render Dashboard"
  ([logging](https://render.com/docs/logging)). Per-deploy logs cost one more:
  "View the logs for an individual deploy of your service from the service's
  *Events* page. Click the word *Deploy* in a timeline entry to open the log
  explorer."
- **Metrics: 2 clicks.** "View any service's usage metrics from its *Metrics*
  page in the Render Dashboard"
  ([service-metrics](https://render.com/docs/service-metrics)).
- **Who deployed: 2 clicks to the Events timeline; whether it names a person is
  not established.** See §2f.

Cross-cutting: `⌘+K` / `CTRL+K` opens workspace-wide search, "then use the arrow
keys to jump directly to any resource", and breadcrumbs at the top of a resource
page switch "to a different service, environment, or project"
([render-dashboard](https://render.com/docs/render-dashboard),
[changelog 2024-12-09](https://render.com/changelog/enhanced-navigation-in-the-render-dashboard)).
So most depth is collapsible to one keystroke.

### 2d. The app detail screen

Render's docs consistently write these as **pages**, not tabs. Established page
names, each quoted as a UI label in the docs: ***Events***, ***Logs***,
***Metrics***, ***Settings***, ***Shell***, ***Jobs***, plus a ***Queries*** tab
on a database's Metrics page and an ***SSH*** tab in account settings
([deploys](https://render.com/docs/deploys),
[logging](https://render.com/docs/logging),
[service-metrics](https://render.com/docs/service-metrics),
[ssh](https://render.com/docs/ssh)). Their order is **not established**.

The **Events** page is the load-bearing one and is chronological rather than
tabular: "Auto-deploys appear in your service's *Events* timeline in the Render
Dashboard"; "When an auto-deploy is skipped, a corresponding entry appears on
your service's *Events* page"; cancelling a deploy means "Go to your service's
*Events* page and click the word *Deploy* in the corresponding event entry"
([deploys](https://render.com/docs/deploys)). The *Manual Deploy* dropdown lives
on that same page, with four options: ***Deploy latest commit***, ***Deploy a
specific commit***, ***Clear build cache & deploy***, ***Restart service***.
Auto-deploy modes are ***On Commit*** / ***After CI Checks Pass*** / ***Off***.

Render treats restart as a deploy, which is a real modelling choice: "On Render,
a service restart is actually a special form of manual deploy... Unlike other
deploys, the new instance always uses the exact same Git commit and
configuration as the running instance at the time of the restart."

### 2e. Observability placement

Two pages, *Metrics* and *Logs*, both per-service, plus event overlay between
them.

**Metrics** groups graphs into an ***Application Metrics*** section (CPU,
memory) and a ***Network Metrics*** section
([service-metrics](https://render.com/docs/service-metrics)). Web services get
two HTTP graphs:

- ***Total Requests*** — "shows your web service's HTTP request volume over your
  selected time range". Filterable by status code and groupable by status code
  on any plan. Then, gated: "Teams can filter the graph to include only requests
  that were sent to a particular host (i.e., domain) or **path**. Teams can group
  each bar in the graph by which host each request was sent to."
- ***Response Times*** — "shows your web service's response latency for common
  helpful percentiles (**p50, p75, p90, and p99**)", with a ***Percentile***
  dropdown. Requires Pro or higher.

This is the closest any of the three gets to plain HTTP latency without a paid
observability SKU on top — but note the asymmetry: **path filtering is
documented for the request-volume graph only.** Whether the path filter also
applies to Response Times is **not established**; the docs describe only the
Percentile dropdown for that graph. Also note the exclusion: "these graphs show
metrics only for requests from the public internet — they _don't_ include
requests over your private network."

Other metrics: *Disk Usage*, *Disk Activity*, *Disk Operations*; four outbound-
bandwidth categories (*HTTP Responses*, *WebSocket Responses*,
*Service-Initiated*, *Service-Initiated (Private Link)*) at a fixed one-point-
per-hour resolution with ~60 minutes of lag; and for Postgres, *Active
Connections*, *Network Activity*, *Transaction Volume*, *Replication Lag*,
*Lock-Delayed Queries*, plus *Running Processes* and *Top Queries* under the
*Queries* tab. Metrics retention is 7 / 14 / 30 days by plan.

**Logs**. The explorer's line format is documented field by field: *Level*
(eight values, `debug` through `emergency`, "Hidden for `info`-level lines until
you hover"), *Timestamp* ("in your local time zone"), *Instance* ("surrounded by
square brackets... Click this value to add it as a search filter"), *Message*.
Filters are `level`, `instance`, and — for HTTP request logs, Pro and above —
`method`, `status_code`, `host`, and `path` ("such as `/api/orders` or
`/blog/post/123`"). Wildcards and RE2 regex are supported, including the
documented example `/responseTimeMS=\d{3}\d+/` — "Returns request logs with a
response time greater than one second"
([logging](https://render.com/docs/logging)). Time range defaults to ***Last
hour***, with a ***Live tail*** option. Rate limit: 6,000 lines per minute per
instance. Retention 7 / 14 / 30 days.

The one genuine cross-stitch between deploys and behaviour: since 2025-07-21,
metrics graphs overlay service events — by default "service deploys and instance
failures", with a ***Filter events*** dropdown for more, and "Click any event in
a metrics graph to view more details about it"
([changelog](https://render.com/changelog/in-dashboard-metrics-now-display-service-events)).

Render also leaks a correlation identity into the app's own responses: every
HTTP request log carries a `requestID`, and "Render includes this same value in
the `Rndr-Id` HTTP header — both in the request to your web service _and_ in the
response to the requesting client", explicitly so you can "diagnose and debug
issues in collaboration with the users who encounter them"
([logging](https://render.com/docs/logging)). This is the only case in the three
products of platform identity being deliberately visible at the app's own edge —
though it is a header, not a surface.

### 2f. Provenance

**Weakest of the three.** Deploy trigger *methods* are documented in full
(Dashboard, CLI, Deploy hook, API, auto-deploy on commit), and the docs even
tabulate their side effects — "*Dashboard* → *Disables* auto-deploys; *Deploy
hook* → *Disables*; *CLI* → *Does not disable*; *API* → *Does not disable*"
([deploys](https://render.com/docs/deploys)). But whether the Events timeline
labels which of those triggered a given deploy, or names a person, is **not
established** from any public source.

The webhook payload does not help: the documented shape is
`{"type": "deploy_ended", ...}` with a service-event ID (`evt-`) and no user
field at all ([webhooks](https://render.com/docs/webhooks)). Notification emails
likewise describe events ("A service build or deploy fails", "A deploy
successfully goes live") rather than actors
([notifications](https://render.com/docs/notifications)). `render.com/docs/audit-log.md`
returns an empty document; audit metadata is referenced only obliquely, via a
changelog entry noting the addition of "metadata for source IP and user agent"
to shell events
([changelog](https://render.com/changelog/audit-log-updates-added-the-endshellevent-type-plus-metadata-for-source-ip-and-user-agent)).

Render does model actor *permissions* richly — ***Protected*** environments
where "Only *Admin* workspace members can perform the following actions",
covering deletes, creates, suspend/resume, maintenance mode, shell access, and
secret viewing ([projects](https://render.com/docs/projects)). It knows who is
allowed to act; it does not visibly record who did.

### 2g. Empty and in-progress states

The empty-project state is documented in prose: "If an environment in your
project is empty, it displays buttons for creating a new service or moving some
of your workspace's existing services into the project"
([projects](https://render.com/docs/projects)).

The in-progress and success states are quoted verbatim in the build output —
and are the most human strings in any of the three products:

```
==> Your service is live 🎉
==> Your site is live 🎉
```

with the surrounding doc text: "*If the deploy completes successfully,* the
deploy's status updates to ***Live*** and you'll see log lines like these"
([your-first-deploy](https://render.com/docs/your-first-deploy)). The full set
of deploy status labels beyond `Live` is **not established**.

### 2h. Copywriting register — verbatim

*+ New* · *Create a project* · *+ Add environment* · *All settings* · *Move* ·
*Manual Deploy* · *Deploy latest commit* · *Deploy a specific commit* ·
*Clear build cache & deploy* · *Restart service* · *Cancel deploy* ·
*On Commit* · *After CI Checks Pass* · *Off* · *Live* · *Live tail* ·
*Last hour* · *Filter events* · *Percentile* · *Block cross-environment
connections* · *Protected* · *High Contrast Mode* · "==> Your service is live 🎉"

The register is **infrastructure vocabulary with a plain-language safety net**.
Render is the only one of the three that ships a glossary appended to doc pages,
defining its own jargon in ordinary words: outbound bandwidth is "The amount of
network traffic you send to destinations outside of Render (HTTP responses,
third-party API calls, and so on)"; pipeline minutes is "The amount of time
Render spends running *build commands* and *pre-deploy commands* for your
services"; a private network means "Your Render services in the same *region*
can reach each other without traversing the public internet"
([render-dashboard](https://render.com/docs/render-dashboard),
[logging](https://render.com/docs/logging)). Instance types are named and
specced in the open — "*Free*: 512 MB RAM / 0.1 CPU", "*Starter*: 512 MB RAM /
0.5 CPU", "*Standard*: 2 GB RAM / 1 CPU"
([web-services](https://render.com/docs/web-services)). The words are
infra-words; the explanations are consistently plain.

### 2i. Visual language

Render has no public design system. What is documented is the theme model:
"The Render Dashboard provides light and dark display themes, along with
high-contrast variants of each", set via the account menu, with *Light*, *Dark*,
and *System* ("which follows your operating system's theme"), a *High Contrast
Mode* toggle, and — unusually — an independent theme for the log explorer: "You
can also customize the log explorer's theme independently from your main
dashboard theme"
([render-dashboard](https://render.com/docs/render-dashboard),
[logging](https://render.com/docs/logging)). Dark theme was added 2024-07-22
([changelog](https://render.com/changelog/added-dark-display-theme-to-the-render-dashboard)),
so light is the older and probably original default; the shipped default is
**not established**.

Avatars are documented and default to Gravatar with a monogram fallback: "By
default, Render uses the Gravatar image for your account's email address. If you
don't have a Gravatar image, Render sets a text monogram using the first letter
of your email address" — the same for workspaces. Density, typography, radius
and colour usage are **not established**.

---

## 3. Vercel

### 3a. The top-level object

**Project**, defined as an application, not a resource: "A project is the
application that you have deployed to Vercel." More precisely: "Projects on
Vercel represent applications that you have deployed to the platform from a
single Git repository. Each project can have multiple deployments: a single
production deployment and many pre-production deployments"
([docs/projects](https://vercel.com/docs/projects)).

Below it, the **deployment** is a first-class immutable artifact with its own
address: "A **deployment** on Vercel is the result of a successful build of your
project. Each time you deploy, Vercel generates a unique URL"
([docs/deployments](https://vercel.com/docs/deployments)). Above it sits the
**team**. Environments are three fixed named tiers — Local, Preview, Production
— rather than user-defined containers.

The URL structure is the most legible of the three, visible in the docs' own
deep links: `/[team]/[project]/deployments`, `/[team]/[project]/observability`,
`/[team]/[project]/analytics`, `/[team]/[project]/speed-insights`,
`/[team]/[project]/settings/environments`, plus the team-scoped
`/[team]/~/observability` and `/dashboard/activity`. Team and project are
siblings in the same path grammar, which is exactly what the Feb 2026 redesign
is built on (§3d).

### 3b. First screen

A project list, presented as cards. The oldest primary source is the clearest
about what those cards carry: you can "Search for a particular Project", "See
which change is currently available in Production for your Projects", "Easily
find the Project you're looking for by framework icon or favicon", and
"Navigate to Projects via the cards and hover to quickly visit Production on
desktop"
([changelog 2021-08-06](https://vercel.com/changelog/a-new-dashboard-overview-is-now-available)).
The same entry notes that the redesign "removed the header and activity stream"
— Vercel deliberately took the activity feed *off* the landing screen.

Project cards also carry live status dots: for Speed Insights, "If Speed
Insights is not enabled, then the circle will be gray... If Speed Insights is
enabled but no data points have been collected yet then it will show an empty
circle... If Speed Insights is enabled and data points have been collected then
the circle will be colored with a number inside"
([using-speed-insights](https://vercel.com/docs/speed-insights/using-speed-insights)).

Opening a project lands on **Project Overview**: "On your **Project Overview**
page, you can see the latest production deployment, including the generated URL
and commit details, and deployment logs for debugging"
([docs/deployments](https://vercel.com/docs/deployments)). So Vercel is the only
one of the three whose first in-project screen is documented as *the current
production version plus its URL* rather than a resource list or a diagram.

### 3c. Navigation depth

- **Seeing the running app: 1–2 clicks.** The card hover affordance ("hover to
  quickly visit Production") is one; otherwise dashboard → project → the
  generated URL on Project Overview is two. Vercel is the only one of the three
  with a documented shortcut to production from the *list* screen.
- **Logs: 2 clicks** (project → **Observability** / **Logs** in the sidebar).
  Build logs cost 4: "select the project and then **Deployments** in the
  sidebar / Select the deployment... In the **Deployment Details** section,
  expand the **Building** accordion to expand the logs"
  ([troubleshoot-a-build](https://vercel.com/docs/deployments/troubleshoot-a-build)).
- **Metrics: 2 clicks** (project → **Observability**, or → **Analytics**, or →
  **Speed Insights** — three different destinations, see §3e).
- **Who deployed: 2 clicks**, to Deployments, where rows carry branch and
  commit. See §3f.

### 3d. The app detail screen

Vercel's project navigation is a **sidebar**, not tabs — and this is recent and
dated. On 2026-01-22 an opt-in beta shipped that "Moved horizontal tabs to a
resizable sidebar that can be hidden when not needed", with "Unified sidebar
navigation with consistent links across team and project levels", "Reordered
navigation items to prioritize the most common developer workflows", the ability
to "Switch between team and project versions of the same page in one click", and
"New mobile navigation featuring a floating bottom bar optimized for one-handed
use"
([changelog](https://vercel.com/changelog/new-dashboard-navigation-available)).
It became the default on 2026-02-26
([changelog](https://vercel.com/changelog/dashboard-navigation-redesign-rollout)).

Sidebar items confirmed by name in docs prose or deep links: **Deployments**,
**Observability**, **Analytics**, **Speed Insights**, **Settings**, **Resources**
(within a deployment), and **Logs**. The complete list and its order are **not
established**; the changelog entries describe the restructuring without
enumerating items.

Within a deployment, the documented sections and tabs are: **Deployment Status**,
**Deployment Details** (containing a **Building** accordion), **Deployment
Summary**, a **Source** tab ("the output of the build after the deployment is
successful. This can also be accessed by appending `/_src` to the Deployment
URL"), and a **Resources** tab listing **Middleware**, **Static Assets** and
**Functions**, where "You can use the three dot (…) menu for a given function to
jump to that function in **Logs**, **Analytics**, **Speed Insights**, or the
**Observability** section in the sidebar"
([docs/deployments](https://vercel.com/docs/deployments),
[troubleshoot-a-build](https://vercel.com/docs/deployments/troubleshoot-a-build)).
That cross-jump — from a build artifact straight into four different
observability surfaces — is the densest wiring between deploy and behaviour of
anything in this study.

Deployment states, from Vercel's own OpenAPI schema (`readyState` enum):
`BLOCKED`, `BUILDING`, `CANCELED`, `ERROR`, `INITIALIZING`, `QUEUED`, `READY`
([REST API reference](https://vercel.com/docs/rest-api/reference/endpoints/deployments/get-a-deployment-by-id-or-url)).
Deployments list filters are **Branch**, **Date Range**, **All Environments**,
**Status** ([managing-deployments](https://vercel.com/docs/deployments/managing-deployments)).
The list was redesigned 2026-05-27 with "Environments are now grouped with
statuses, and the updated layout makes branches and commits easier to scan"
([changelog](https://vercel.com/changelog/redesigned-deployments-list)).

### 3e. Observability placement

Vercel splits observability across **three separate products**, all reachable
from the project sidebar, and this split is the most consequential structural
fact about the product.

**Observability** — server-side, framework-aware, tab-per-subsystem. Sections:
**Vercel Functions**, **External APIs**, **Edge Requests**, **Middleware**,
**Fast Data Transfer**, **Image Optimization**, **ISR**, **Blob**, **Build
Diagnostics**, **AI Gateway**, **Queues**, **External Rewrites**,
**Microfrontends**, **Sandbox**
([observability/insights](https://vercel.com/docs/observability/insights)). The
documented investigation loop is worth quoting because it is a per-path latency
workflow: "Let's investigate our graphs in more detail, for example, **Error
Rate**. Click and drag to select a period of time and press the **Zoom In**
button. Then, from the list of routes below, choose to reorder either based on
the error rate or the duration to get an idea of which routes are causing the
most issues... The functions view will show you the performance of each route or
function, including details about the function, latency, paths, and External
APIs. **Note that Latency and breakdown by path are only available for
Observability Plus users.** The function view also provides a direct link to the
logs for that function"
([docs/observability](https://vercel.com/docs/observability)).

The paywall is precise. On free Observability: "No Latency (p75) data, no
breakdown by path". On Observability Plus: "Latency data, sort by p75, breakdown
by path and routes". Edge Requests and Fast Data Transfer likewise go from "No
breakdown by path" to "Full request data". Retention goes from 12 hours (Hobby)
/ 1 day (Pro) / 3 days (Enterprise) to 30 days; runtime logs from 1 hour (Hobby)
to 30 days. Plus is metered at "$1.20 per 1 million events", where an event is
an edge request, function invocation, external API request, middleware
invocation or AI Gateway request — so a single user request can bill as six
([observability-plus](https://vercel.com/docs/observability/observability-plus),
[docs/observability](https://vercel.com/docs/observability)).

**Speed Insights** — client-side real-user Core Web Vitals, with genuine
per-path breakdown: "From the URL view, select the corresponding tab to view by
the **Route** (the actual pages you built), or by **Path** (the URLs requested by
the visitor)", plus a **Selectors** view attributing INP/FID/CLS/LCP to
individual HTML elements, and a **Countries** map
([using-speed-insights](https://vercel.com/docs/speed-insights/using-speed-insights)).

**Web Analytics** — traffic, with panels for **Pages**, **Route**, **Hostname**,
**Referrers**, **UTM Parameters**, **Country**, **Browsers**, **Devices**,
**Operating System**, a timeframe dropdown, an environment dropdown defaulting
to Production, and **Export as CSV** (capped at 250 entries)
([using-web-analytics](https://vercel.com/docs/analytics/using-web-analytics)).
Vercel announced analytics as real-time in
[this changelog](https://vercel.com/changelog/real-time-vercel-analytics), but
the documented UI is timeframe-scoped throughout; there is no documented "N
visitors right now" counter.

The consequence: to answer "is my app healthy and who is using it", a Vercel
user visits three sidebar destinations with three different data models, three
different retention policies and two different billing meters.

### 3f. Provenance

**Richest data model by a wide margin, and the only one where an agent/bot
origin is a modelled concept.** From the deployment object schema:

- `creator` — "Information about the deployment creator", required `uid`, with
  `username` — "The username of the user that created the deployment".
- `source` — "Where was the deployment created from", enum:
  `api-trigger-git-deploy`, `cli`, `clone/repo`, `drop`, `git`,
  `git-deploy-hook`, `import`, `import/repo`, `redeploy`, `v0-web`. Note the
  schema's own caveat: "Best-effort guess for metrics only — not authoritative;
  do not gate behavior on it."
- `platform` — "Metadata about the source platform that triggered the
  deployment. Allows us to map a deployment back to a platform (e.g. **the chat
  that created it**)", with `source.name` ("The external platform that created
  the deployment"), `origin` ("Reference back to the entity on the platform that
  initiated the deployment"), `creator.name` ("**The user on the external
  platform who triggered the deployment**"), and free-form `meta`.
- `attribution` — "Attribution metadata for the deployment, linking commit
  author to git and Vercel users. **Only populated when the
  `enable-deployment-attribution` flag is enabled.**" Sub-objects `commitMeta`,
  `gitUser` (git provider user resolved from commit author email), `vercelUser`
  (Vercel user linked to that git account).

(all from the
[deployment schema](https://vercel.com/docs/rest-api/reference/endpoints/deployments/get-a-deployment-by-id-or-url))

That is a four-way human / CLI / CI / external-agent distinction with a slot for
"which chat made this". Two caveats, both important: `attribution` is
flag-gated, and **nothing in Vercel's documentation shows any of this rendered
in the deployments list**. The 2019 redesign blog says project pages carry "Git
commit information (author, branch, repository details)" and that preview
deployments can be "filtered by each member"
([blog](https://vercel.com/blog/dashboard-redesign)), which establishes commit
authorship on screen — but the current list's columns are **not established**.

Separately, Vercel has a team-level **Activity Log** at `/dashboard/activity`,
which "provides a list of all events on a team, chronologically organized since
its creation", including "User(s) involved with the event / Type of event
performed / Type of account / Time of the event"
([activity-log](https://vercel.com/docs/activity-log)). It has hundreds of
event types, and the modern ones are explicitly agent-aware:
`agentic-provisioning-team-created` ("A new Vercel team was created via agentic
provisioning"), `agentic-provisioning-account-linked`,
`agentic-provisioning-credentials-rotated`, `ai-code-review`,
`ai-alert-investigation`. Deploy events exist too: `deployment` ("A deployment
was created for a project"), `deployment-creation-blocked` ("A deployment was
blocked because **the Git user is not part of the team**"),
`deployment-policy-blocked`. But this is a *team* log, at a *team* URL, listing
account-administration events — not a per-app deploy history with a `who`
column.

### 3g. Empty and in-progress states

Documented verbatim: Web Analytics before any data — "If no data has been
collected yet then you will see an **Awaiting Data** popup"
([using-web-analytics](https://vercel.com/docs/analytics/using-web-analytics)).
Build failures without logs get an overlay rather than an accordion: "you cannot
access the **Building** accordion described above, and instead, Vercel will
present an overlay that contains the error message". Build in-progress state is
the **Building** accordion inside **Deployment Details**, and "The total build
duration is shown on the Vercel Dashboard and includes all three steps:
building, checking, and assigning domains. Each step also shows the individual
duration"
([troubleshoot-a-build](https://vercel.com/docs/deployments/troubleshoot-a-build)).
The brand-new-project-with-nothing-deployed state is **not established**.

### 3h. Copywriting register — verbatim

**Deployments** · **Observability** · **Analytics** · **Speed Insights** ·
**Resources** · **Redeploy** · **Redeploy to Production** · **Use existing Build
Cache** · **Promote to Production** · **Inspect** · **Delete** ·
**Deployment Summary** · **Deployment Details** · **Building** · **Source** ·
**Zoom In** · **View all** · **Export as CSV** · **Awaiting Data** ·
**Disable Web Analytics** · **Exclude Project from Plus** · **Always Activate** ·
**Copy Link**

Register is **split by altitude**. The top of the product is
plain and product-shaped: Project, Deployment, Analytics, Speed Insights,
Promote to Production. The observability layer underneath is the most
proprietary-jargon-dense surface in the entire study — Edge Requests, Fast Data
Transfer, ISR, Middleware, Fluid vs standard function type, `performance_xl`
memory type, In-function Concurrency, Microfrontends. Neither Railway nor Render
asks a user to learn a vocabulary that specific to one vendor.

### 3i. Visual language

Vercel is the only one of the three with a fully public, documented design
system. **Geist** is "Vercel's design system for building consistent web
experiences", covering Colors ("A high-contrast, accessible palette"),
Typography, Materials ("presets for radii, fills, strokes, and shadows"), and
Grid — described as "a core part of the Vercel aesthetic"
([vercel.com/geist/introduction](https://vercel.com/geist/introduction)).

Colour: 10 scales — `backgrounds`, `gray`, `gray-alpha`, `blue`, `red`, `amber`,
`green`, `teal`, `purple`, `pink` — each non-background scale having "10 steps,
from `100` through `1000`", with steps mapped semantically: 100–300 component
backgrounds (default/hover/active), 400–600 borders (default/hover/active),
700–800 high-contrast backgrounds, 900–1000 text and icons. The `backgrounds`
scale has only two values, for page and component. "P3 colors are used on
supported browsers and displays"
([vercel.com/geist/colors](https://vercel.com/geist/colors)). Note what this
implies: hue is not reserved for status. Blue/red/amber/green/teal/purple/pink
all share the identical 10-step structural grammar as gray, so colour is a
component-state system first and a status system second.

Typography: **Geist Sans** and **Geist Mono**, Vercel's own typefaces, built
"starting with a monospace version prioritizing readability, then expanding to
Sans", embodying "simplicity, minimalism, and speed", drawing on Swiss design
and emphasising "precision, clarity, and functionality"
([vercel.com/font](https://vercel.com/font)). A mono-first origin for a
design system's type is unusual and shows in the product's density.

Theme: system-following by default with an explicit override — "Dark mode will
now automatically be enabled depending on your system settings. To overwrite it,
use the Theme switcher accessible from your avatar menu"
([blog changelog, April 2020](https://vercel.com/blog/changelog-april-2020)).
Geist ships a documented **Theme Switcher** component with Light/System/Dark
([vercel.com/geist/theme-switcher](https://vercel.com/geist/theme-switcher)).

---

## 4. Comparison

### 4a. Side by side

| | **Railway** | **Render** | **Vercel** |
|---|---|---|---|
| **Top-level object** | Project (a network of services); service is a "deployment target" | Service (projects are optional grouping applied to services) | Project (= "the application you have deployed"); deployment is a first-class artifact |
| **URL noun** | `/dashboard`, `project` | `dashboard.render.com`, per-service path not established | `/[team]/[project]/{deployments,observability,analytics,speed-insights,settings}` |
| **First screen after sign-in** | Project list, ordered by last opened | Workspace home: projects at top, services below | Project cards with framework icon/favicon and status dots |
| **First screen inside the app** | **Project canvas** — a spatial diagram of services and volumes | Service page (default tab not established; Events is the documented workhorse) | **Project Overview** — latest production deployment, its generated URL, commit details, deploy logs |
| **Per-app nav shape** | Tabs in a panel over the canvas | Pages, reached from a left pane + breadcrumbs | Sidebar (converted from horizontal tabs, Feb 2026) |
| **Where metrics live** | Per-service **Metrics** tab (CPU/Mem/Disk/Net only) + project-level **Observability** widget dashboard | Per-service **Metrics** page: *Application Metrics* + *Network Metrics* sections | Three separate sidebar products: **Observability**, **Speed Insights**, **Analytics** |
| **Request latency** | **None collected.** Only queryable as log fields | **p50/p75/p90/p99** *Response Times* graph, service-wide, Pro+ | **p75**, per-path/per-route, **Observability Plus only** ($1.20/1M events) |
| **Per-path breakdown** | Log filter `@path:` only | Request *volume* by path (Teams); latency by path not established | Yes — routes and paths, Plus only |
| **Provenance shown** | Partial: commit author in webhook payload; "Railway-initiated" banner; project activity feed for config changes. Deploy authorship in UI **not established** | **Not established** — no user field in webhooks, no documented actor on the Events timeline | Richest model (`creator.username`, `source` enum incl. `cli`/`drop`/`v0-web`, `platform.creator.name`, flag-gated `attribution`) but **UI rendering not established**; commit author on project pages documented since 2019 |
| **Human / CI / bot distinction** | `source: "GitHub"` in webhook only | No | Yes, in the API: `source` enum + `platform` object ("the chat that created it") |
| **App gets a URL automatically** | **No** — you must click **Generate Domain** | **Yes** — every web service gets an `onrender.com` URL | **Yes** — every deployment generates a unique URL |
| **Register** | Infrastructure, near-pure (service, replica, container, volume, egress) | Infrastructure words + a plain-language glossary attached to every doc page | Plain at the top (Project, Deployment, Promote to Production); intensely vendor-specific below (Edge Requests, Fast Data Transfer, ISR, Fluid) |
| **Public design system** | Yes — [railway.com/design](https://railway.com/design) | No | Yes — [Geist](https://vercel.com/geist/introduction), incl. own typefaces |
| **Theme** | Light + dark; default not established | Light/Dark/System + high-contrast; separate theme for log explorer | System-following default, override in avatar menu |

### 4b. What all three do the same way — the genuine convention

1. **Sign-in lands on a list of things you own, never on a thing.** All three.
   No product opens on a running app, a status summary, or the most recent
   event.
2. **At least three levels above the process.** Workspace/team → project →
   service/deployment → the thing itself. Even Render, the flattest, has
   workspace → service → page.
3. **Logs and metrics are separate destinations, and both are separate from
   deploys.** Railway: Metrics tab vs Observability tab vs deployment panel.
   Render: *Metrics* page vs *Logs* page vs *Events* page. Vercel: Observability
   vs Analytics vs Speed Insights vs Deployments. Nobody puts them on one screen.
4. **The git commit is the deploy's identity.** All three key the deploy record
   to branch + commit hash + commit message, and all three offer "deploy a
   specific commit" and rollback against that record.
5. **Destructive and re-run actions live in a `…` menu on a row.** Railway's
   three-dot menu (Reject, Delete backup), Render's `•••` (Move, All settings),
   Vercel's ellipsis (Redeploy, Delete). Identical idiom.
6. **`⌘K` is the escape hatch from the hierarchy.** Explicit in Render
   ("Open workspace-wide search with `⌘+K` / `CTRL+K`, then use the arrow keys
   to jump directly to any resource") and Railway ("the **command palette**,
   accessible via `CMD + K`"), and present in Vercel's toolbar as **Search**
   ("Quickly search the toolbar and access dashboard pages"). All three ship a
   keyboard bypass for a navigation depth they built themselves.
7. **Light and dark, with dark arriving later.** Vercel 2020, Render 2024,
   Railway both. All three treat theme as a user account setting.
8. **Resource metrics are free; application metrics are paid or absent.** CPU
   and memory are universally free. Latency percentiles are Pro+ on Render,
   Plus-only on Vercel, and nonexistent on Railway.

### 4c. Where they diverge, and what the divergence bets on

**Railway bets that the user's mental model is a system of connected parts.**
The canvas is the product. Services join a private network automatically; the
docs call the project "a capsule for composing infrastructure"; teammates'
avatars appear live on the canvas. The tell is **Generate Domain**: on Railway a
deployed web service has *no public address* until you decide it should. That
only makes sense if the default expected object is a component in a system —
a database, a worker, a queue — for which a public URL would be wrong.
Railway is optimising for the multi-service backend.

**Render bets that the user's mental model is "my service, and what happened to
it."** The service list is flat and the primary artifact is a chronological
*Events* timeline that mixes deploys, skipped deploys, instance failures,
restarts and scaling in one column — and, since July 2025, overlays those same
events onto the metrics graphs. Render is the only one that folded "restart" into
"deploy" as a formal special case. The bet is that operators think in time, not
in topology or in versions.

**Vercel bets that the unit of thought is a version of the site, not a running
machine.** Every commit gets a durable URL; production is a pointer you
*promote* to; rollback is instant because the old artifact still exists and still
serves. Nothing in Vercel's model corresponds to "the box your app is on".
Consequently its observability is framework-shaped (Functions, Middleware, ISR,
Edge Requests) rather than machine-shaped (CPU, memory, disk) — Vercel is the
only one of the three that does not show you CPU and memory graphs for your app
at all, because in its model there is no persistent thing to graph.

A second-order divergence follows from the first: **how far provenance travels.**
Railway's is trapped in webhook payloads; Render's barely exists; Vercel's is a
full schema with an external-agent slot — but is flag-gated and undocumented in
the UI. All three built more provenance than they show.

### 4d. What NONE of them do

This is the section with the most signal, so each item is stated as a specific
absence with the evidence for the absence.

1. **None of them shows you the running app.** Not embedded, not previewed, not
   screenshotted, not iframed. Every documented path to "see your app" is a link
   that navigates *away* from the dashboard to a different origin. The closest
   anything gets is a hover affordance on a Vercel project card ("hover to
   quickly visit Production on desktop") — still a link out.
2. **None of them shows who is using the app right now.** No live-visitor count,
   no concurrent-session number, no "someone is on /checkout" signal anywhere in
   any of the three doc sets. Vercel's Web Analytics is the only real-user data
   in the group and every documented view of it is scoped by a timeframe
   dropdown. Railway ships "Realtime Multiplayer Awareness", and it shows *your
   teammates* on the dashboard canvas — the presence primitive exists in the
   product, aimed at the wrong population.
3. **None of them has a durable, first-class `who` column on the deploy list
   that distinguishes human from CI from bot from platform.** Vercel has the
   fields (`creator`, `source` enum with `cli`/`drop`/`redeploy`/`v0-web`,
   `platform.creator.name` for "the user on the external platform who triggered
   the deployment") but they are API-only and `attribution` is behind
   `enable-deployment-attribution`. Railway has `source` and `commitAuthor` in
   webhooks only. Render's webhook payload has no user field at all. The one
   documented *rendered* distinction in the entire study is Railway's
   platform-initiated banner: "These Railway-initiated deployments will display
   with a banner above the Active deployment to clearly identify them" — a
   single actor type, one case, one banner.
4. **None of them gives per-path latency without paying.** Railway: not
   collected, at any price — "Application-level metrics such as request latency,
   error rates, or business KPIs are not collected by Railway." Render: latency
   percentiles require Pro; path filtering is documented for request *volume*
   only, and only for Teams. Vercel: per-path p75 requires Observability Plus at
   $1.20/1M events, where one browser request can generate up to six billable
   events.
5. **None of them puts operational controls or telemetry on the running app's
   own origin.** Vercel's Toolbar is the only in-app surface in the group, and
   its documented feature list is entirely authoring and collaboration:
   Comments, Feature Flags, Draft Mode, Edit Mode, Layout Shift, Interaction
   Timing, Accessibility Audit, Open Graph inspection, plus navigation links
   *back to* the dashboard. It carries no traffic data, no error rate, no
   latency for anyone but the current session ("Inspect in detail each
   interaction's latency and view **your current session's** INP"), and no
   deploy history. It is "enabled by default for all preview deployments" and
   requires an explicit package install for production. The only other case of
   platform identity reaching the app's edge is Render's `Rndr-Id` response
   header — a correlation ID, not a surface.
6. **None of them has a shareable, per-app status URL for someone without a
   dashboard account.** Railway comes closest and it is project-scoped and
   read-only: a project can be made public, where "Viewers don't need a Railway
   account to see the project / Environment variables are private from viewers /
   Services and Deployment logs are public" — pitched in the docs at educators
   showing students, not at operating a product.
7. **None of them treats deploy history and app behaviour as one screen.** The
   single exception is partial and one-directional: Render overlays deploy and
   instance-failure events onto metrics graphs, and Railway draws dotted
   deploy-boundary lines on its metrics graphs "so users can see which commit may
   have caused a spike in resources". In both cases deploys annotate metrics;
   metrics never annotate deploys, and neither view carries a person.
8. **None of them has an empty state that shows anything about the app.** Every
   documented empty state is a creation affordance or a data-pending notice:
   Render's "buttons for creating a new service or moving some of your
   workspace's existing services", Railway's "Start with a simple dashboard" /
   "Add new item", Vercel's "**Awaiting Data**".
9. **None of them surfaces error rate per path for free.** Vercel documents an
   **Error Rate** graph with a route list you can reorder by error rate — the
   only per-route error-rate view in the group — but "breakdown by path" is a
   Plus feature. Render can group the *Total Requests* graph by status code
   (free) but by path only for Teams. Railway collects no error rate.

---

## 5. Direct answers to the three questions asked

**How many screens does each put between the user and their actually-running
app?**

- **Vercel: 1–2.** Dashboard card hover → Production, or dashboard → project →
  the generated URL on Project Overview. The URL is automatic and is on the
  first in-project screen.
- **Render: 2.** Workspace home → service page → the `onrender.com` URL. The URL
  is automatic.
- **Railway: 4+, plus a prior configuration step.** Dashboard → project canvas →
  service tile → Settings → Networking → **Generate Domain** — and only then is
  there an address at all. Whether the canvas subsequently exposes it in one
  click is not established.

In no case does any of those screens *contain* the app; they contain a link.

**Does any of them surface live per-path latency, or "who is using this right
now"?**

Per-path latency: **Vercel only**, at p75, on Observability Plus, for Functions
/ Edge Requests / Fast Data Transfer / External Rewrites; plus client-side Core
Web Vitals per Route and per Path in Speed Insights. Render has service-wide
p50/p75/p90/p99 (Pro+) and documented path filtering only for request volume
(Teams). Railway has none, by explicit policy, though its HTTP logs carry
`@path` and `@responseTime` with range operators.

"Who is using this right now": **no**, on all three. Not as a count, not as a
list, not as a live indicator. Railway has live presence for teammates on the
dashboard canvas; nobody has it for app users.

**Does any of them treat the running app itself as a place where controls live?**

**Only Vercel, and only for authoring.** The Vercel Toolbar injects into preview
deployments by default and into production by explicit install, and its entire
documented control set is comments, feature-flag overrides, draft mode, edit
mode, accessibility audit, layout-shift detection, interaction timing for the
current session, Open Graph preview, share-link generation, and navigation links
back to the dashboard. No operational reading, no deploy history, no traffic.
Railway and Render have nothing in the app at all; Render's `Rndr-Id` header is
the sole trace of the platform in the app's own responses.

---

## 6. Explicitly not established

Listed so the reader does not mistake absence of a claim for absence of a
feature:

- Railway: default theme; project canvas tile contents; whether the canvas shows
  a clickable domain; brand-new-project empty state copy; service-panel tab
  order; the project-scoped URL shape.
- Render: which page a service opens on by default; the full ordered list of
  service pages; whether the *Events* timeline names an actor; whether path
  filtering applies to the *Response Times* graph; deploy status labels other
  than *Live*; the shipped default theme; typography, density, radius; the
  per-service URL path.
- Vercel: the complete ordered project sidebar; the deployments-list column set
  and whether it renders `creator` / `source` / `platform`; whether
  `enable-deployment-attribution` is on for normal accounts; the empty state for
  a project with no deployments.
- All three: any claim about visual density, spacing, or card treatment that
  would require reading a screenshot.

---

## 7. Source index

**Railway** — [the-basics](https://docs.railway.com/overview/the-basics) ·
[projects](https://docs.railway.com/projects) ·
[services](https://docs.railway.com/services) ·
[deployments/reference](https://docs.railway.com/deployments/reference) ·
[observability](https://docs.railway.com/observability) ·
[observability/logs](https://docs.railway.com/observability/logs) ·
[observability/metrics](https://docs.railway.com/observability/metrics) ·
[observability/webhooks](https://docs.railway.com/observability/webhooks) ·
[quick-start](https://docs.railway.com/quick-start) ·
[networking/public-networking](https://docs.railway.com/networking/public-networking) ·
[changelog: new dashboard layout](https://railway.com/changelog/2026-03-20-new-dashboard-layout) ·
[changelog: multiplayer awareness](https://railway.com/changelog/2024-12-06-multi-region-replicas) ·
[design system](https://railway.com/design) · [colors](https://railway.com/design/color)

**Render** — [render-dashboard](https://render.com/docs/render-dashboard) ·
[projects](https://render.com/docs/projects) ·
[deploys](https://render.com/docs/deploys) ·
[logging](https://render.com/docs/logging) ·
[service-metrics](https://render.com/docs/service-metrics) ·
[web-services](https://render.com/docs/web-services) ·
[your-first-deploy](https://render.com/docs/your-first-deploy) ·
[webhooks](https://render.com/docs/webhooks) ·
[notifications](https://render.com/docs/notifications) ·
[changelog: enhanced navigation](https://render.com/changelog/enhanced-navigation-in-the-render-dashboard) ·
[changelog: events on metrics](https://render.com/changelog/in-dashboard-metrics-now-display-service-events) ·
[changelog: log explorer + HTTP logs](https://render.com/changelog/log-explorer-http-logs) ·
[changelog: dark theme](https://render.com/changelog/added-dark-display-theme-to-the-render-dashboard)

**Vercel** — [projects](https://vercel.com/docs/projects) ·
[deployments](https://vercel.com/docs/deployments) ·
[managing-deployments](https://vercel.com/docs/deployments/managing-deployments) ·
[troubleshoot-a-build](https://vercel.com/docs/deployments/troubleshoot-a-build) ·
[observability](https://vercel.com/docs/observability) ·
[observability/insights](https://vercel.com/docs/observability/insights) ·
[observability-plus](https://vercel.com/docs/observability/observability-plus) ·
[using-speed-insights](https://vercel.com/docs/speed-insights/using-speed-insights) ·
[using-web-analytics](https://vercel.com/docs/analytics/using-web-analytics) ·
[activity-log](https://vercel.com/docs/activity-log) ·
[vercel-toolbar](https://vercel.com/docs/vercel-toolbar) ·
[toolbar in production](https://vercel.com/docs/vercel-toolbar/in-production-and-localhost) ·
[deployment REST schema](https://vercel.com/docs/rest-api/reference/endpoints/deployments/get-a-deployment-by-id-or-url) ·
[changelog: nav redesign default](https://vercel.com/changelog/dashboard-navigation-redesign-rollout) ·
[changelog: new nav available](https://vercel.com/changelog/new-dashboard-navigation-available) ·
[changelog: dashboard overview](https://vercel.com/changelog/a-new-dashboard-overview-is-now-available) ·
[changelog: redesigned deployments list](https://vercel.com/changelog/redesigned-deployments-list) ·
[blog: dashboard redesign](https://vercel.com/blog/dashboard-redesign) ·
[changelog April 2020 (dark mode)](https://vercel.com/blog/changelog-april-2020) ·
[Geist](https://vercel.com/geist/introduction) ·
[Geist colors](https://vercel.com/geist/colors) ·
[Geist font](https://vercel.com/font)
