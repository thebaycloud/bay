-- A GitHub connection is an installation a workspace owns.
--
-- Keyed by GitHub's own installation id, because GitHub already guarantees it
-- unique and inventing a second key would mean keeping two in agreement for no
-- gain. Not a column on `workspaces`: a person with a personal account and two
-- orgs has three installations and one workspace, and a column would have made
-- them choose one.
--
-- `account_login` is denormalised on purpose. The import screen has to say
-- "thebaycloud" and asking GitHub who an installation belongs to, in order to
-- render a list of installations, is a network round trip to redraw a label.
--
-- `connected_by` is nullable and stays nullable. It records who pressed the
-- button, which is what you want when a connection breaks and nobody remembers
-- setting it up — but a user row can be deleted and the connection is still the
-- workspace's. ON DELETE SET NULL rather than CASCADE for exactly that: losing
-- the person must not silently take the workspace's connection with them.
CREATE TABLE IF NOT EXISTS github_installations (
  installation_id bigint PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id),
  account_login   text NOT NULL,
  account_type    text NOT NULL DEFAULT 'Organization',
  connected_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS github_installations_workspace_idx
  ON github_installations (workspace_id);

-- Through which grant this app was deployed.
--
-- `apps.repo_url` (028) records WHERE, and stays the record of where. This
-- records through which installation that URL was reachable, which a redeploy
-- needs and cannot derive: the same URL is reachable through one installation
-- and not another, and guessing wrong is a clone that fails for a reason nobody
-- can see.
--
-- NULLABLE and staying that way, for the same reason 028 gives about repo_url.
-- Every app deployed before today came from a public URL or an upload and has
-- no installation; a NOT NULL here would be a lie about all of them, and a
-- default of 0 would be a lie that readers trust.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS gh_installation_id bigint;
