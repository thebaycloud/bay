# Supersonic → Bay: the full rename, and what it actually costs

Written 23 Aug 2026. A plan and an estimate, not a change: nothing below has
been done.

**Goal as stated:** the product becomes **Bay**, the domain becomes
**thebay.cloud**, and the word *supersonic* appears nowhere in the project.

That goal is achievable in the code and in front of a person. It is **not**
fully achievable in Google Cloud without building a new project from scratch,
and that single fact is the difference between a week and a month. It is the
first decision below.

---

## What was measured

Counted 23 Aug, not estimated:

| | |
|---|---|
| Occurrences of `supersonic` in the repo | **2259**, across **374 files** |
| `supersonic.cv` specifically | 447, across 145 files |
| `x-supersonic-*` headers | **21 distinct**, 226 occurrences |
| `SUPERSONIC_*` env vars | **20 distinct**, 244 occurrences |
| `supersonic-deploy-prod` (GCP project id) | 210 |
| `supersonic_platform` (database) | 92 |
| npm packages | `supersonic-cli` (**published**, v0.10.0 live, v0.12.1 in repo) + 7 private `@supersonic/*` |

And the number that changes everything:

| | |
|---|---|
| Apps on the platform | **3** (all live) |
| Users | **19** |
| Workspaces | **13** |
| Attached domains | **1** |

**A rebrand is cheap now and expensive later.** At 3 apps there is no migration
problem worth the name — the entire installed base fits in one message. At 3000
apps this plan is a quarter's work with a compatibility window measured in
months. The best time to do this is this week.

---

## Decision 1 — the Google Cloud project. Yours, and it is the big one.

**A GCP project id can never be renamed.** `supersonic-deploy-prod` is
permanent. Only its display name changes. The same is true of the Cloud SQL
instances (`supersonic-platform-pg`, `supersonic-shared-pg`) and of every Cloud
Run service name (`supersonic-control-plane`, `supersonic-deploy-worker`,
`supersonic-proxy`, `supersonic-landing`, `supersonic-static`,
`supersonic-shot`, `supersonic-umami`) and the job — none of those can be
renamed in place. Nor can the service accounts, the buckets
(`supersonic-static-assets`, `supersonic-db-backups`) or the Artifact Registry
paths.

Two ways out, and they differ by an order of magnitude.

**Option A — keep the project, rename what can be renamed.**
`supersonic-deploy-prod` survives as a string in `gcloud` commands, in
`cloudbuild.yaml`, in image URLs and in nobody's browser. Cloud Run services get
new `bay-*` names by being created fresh beside the old ones and having traffic
moved — that part is genuinely easy. The SQL instances keep their names, or get
replaced later at leisure.

Cost: the plan below, about **six focused days** plus an unattended soak.
Residue: `supersonic` remains in infrastructure identifiers no customer or
employee ever reads.

**Option B — a new project, `thebaycloud-prod`, and migrate.** Everything moves:
two Cloud SQL instances with their data, four Compute instances (three fleet
nodes and buildkit), the load balancer, the wildcard certificate, 28 secrets,
seven service accounts with their IAM, four buckets, four Artifact Registry
repositories, and every image. Billing, quotas and API enablement start from
zero. Fleet nodes have identity enforcement (`NODE_IDENTITY=enforce`) tied to
the service account, so they need re-provisioning rather than moving.

Cost: **five to eight days on top**, and it is the only part of this whole
rename that can take production down. Residue: none.

**Recommendation: A.** The word is invisible where it would remain, and B spends
a week of risk on something no one will ever see. If B is wanted anyway, do it
as a separate project months later, when the platform is a rebuilt-from-scratch
exercise rather than a live migration — it is not the same task as a rebrand and
should not be scheduled as one.

---

## Decision 2 — what happens to `supersonic.cv`

Three apps live at `<slug>.supersonic.cv` today, and `supersonic-cli` is
published on npm with `https://app.supersonic.cv` compiled into it. Whatever is
decided, **both domains must answer at once for a while** — the question is only
how long.

- **Redirect forever** (recommended). `supersonic.cv` 301s to `thebay.cloud`,
  keeps its certificate, costs a few dollars a year. Nothing anyone ever
  bookmarked breaks.
- **Redirect for 90 days, then drop it.** Cheaper by a rounding error; risks the
  one link somebody put in a deck.

Either way the old domain is not switched off on cutover day.

## Decision 3 — the CLI's new name

`supersonic-cli` is on npm at v0.10.0. It cannot be renamed; a new name is
published and the old one deprecated with a pointer. Pick one:

- `@thebaycloud/cli` — matches `bay deploy`, short, and `bay` is the command people type
- `@thebaycloud/cli` — scoped, unmistakably yours, but `npm i -g @thebaycloud/cli`
  is a mouthful

Installed copies keep working against `app.supersonic.cv` until their owner
upgrades, which is why the old domain has to keep answering.

---

## The order, and why it is this order

The whole plan rests on one idea: **make the name a variable before changing
it.** Half of that is already true — `ROOT_DOMAIN` exists as an env var in
`lib/app-urls.ts`, `lib/cors.ts`, `lib/umami.ts` and `services/proxy/src/config.ts`,
each defaulting to `supersonic.cv`. Only `lib/domains.ts:22` holds it as a hard
constant. Finishing that is a day's work and it makes every later step
reversible by an env var rather than by a deploy.

### Phase 1 — the name becomes configuration (0.5 day)

One constant for the domain, one for the product name, both read from env with
today's values as defaults. `lib/domains.ts:22` stops being a literal. Nothing
changes behaviour; every test still passes; `ROOT_DOMAIN=thebay.cloud` becomes a
thing you can set locally and see.

**Done when** `ROOT_DOMAIN=thebay.cloud npm run dev` renders Bay URLs
everywhere and the suite is green with both values.

### Phase 2 — thebay.cloud answers, beside the old one (1 day, mostly waiting)

`thebay.cloud` is registered and parked at Namecheap (`dns1.registrar-servers.com`).
It needs: an A record at the load balancer, a wildcard `*.thebay.cloud`
certificate in Certificate Manager beside the existing `supersonic-wildcard`,
and the proxy taught to accept both roots — `services/proxy/src/config.ts` takes
one `rootDomain` today and needs a list.

Certificate issuance is unattended but not instant; start this phase first so it
provisions while Phase 3 is being written.

**Done when** `https://l3sgp.thebay.cloud` and `https://l3sgp.supersonic.cv`
both serve the same app.

#### Two things found while building Phase 2 that the plan above did not know

**The session cookie is scoped to `.supersonic.cv`.** `COOKIE_DOMAIN=.supersonic.cv`
on the live control plane, and a cookie cannot be set for two domains. So while
both roots answer, they are **two separate session realms**: somebody signed in
at `supersonic.cv` is anonymous at `thebay.cloud`, and a private app on the new
root will show them the sign-in gate.

There is no clever fix and none is wanted. At cutover the cookie domain moves and
**every user signs out once**. With 19 users that is a message, not a migration —
and it is one more reason to do this at 19 users rather than at 1900. Until
cutover, the new root is for public apps and for testing.

**The wildcard certificate is authorized by DNS, not by the load balancer.**
ADR 0004 describes load-balancer authorization, and that is right for a
customer's attached domain — but a wildcard cannot be proved that way. The
existing `supersonic-wildcard` uses a DNS authorization (`supersonic-dns-auth`),
and `*.thebay.cloud` needs its own: `bay-dns-auth`, created 23 Aug, whose
challenge CNAME is what `scripts/setup-bay-domain.sh` hands to whoever runs it.

Cloud Run domain mappings need a **second, different** proof — Search Console
verification of `thebay.cloud`, attached to the account that runs the mapping.
Two proofs, two dashboards, and mistaking one for the other costs an afternoon.

### Phase 3 — the rename in code (1.5 days)

Mechanical for the most part, and it is worth doing in three passes rather than
one `sed`, because the three kinds of occurrence carry different risk:

1. **What a person reads** — the landing site, `/new`, the CLI's output, the
   agent prompt, emails. 75 occurrences in `apps/landing`, plus the product
   copy in `apps/web`. This is the rebrand people will actually see.
2. **Internal identifiers** — variable names, comments, test fixtures, log
   lines. The bulk of the 2259.
3. **History that should stay accurate.** Some comments record incidents by
   name and date. Rewriting `supersonic-deploy-prod` inside a note about what
   broke on 12 Aug makes the note wrong. These get read, not replaced.

`CONTEXT.md` and the ADRs need the product name changed and nothing else.

**Done when** `rg -i supersonic` returns only Phase 4's protocol strings, the
GCP identifiers from Decision 1, and the historical notes.

### Phase 4 — the protocol, with a window (1 day)

21 `x-supersonic-*` headers and 20 `SUPERSONIC_*` env vars are a contract with
two parties that are not the control plane: **installed CLIs**, and **apps
already running on the fleet** (`SUPERSONIC_HOSTNAME`, `SUPERSONIC_CODE_URL`
and friends are injected into customers' processes).

So: the server **accepts both** `x-bay-*` and `x-supersonic-*`, and **sends
both** env vars to running apps, for as long as the old CLI is in use. Writing
the new name, reading either. That dual-accept is about a hundred lines and it
is what makes the cutover boring.

**Done when** a build of the CLI at the previous version still deploys
successfully against the new server.

### Phase 5 — the CLI, republished (0.5 day)

New package published, `DEFAULT_URL` pointed at `app.thebay.cloud`, the binary
named `bay` with `supersonic` kept as an alias for one release.
`supersonic-cli` gets `npm deprecate` with the new name in the message. The
agent prompt in `/new` — the one people paste into Claude Code — is updated in
the same commit, since it names the package.

### Phase 6 — SKIPPED, 24 Aug, and why

Decided after tracing what actually holds the service names. The whole phase is
invisible to every person and carries the only outage risk in the plan.

- `supersonic-proxy` sits behind `url-map → supersonic-proxy-backend →
  supersonic-proxy-neg`. Neither the backend nor the NEG can be renamed either,
  so the "rename" is four new objects and a url-map edit.
- `supersonic-control-plane` carries the domain mappings for `app.supersonic.cv`
  and `app.thebay.cloud`. Moving them means Cloud Run issues fresh certificates
  — measured on this very migration at up to an hour, with the dashboard down
  for it.
- `supersonic-deploy-job`'s name is read by `assertJobImageMatches`, which
  refuses EVERY customer deploy when the job and the service disagree about
  their image. Renaming it live is precisely the drift that guard exists to
  catch.
- `ALTER DATABASE supersonic_platform RENAME TO bay_platform` needs every
  connection dropped.

And the decisive part: under Decision A `supersonic-deploy-prod` stays in every
image URL and every `gcloud` command regardless. The same word survives in the
same places whether or not the services are renamed — so the risk buys nothing,
not even tidiness.

Revisit only if Decision B is ever taken, where it stops being a separate
question.

### Phase 6 — infrastructure, the renameable parts (1.5 days) — NOT DONE

New Cloud Run services `bay-control-plane`, `bay-deploy-worker`, `bay-proxy`,
`bay-landing`, `bay-static`, `bay-shot`, `bay-umami` and job `bay-deploy-job`,
created beside the old ones from the same image, traffic moved, old ones deleted
after a day. `cloudbuild.yaml`, `scripts/setup-deploy-job.sh` and
`scripts/setup-deploy-worker.sh` follow.

The platform database renames in place — `ALTER DATABASE supersonic_platform
RENAME TO bay_platform` — which needs every connection dropped, so it is a
two-minute outage taken deliberately at a quiet hour, not an accident.

The SQL **instances** keep their names under Decision A.

**One trap already known:** `--set-secrets` replaces the whole list and wiped a
service's secrets on 12 Aug. Every new service is created with its full env, and
every update uses `--update-secrets`.

### Two things blocked on something older than this rename

**`supersonic.json` cannot be renamed yet.** The filename lives in
`CONFIG_FILENAME` inside `packages/cli/vendor/resolve.js`, which is generated by
`npm run bundle` and must not be hand-edited. That bundle cannot be regenerated:
`vendor/inputs.json` lists `apps/web/lib/process-deploy.ts`, and the file is not
in the checkout. The vendor test has been failing on this since before the
rename started — checked against a clean `main`.

So the CLI still writes and reads `supersonic.json`, and the help text says so,
because a CLI that promises `bay.json` while writing the other name is worse
than either. Restore the missing source, run `npm run bundle`, and the rename of
the config file is one line — with `lib/brand.js`'s `projectFile` already there
to keep reading the old name.

**`SUPERSONIC_CODE_BUCKET` and friends stay.** They are injected by the server
into apps that are already running, so they are Phase 4's dual-accept problem
and not a string to replace. Left alone deliberately; a bulk rename caught them
once and 16 tests said so.

### Cutover preconditions — none of these are optional

The landing page and `llms.txt` now say **Bay**, `@thebaycloud/cli` and
`app.thebay.cloud`. All three are promises, and two of them are not yet true.
Deploying `apps/landing` before they are would put a manual in front of coding
agents telling them to `npm i -g @thebaycloud/cli` — a package that does not exist — and
an "Open app" button pointing at a host with no certificate.

So, in order, and none skippable:

1. ~~`@thebaycloud/cli` published to npm and installable~~ — **done 24 Aug**,
   v1.0.0. Verified against the published tarball, not the checkout: a clean
   install exposes both `bay` and `supersonic`, an existing
   `~/.supersonic/config.json` is copied to `~/.bay` with the original left in
   place, and `SUPERSONIC_URL` is still honoured.
2. ~~`app.thebay.cloud` serving the control plane~~ — **done 24 Aug**: all three mappings Ready, apex/www/app answer 200/200/307
3. `apps/landing` deployed
4. `ROOT_DOMAIN` flipped on the control plane, the worker and the job
5. `COOKIE_DOMAIN` flipped — **this signs every user out once**
6. `supersonic.cv` 301s to `thebay.cloud`

Steps 4 and 5 are the same deploy. Splitting them leaves a window where the
platform builds `thebay.cloud` links while the cookie only exists on
`supersonic.cv`, and every one of those links lands on a sign-in gate that
cannot be satisfied.

### Phase 7 — cutover (0.5 day)

`ROOT_DOMAIN=thebay.cloud` becomes the default. New apps get
`<slug>.thebay.cloud`. The three existing apps keep answering on both. The
landing site and `app.supersonic.cv` 301 to the new domain. The one attached
custom domain is unaffected — it points at an app, not at a root.

Three app owners get one message each. That is the entire migration
communication plan, and it is why doing this now is worth it.

### Phase 8 — cleanup, weeks later (0.5 day)

Old Cloud Run services deleted, old CLI deprecated long enough that downloads
have stopped, `x-supersonic-*` acceptance removed once no old CLI has been seen
in the logs for a month.

---

## The estimate

| Phase | Days |
|---|---|
| 1. Name becomes configuration | 0.5 |
| 2. thebay.cloud live beside the old | 1.0 |
| 3. Rename in code | 1.5 |
| 4. Protocol dual-accept | 1.0 |
| 5. CLI republished | 0.5 |
| 6. Infrastructure | 1.5 |
| 7. Cutover | 0.5 |
| 8. Cleanup (weeks later) | 0.5 |
| **Total, Decision A** | **≈ 7 days** |
| Decision B instead (new GCP project) | **+5 to 8 days**, and the only real outage risk in the plan |

Seven working days of focused work, spread over about two calendar weeks because
of certificate provisioning and a soak period between Phase 7 and Phase 8.

**What could make it longer.** External identities not in the repository and not
counted above: the GitHub OAuth app used for login (`Ov23ligIqOe5hHq0a2U0`), the
Google OAuth client, Stripe's product and branding, the AgentMail inbox, Umami's
configured site names, and whatever the landing site's analytics and social
previews reference. Each is small; together they are half a day and they need
somebody with the passwords, which is you.

**What is already done.** The GitHub App created yesterday is called
`the-bay-cloud` and lives in the `thebaycloud` org. Nothing about it needs
touching, which is the one piece of this rename that is finished before it
started.

---

## The one thing worth doing before any of it

Phase 1 is cheap, reversible, invisible to users, and it makes every later phase
a config change rather than a deploy. It is worth doing this week whether or not
the rest is scheduled, because the alternative — a 2259-occurrence find-and-
replace on a live platform with no seam — is how a rename becomes a month.
