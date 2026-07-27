import type { ScrapedPerson } from "../content/people";
import type { ProfileEnrichment, ScrapeRunSummary, ScrapeSource } from "./messages";

export interface Settings {
  apiBaseUrl: string;
  token: string;
}

const SETTINGS_KEY = "outreach.settings";

export async function loadSettings(): Promise<Settings | null> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return stored[SETTINGS_KEY] ?? null;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Client for the outreach service.
 *
 * Only the service worker holds this — the content script runs in the page's
 * world and must never see the account token.
 */
export class OutreachApi {
  constructor(private readonly settings: Settings) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const base = this.settings.apiBaseUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.settings.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let payload: any = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(res.status, `non-JSON response from ${path}`);
    }
    if (!res.ok) {
      throw new ApiError(res.status, payload.error ?? `${method} ${path} failed (${res.status})`);
    }
    return payload as T;
  }

  me() {
    return this.request<{ account: { id: string; label: string; email: string } }>("GET", "/me");
  }

  ingest(source: ScrapeSource | "csv", sourceRef: string, prospects: ScrapedPerson[]) {
    return this.request<ScrapeRunSummary & { runId: string }>("POST", "/prospects/ingest", {
      source,
      sourceRef,
      prospects,
    });
  }

  reportFailedScrape(source: string, sourceRef: string, error: string) {
    return this.request<{ runId: string }>("POST", "/scrape-runs/failed", {
      source,
      sourceRef,
      error,
    });
  }

  pendingEnrichment(limit: number) {
    return this.request<{ prospects: Array<{ id: string; profile_url: string; full_name: string }> }>(
      "GET",
      `/prospects/pending-enrichment?limit=${limit}`,
    );
  }

  saveEnrichment(prospectId: string, enrichment: ProfileEnrichment) {
    return this.request<{ ok: true }>("POST", `/prospects/${prospectId}/enrichment`, {
      enrichment,
      headline: enrichment.headline,
      location: enrichment.location,
      title: enrichment.currentRole,
      company: enrichment.currentCompany,
    });
  }

  stats() {
    return this.request<{ bySource: Array<{ source: string; total: number; enriched: number }> }>(
      "GET",
      "/prospects/stats",
    );
  }

  runs() {
    return this.request<{
      runs: Array<{
        id: string;
        source: string;
        source_ref: string | null;
        found_count: number;
        new_count: number;
        error: string | null;
        created_at: string;
      }>;
    }>("GET", "/scrape-runs");
  }

  logEvent(type: string, payload: Record<string, unknown>, prospectId?: string) {
    return this.request<{ ok: true }>("POST", "/events", { type, payload, prospectId });
  }
}
