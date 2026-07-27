import { getPool } from "./db";
import { HttpError, type Route } from "./http";
import { ingestProspects, type ScrapedProspect, type Source } from "./prospects";

function requireAccount(ctx: { account?: { id: string } }) {
  if (!ctx.account) throw new HttpError(401, "unauthenticated");
  return ctx.account;
}

export const routes: Route[] = [
  {
    method: "GET",
    path: "/health",
    public: true,
    handler: async () => {
      // Touch the database so the check fails when Postgres is unreachable —
      // a health check that only proves the process is up is worth little.
      await getPool().query("SELECT 1");
      return { ok: true };
    },
  },

  {
    method: "GET",
    path: "/me",
    handler: async (ctx) => ({ account: requireAccount(ctx) }),
  },

  /**
   * Bulk-ingest scraped prospects. The extension posts one batch per scrape
   * run; the response tells the panel how many were genuinely new.
   */
  {
    method: "POST",
    path: "/prospects/ingest",
    handler: async (ctx) => {
      const account = requireAccount(ctx);
      const { source, sourceRef, prospects } = ctx.body ?? {};
      if (!Array.isArray(prospects)) {
        throw new HttpError(400, "prospects must be an array");
      }
      if (typeof source !== "string") {
        throw new HttpError(400, "source is required");
      }
      return ingestProspects({
        accountId: account.id,
        source: source as Source,
        sourceRef: typeof sourceRef === "string" ? sourceRef : undefined,
        prospects: prospects as ScrapedProspect[],
      });
    },
  },

  /**
   * Record a scrape that aborted — almost always a selector that stopped
   * matching. Surfacing these is the difference between noticing a LinkedIn
   * DOM change today and noticing it after a week of silent zero-yield runs.
   */
  {
    method: "POST",
    path: "/scrape-runs/failed",
    handler: async (ctx) => {
      const account = requireAccount(ctx);
      const { source, sourceRef, error } = ctx.body ?? {};
      if (typeof source !== "string" || typeof error !== "string") {
        throw new HttpError(400, "source and error are required");
      }
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO scrape_runs (account_id, source, source_ref, error)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [account.id, source, sourceRef ?? null, error.slice(0, 2000)],
      );
      return { runId: rows[0].id };
    },
  },

  {
    method: "GET",
    path: "/scrape-runs",
    handler: async (ctx) => {
      const account = requireAccount(ctx);
      const { rows } = await getPool().query(
        `SELECT id, source, source_ref, found_count, new_count, error, created_at
         FROM scrape_runs WHERE account_id = $1
         ORDER BY created_at DESC LIMIT 50`,
        [account.id],
      );
      return { runs: rows };
    },
  },

  {
    method: "GET",
    path: "/prospects",
    handler: async (ctx) => {
      const account = requireAccount(ctx);
      const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? 100), 500);
      const { rows } = await getPool().query(
        `SELECT id, profile_url, full_name, first_name, headline, company, title,
                location, source, source_ref, enriched_at, created_at
         FROM prospects WHERE owner_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [account.id, limit],
      );
      return { prospects: rows };
    },
  },

  {
    method: "GET",
    path: "/prospects/stats",
    handler: async (ctx) => {
      const account = requireAccount(ctx);
      const { rows } = await getPool().query(
        `SELECT source,
                count(*)::int AS total,
                count(*) FILTER (WHERE enriched_at IS NOT NULL)::int AS enriched
         FROM prospects WHERE owner_id = $1
         GROUP BY source ORDER BY total DESC`,
        [account.id],
      );
      return { bySource: rows };
    },
  },

  /**
   * Hand the enrichment pass its next batch: prospects this account owns that
   * have never had their profile visited. Oldest first, so a large scrape
   * drains in the order it was collected.
   */
  {
    method: "GET",
    path: "/prospects/pending-enrichment",
    handler: async (ctx) => {
      const account = requireAccount(ctx);
      const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? 10), 50);
      const { rows } = await getPool().query(
        `SELECT id, profile_url, full_name FROM prospects
         WHERE owner_id = $1 AND enriched_at IS NULL
         ORDER BY created_at ASC LIMIT $2`,
        [account.id, limit],
      );
      return { prospects: rows };
    },
  },

  {
    method: "POST",
    path: "/prospects/:id/enrichment",
    handler: async (ctx) => {
      const account = requireAccount(ctx);
      const id = ctx.url.searchParams.get("id");
      const { enrichment, company, title, location, headline } = ctx.body ?? {};
      if (!enrichment || typeof enrichment !== "object") {
        throw new HttpError(400, "enrichment object is required");
      }
      const { rowCount } = await getPool().query(
        `UPDATE prospects SET
           enrichment  = $3,
           enriched_at = now(),
           company     = COALESCE($4, company),
           title       = COALESCE($5, title),
           location    = COALESCE($6, location),
           headline    = COALESCE($7, headline)
         WHERE id = $1 AND owner_id = $2`,
        [
          id,
          account.id,
          JSON.stringify(enrichment),
          company ?? null,
          title ?? null,
          location ?? null,
          headline ?? null,
        ],
      );
      if (!rowCount) throw new HttpError(404, "prospect not found");
      return { ok: true };
    },
  },

  /** Append-only audit trail; the extension posts here for every action taken. */
  {
    method: "POST",
    path: "/events",
    handler: async (ctx) => {
      const account = requireAccount(ctx);
      const { type, prospectId, payload } = ctx.body ?? {};
      if (typeof type !== "string") throw new HttpError(400, "type is required");
      await getPool().query(
        `INSERT INTO events (account_id, prospect_id, type, payload)
         VALUES ($1, $2, $3, $4)`,
        [account.id, prospectId ?? null, type, JSON.stringify(payload ?? {})],
      );
      return { ok: true };
    },
  },
];
