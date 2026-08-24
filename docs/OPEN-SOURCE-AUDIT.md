# Opening this repository: what is in it, and what has to change first

Written 24 Aug 2026, against 964 commits and 969 files from six authors.

Scanned, not assumed. Every number below came from running something.

---

## The part that passes, and it is the part that cannot be fixed later

**There are no credentials in this repository or in its history.**

Checked across all 964 commits, not just the working tree: Google API keys,
OpenAI keys, Stripe live keys, GitHub tokens (`ghp_`, `ghs_`), npm tokens, Slack
tokens, and PEM private-key blocks. Nothing. No `.env`, `.pem`, `.key`, `.p12`
or service-account JSON was ever added, in any commit, on any branch.

This matters more than everything else on this page put together. A stale README
is an afternoon; a key in commit 200 means rewriting history and rotating
everything, and by then somebody has already cloned it. This repository is clean
and can simply be opened.

The secret-handling discipline that produced that is worth keeping: values live
in Secret Manager, and `apps/web/lib/app-secrets.ts` explains why.

---

## Blockers — a repository cannot be open source without these

### 1. There is no LICENSE

Without one, "open source" is not what this is. Code with no licence is
**all rights reserved** by default: nobody may legally copy, modify or run it,
whatever the README says, and a company lawyer will tell an engineer exactly
that.

The choice is a product decision, not a technical one:

- **Apache-2.0** — permissive, and unlike MIT it grants patent rights
  explicitly. What most infrastructure companies pick when they want adoption.
- **AGPL-3.0** — anyone running a modified copy as a network service must
  publish their changes. What a hosted product picks when it does not want a
  cloud provider reselling it. Sentry, Grafana and MongoDB all started here.
- **BSL / Fair-Source** — source-available with a delay before it becomes open.
  Honest about intent; not open source, and the community will say so.

Given this IS a hosting product whose competitors are hosting products, AGPL-3.0
or a fair-source licence is the defensible pick. Apache-2.0 is the right answer
only if adoption matters more than protection.

Needs a `LICENSE` file, a line in the README, and `"license"` in every
`package.json` — nine of them currently say nothing.

### 2. The README describes a product that no longer exists

It opens with **Supersonic**, sells `*.supersonic.cv`, and lays out a phase table
from before the rebrand. The first thing anyone sees on GitHub is a name that has
not been true since yesterday.

It also does not answer the only question a visitor has: **what is this, and can
I run it?**

---

## Must clean before opening

### 3. A real person's email, in a migration that runs on every install

`apps/web/db/005_plans.sql` contained:

    UPDATE users SET plan = 'pro' WHERE email = 'arsenfounder@gmail.com';

Fine while the repository is ours; wrong the moment it is not. **Removed
24 Aug.** The statement was a no-op on any fresh database, and the row it
targeted has been `pro` since August, so deleting it changed nothing here.

### 4. Two Claude Code session transcripts, committed at the root

`2026-08-08-171326-…txt` and `2026-08-08-213132-…txt` — 989 lines, 68KB of
terminal output, at the top level where a visitor's eye lands first. No secrets
in them; checked. **Removed 24 Aug.**

### 5. Internal infrastructure, named throughout

| | count |
|---|---|
| `supersonic-deploy-prod` (GCP project id) | 216 |
| Production load-balancer and fleet IPs (`8.23x.x.x`) | 77 |
| GCP project number `540236122367` | 11 |
| Cloud Run service hash `uyuwsbguuq` | 9 |
| Internal VPC addresses (`10.128.0.x`) | 5 |
| GitHub OAuth client id | 1 |

**None of this is a secret** — a project id is not a credential, and the IPs
answer the public internet already. It is a decision, not a leak, and there are
two honest answers:

**Leave it.** It is the truth about how the thing runs, the comments that
reference it are the ones that explain incidents, and scrubbing 216 occurrences
would make the history unreadable to gain nothing an attacker did not already
have from DNS.

**Or parameterise the code and leave the docs.** Substitutions already exist in
`cloudbuild.yaml`; the scripts could take a project id instead of naming one.
That is worth doing anyway for anyone who wants to run their own, and it is a
day's work — not a security fix.

Recommendation: leave the docs, parameterise the scripts, and say in the README
that the public deployment's identifiers appear throughout on purpose.

---

## Should add before announcing

Nothing here blocks a public repository; all of it decides whether anyone stays.

- **`CONTRIBUTING.md`** — how to run tests (`npm test` in `apps/web`, and the
  caveat that `test/deploy-pipeline.test.ts` hangs alone and passes in the full
  run), what a good commit message looks like here, and the fact that this
  codebase writes long explanatory comments on purpose.
- **`SECURITY.md`** — where to report a vulnerability. A hosting platform will
  receive reports; without this they arrive in a public issue.
- **Issue and PR templates.**
- **`CODE_OF_CONDUCT.md`** — expected, cheap, and its absence is noticed.
- **`.github/workflows`** — there is no CI. Every check in this repository is run
  by a person on a laptop today, and an outside contributor has no way to know
  whether their change passes.

---

## The strategic question, which is not about files

**Can anyone actually run this?**

The platform is welded to one Google Cloud project: Cloud Run, Cloud SQL, Cloud
Build, Certificate Manager, Artifact Registry, Compute instances for the fleet,
and Secret Manager. Not as configuration — as the assumption underneath. There is
no `docker compose up`, no local mode, no seam where another provider could go.

That leaves three honest positions, and picking one is the actual decision:

**"Open for reading."** The code is public; running it is not the point. Legible
to people evaluating the product and to agents reading it. Costs nothing beyond
this page. Say so plainly in the README, because a repository that looks
runnable and is not burns goodwill.

**"Open, and self-hostable on GCP."** Publish the setup scripts that already
exist in `scripts/`, parameterise the project id, write the runbook. Perhaps a
week. Realistically used by very few people, because it needs somebody's own GCP
project and billing.

**"Open and portable."** Abstract the provider. Months, and it changes what the
product is.

At three apps and nineteen users, **the first is the honest one** — and it is
worth saying out loud on the page rather than letting people discover it after
cloning.

---

## Order of work

1. Pick a licence. Everything else is cosmetic next to this.
2. Rewrite the README for someone who has never heard of this — including which
   of the three positions above is true.
3. `SECURITY.md`, `CONTRIBUTING.md`, templates, code of conduct.
4. A CI workflow that runs what a person runs today.
5. Parameterise the setup scripts, if self-hosting is the intent.

Done already: the transcripts and the seeded email are gone.
