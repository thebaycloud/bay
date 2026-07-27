import type { ProfileEnrichment, ScrapeResult, ScrapeSource } from "../content/scrape";

/** Panel/service-worker -> content script. */
export type ContentRequest =
  | { type: "ping" }
  | { type: "selectorHealth" }
  | { type: "diagnose" }
  | { type: "scrape"; source: ScrapeSource; limit?: number }
  | { type: "readProfile" };

export type ContentResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string; kind: "selector_miss" | "error" };

/** Panel -> service worker. */
export type WorkerRequest =
  | { type: "settings:get" }
  | { type: "settings:set"; apiBaseUrl: string; token: string }
  | { type: "settings:test" }
  | { type: "scrape:run"; source: ScrapeSource; limit?: number }
  | { type: "enrich:run"; batchSize?: number }
  | { type: "stats:get" }
  | { type: "runs:get" }
  | { type: "selectorHealth" }
  | { type: "diagnose" };

export type WorkerResponse<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: string; kind?: "selector_miss" | "error" };

export interface ScrapeRunSummary {
  found: number;
  created: number;
  existing: number;
  skipped: number;
}

export type { ProfileEnrichment, ScrapeResult, ScrapeSource };
