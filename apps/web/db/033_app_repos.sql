-- Which repository an app follows, so a push can ship it.
--
-- 032 wrote down the CONNECTION — an installation a workspace owns — and that
-- is what makes a private repository readable. It says nothing about which app
-- came from which repository, so the platform could clone on request and could
-- not answer the only question a push asks: "does anybody care about this?"
--
-- This is that answer, and it is the whole difference between a repository
-- somebody typed once and a repository that ships.

CREATE TABLE IF NOT EXISTS app_repos (
  -- By slug, one row per app, following 031_app_domains.sql — `apps.slug` is
  -- unique, everything on this platform resolves from a slug, and ON DELETE
  -- CASCADE stops a deleted app leaving behind a link that pushes still match
  -- and nothing can clear.
  --
  -- PRIMARY KEY rather than an index over a growable set, because one app
  -- follows one repository. A second repository is a second app.
  slug            text PRIMARY KEY REFERENCES apps(slug) ON DELETE CASCADE,

  -- Through which grant the clone happens. CASCADE because a connection that is
  -- gone cannot read anything: leaving the row would leave an app that looks
  -- connected and fails at `git fetch` with a credential error, which is the
  -- least legible failure this feature has.
  installation_id bigint NOT NULL REFERENCES github_installations(installation_id) ON DELETE CASCADE,

  -- What a push is MATCHED on, and why it is the id rather than the name: a
  -- rename changes `full_name` and keeps `id`, and surviving a rename is the
  -- entire reason to store this. The name lives beside it for display and for
  -- API paths, and is refreshed from every webhook payload — so the two can
  -- disagree for exactly as long as it takes the next push to arrive.
  repo_id         bigint NOT NULL,
  repo_full_name  text NOT NULL,

  -- The production branch. Only pushes to this one ship.
  branch          text NOT NULL,

  -- On from the moment a repository is connected, which is what a person who
  -- just connected a repository expects to happen. The switch exists so that
  -- expectation is reversible, not so it has to be opted into.
  auto_deploy     boolean NOT NULL DEFAULT true,

  connected_at    timestamptz NOT NULL DEFAULT now()
);

-- The query a webhook makes, and the only one on a path somebody is waiting on:
-- "which app, if any, does this push belong to".
CREATE INDEX IF NOT EXISTS app_repos_repo_branch ON app_repos (repo_id, branch);

-- Who connected the account, in GitHub's own terms.
--
-- 032 records `connected_by`, which is OUR user id — the right answer to "whose
-- workspace is this" and no answer at all to "was this push by that person".
-- A push carries a GitHub login and nothing else, so comparing it needs a
-- GitHub login to compare against.
--
-- NULL for an organisation installation, deliberately and permanently: GitHub
-- does not say which member installed it, and CONTEXT.md is explicit that a
-- wrong name in "who did it" is worse than no name. So an org push answers
-- `someone`, which is the honest reading rather than a gap.
ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS connected_login text;

-- Which commit a build was of.
--
-- `builds` (021) is already the one durable row per shipping attempt, and a
-- build caused by a push is meaningless without the commit that caused it: the
-- timeline cannot show it, and nothing can find the SHA to report an outcome
-- against once the deploy run row is deleted.
--
-- All four stay NULL for a CLI deploy and for an upload, which is the honest
-- answer — those builds have no commit.
ALTER TABLE builds ADD COLUMN IF NOT EXISTS commit_sha     text;
ALTER TABLE builds ADD COLUMN IF NOT EXISTS commit_branch  text;
ALTER TABLE builds ADD COLUMN IF NOT EXISTS commit_message text;
ALTER TABLE builds ADD COLUMN IF NOT EXISTS commit_author  text;
