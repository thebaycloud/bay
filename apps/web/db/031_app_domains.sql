-- A domain a person owns, pointed at an app they own.
--
-- Until now the platform had exactly one way to name an app: the wildcard
-- `*.supersonic.cv`, resolved in the edge by chopping the suffix off the Host
-- header (services/proxy/src/index.ts, `slugFromHost`). Everything else the
-- request needed followed from the slug that came out of it. A name we did not
-- issue cannot be derived that way — it has to be looked up — so it has to be
-- written down, and this is where.
--
-- One row is one hostname. Not one row per app with a `domain` column: an app
-- that answers on `acme.com` almost always has to answer on `www.acme.com` too,
-- and a schema that can hold only one of them makes the second one a migration
-- rather than a second row.

CREATE TABLE IF NOT EXISTS app_domains (
  -- The hostname itself is the key, and that is the security property: one
  -- hostname belongs to one app, decided by the database, not by whichever
  -- lookup happens to run first. A second person claiming a name someone else
  -- already attached is a constraint violation, not a race.
  --
  -- Stored lowercase with no trailing dot, which is what `normalizeHostname`
  -- produces and what the edge compares against. The CHECK is here because the
  -- edge's lookup is an equality test: a row written as `Acme.com` by any future
  -- writer would be a row that can never be found, and would look like DNS.
  hostname    text PRIMARY KEY CHECK (hostname = lower(hostname)),

  -- The app, by slug rather than by id. The edge already resolves everything
  -- from a slug, and `apps.slug` is unique, so this is the join that costs the
  -- serving path nothing. ON DELETE CASCADE keeps a deleted app from leaving a
  -- hostname behind that nobody can claim — the certificate it named still has
  -- to be torn down separately, which the delete path does before the row goes.
  slug        text NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,

  -- How far along the attachment is. The three states are the three things a
  -- person is actually waiting for, in order:
  --
  --   pending_dns  we have written the name down; the domain does not point at
  --                us yet, so there is nothing else we can do.
  --   securing     it points at us, and Google is issuing the certificate. The
  --                app already answers on HTTP here; HTTPS does not work yet.
  --   live         the certificate is serving. This is the only state in which
  --                the domain does what the person asked for.
  --   failed       issuance was refused, and `detail` says what Google said.
  --
  -- 'failed' is a state, not the absence of one: a domain whose certificate was
  -- refused still resolves to us and still gets traffic, and an empty status
  -- would leave the edge deciding what to do with a request it cannot explain.
  status      text NOT NULL DEFAULT 'pending_dns',

  -- The Certificate Manager resources this hostname owns, by id.
  --
  -- Derived deterministically from the hostname (lib/domain-cert.ts,
  -- `certIdFor`) so that creating them twice is idempotent, and recorded anyway:
  -- a derivation that changes shape later must not orphan the resources created
  -- under the old one. What is written here is what gets deleted.
  cert_id     text,
  entry_id    text,

  -- Why it is not live yet, in words that can be shown to a person. Null while
  -- nothing has gone wrong.
  detail      text,

  -- When the state above was last argued from reality rather than from memory.
  -- The reconcile reads it to avoid asking Google the same question twice per
  -- page load; a person reads it as "checked a moment ago".
  checked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  live_at     timestamptz,

  CONSTRAINT app_domains_status CHECK (status IN ('pending_dns', 'securing', 'live', 'failed'))
);

-- The dashboard's question: what does this app answer on. The edge's question is
-- the primary key and needs no index of its own.
CREATE INDEX IF NOT EXISTS app_domains_slug_idx ON app_domains(slug);
