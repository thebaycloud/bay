# A GitHub connection is an installation a workspace owns, not a token that worked once

The platform can already clone a repository — `fetchSource` in `lib/source.ts`
has run `git clone --depth 1` since the beginning. What it cannot do is clone a
repository that is private, because nothing has ever attached credentials to
that command. This is the whole of the gap: not a pipeline, not a build, one
missing header.

Closing it is a **GitHub App**, and the App is now created — `the-bay-cloud`,
App ID 4680812, owned by `thebaycloud`, with `contents:read` and `metadata:read`
and nothing else. Its credentials are in Secret Manager as `gh-app-id`,
`gh-app-private-key` and `gh-webhook-secret`, mounted on the control plane, the
deploy worker and the deploy job as `GH_APP_ID`, `GH_APP_PRIVATE_KEY` and
`GH_WEBHOOK_SECRET`.

## The App is not the login, and keeping them apart is the point

We have had "sign in with GitHub" for months. It works, and it is useless here:
it asks for `read:user user:email`, which cannot read a line of code. The
temptation is to widen it — add the `repo` scope to the login we already have
and be done in an afternoon.

That trade is worse than it looks. `repo` is not narrowable: it grants every
repository the person can see, including ones belonging to employers who never
agreed to anything, and it does not expire until somebody revokes it. To deploy
one folder we would be holding the keys to everything. Render and Vercel both
run a GitHub App **separate** from their GitHub login for exactly this reason,
and we follow them.

What the App gives instead is the shape we want: the installer chooses which
repositories, the token is scoped to that choice, and it dies in an hour.
Deploy keys would scope just as well but cost the person a copy-paste step,
which is the one thing this product exists to remove.

## The record is `installation → workspace`, and the app names the installation

A token is not a connection. It is a fact that was true for an hour, and a
schema that stores one has to answer "is it still good?" by trying it.

So what is stored is the **installation** — GitHub's own name for "this account
granted this App access to these repositories" — against the workspace that
connected it. `github_installations` is keyed by `installation_id` because
GitHub already guarantees it unique, and carries the account login so a page can
say *thebaycloud* without asking GitHub who that is.

One workspace can hold several. A person with a personal account and two orgs
has three installations and one workspace, and a single column on `workspaces`
would have forced them to pick one. The row is per installation; the workspace
is the foreign key.

An app then names the installation it was deployed from, in
`apps.gh_installation_id`. `apps.repo_url` already records **where** — nullable,
and it stays nullable for the reasons `lib/repo-source.ts` sets out. This new
column records **through which grant**, which is the part a redeploy needs and
cannot derive: the same URL is reachable through one installation and not
another, and guessing wrong is a clone that fails for a reason nobody can see.

The URL stored is always the clean one. A token in `repo_url` would be a
credential in a table that is read by the redeploy path, the x-ray and the
timeline, expired within the hour and wrong forever after.

## Losing access is a state with a sentence, not a failed build

Render documents the case we would otherwise discover from a support ticket:
the person who connected a repository leaves, loses access, or narrows the
installation, and every deploy for that app breaks. Vercel ships an entire
knowledge-base page for "I can't see my repository", and the answer is always
that the App was installed against a narrower selection than the person thinks.

That is not an error to bubble up. It is three distinct states, and the code
tells them apart because the person's next action is different in each:

- **The installation is gone** — GitHub answers 404 when we ask for a token.
  They have to install the App again.
- **The repository is no longer in it** — the installation is fine, the
  repository is not in what it can see. They have to widen the selection.
- **Our own credentials are wrong** — GitHub answers 401 to a JWT we signed.
  Nothing the person does helps; this one is ours, and saying so is the
  difference between a bug report and an hour of somebody re-installing an App
  that was never the problem.

The first two are repairable and get a link to the App's configuration page,
which is why the import screen carries that link whether or not anything is
broken. The third is an incident.

## Phase one deploys by button, and the webhook stays dark

The App's webhook exists and is **inactive**, pointing at a route that is not
written. That is deliberate, and it is the ordering that matters rather than the
feature: a webhook that deploys on its own is not a thing to debug on live
users, and a webhook route without signature verification is an open door to
deploying arbitrary code as somebody else's app.

So phase one is: connect, list, choose, deploy. Phase two adds
`X-Hub-Signature-256` over the raw body and turns the webhook on, and the
`gh-webhook-secret` already stored is what it will verify against.

## The token never reaches a log line

`git clone https://x-access-token:<TOKEN>@github.com/owner/repo.git` is
GitHub's documented form and what we use. It puts the credential in a URL, and a
URL in this codebase gets logged — `fetchSource` opens its clone stage with
`log("Pulling " + origin.url)`, and that line is stored, replayed on reconnect
and shown to the person watching.

So the authenticated URL is built at the call to `git` and nowhere else. The
origin carries the clean URL and the token beside it, never spliced, and the log
line reads from the clean one. A test asserts the token appears in no line the
logger saw, because this is the kind of thing that is correct when written and
broken by the next person who reaches for the value that is already there.
