import { loadSettings, OutreachApi, saveSettings, type Settings } from "../lib/api";
import type {
  ContentRequest,
  ContentResponse,
  ProfileEnrichment,
  ScrapeResult,
  WorkerRequest,
  WorkerResponse,
} from "../lib/messages";

/**
 * The service worker owns settings, network access, and pacing. The content
 * script is not trusted with the account token, and is not asked to survive a
 * navigation — every multi-page flow is driven from here.
 */

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) chrome.sidePanel.open({ windowId: tab.windowId });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function requireApi(): Promise<OutreachApi> {
  const settings = await loadSettings();
  if (!settings?.apiBaseUrl || !settings.token) {
    throw new Error("Not configured — set the service URL and token in Settings.");
  }
  return new OutreachApi(settings);
}

/** The LinkedIn tab we drive: the active one if it qualifies, else the first open one. */
async function linkedInTab(): Promise<chrome.tabs.Tab> {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url?.startsWith("https://www.linkedin.com/")) return active;

  const [any] = await chrome.tabs.query({ url: "https://www.linkedin.com/*" });
  if (any) return any;

  throw new Error("Open a LinkedIn tab first.");
}

async function sendToTab(tabId: number, request: ContentRequest): Promise<ContentResponse> {
  try {
    return (await chrome.tabs.sendMessage(tabId, request)) as ContentResponse;
  } catch {
    // The content script has not attached yet (fresh navigation, or the
    // extension was reloaded while the tab stayed open). Inject and retry once.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await sleep(500);
    return (await chrome.tabs.sendMessage(tabId, request)) as ContentResponse;
  }
}

function unwrap<T>(response: ContentResponse): T {
  if (!response.ok) {
    const error = new Error(response.error);
    error.name = response.kind === "selector_miss" ? "SelectorMiss" : "Error";
    throw error;
  }
  return response.result as T;
}

/** Wait for a tab to finish loading, with a ceiling so a stuck page cannot hang the run. */
function waitForLoad(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("timed out waiting for the page to load"));
    }, timeoutMs);

    function listener(updatedId: number, info: chrome.tabs.TabChangeInfo) {
      if (updatedId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runScrape(source: ScrapeResult["source"], limit?: number) {
  const api = await requireApi();
  const tab = await linkedInTab();
  if (tab.id === undefined) throw new Error("LinkedIn tab has no id");

  try {
    const result = unwrap<ScrapeResult>(await sendToTab(tab.id, { type: "scrape", source, limit }));
    const summary = await api.ingest(result.source, result.sourceRef, result.people);
    await api.logEvent("scrape_completed", {
      source: result.source,
      sourceRef: result.sourceRef,
      ...summary,
    });
    return summary;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Record the failure server-side so a selector regression is visible in the
    // run history rather than only in whoever happened to be watching.
    await api.reportFailedScrape(source, tab.url ?? "", message).catch(() => {});
    throw e;
  }
}

/**
 * Visit un-enriched profiles one at a time and record what the page shows.
 *
 * Batches are small and paced on purpose: this navigates the user's own tab, so
 * it is both visible to them and indistinguishable from ordinary browsing.
 */
async function runEnrichment(batchSize = 10) {
  const api = await requireApi();
  const tab = await linkedInTab();
  if (tab.id === undefined) throw new Error("LinkedIn tab has no id");

  const { prospects } = await api.pendingEnrichment(batchSize);
  const returnTo = tab.url;
  let enriched = 0;
  let failed = 0;

  for (const prospect of prospects) {
    try {
      await chrome.tabs.update(tab.id, { url: prospect.profile_url });
      await waitForLoad(tab.id);
      // Let lazily-rendered sections (experience, activity) settle.
      await sleep(jitter(2500, 5000));

      const enrichment = unwrap<ProfileEnrichment>(await sendToTab(tab.id, { type: "readProfile" }));
      await api.saveEnrichment(prospect.id, enrichment);
      enriched++;
    } catch (e) {
      failed++;
      await api
        .logEvent(
          "enrichment_failed",
          { error: e instanceof Error ? e.message : String(e) },
          prospect.id,
        )
        .catch(() => {});
    }
    await sleep(jitter(4000, 9000));
  }

  if (returnTo) await chrome.tabs.update(tab.id, { url: returnTo }).catch(() => {});
  return { attempted: prospects.length, enriched, failed };
}

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case "settings:get":
      return (await loadSettings()) ?? { apiBaseUrl: "", token: "" };

    case "settings:set": {
      const settings: Settings = { apiBaseUrl: request.apiBaseUrl, token: request.token };
      await saveSettings(settings);
      return await new OutreachApi(settings).me();
    }

    case "settings:test":
      return await (await requireApi()).me();

    case "scrape:run":
      return await runScrape(request.source, request.limit);

    case "enrich:run":
      return await runEnrichment(request.batchSize);

    case "stats:get":
      return await (await requireApi()).stats();

    case "runs:get":
      return await (await requireApi()).runs();

    case "selectorHealth": {
      const tab = await linkedInTab();
      if (tab.id === undefined) throw new Error("LinkedIn tab has no id");
      return unwrap(await sendToTab(tab.id, { type: "selectorHealth" }));
    }

    case "diagnose": {
      const tab = await linkedInTab();
      if (tab.id === undefined) throw new Error("LinkedIn tab has no id");
      return unwrap(await sendToTab(tab.id, { type: "diagnose" }));
    }
  }
}

chrome.runtime.onMessage.addListener((request: WorkerRequest, _sender, sendResponse) => {
  handle(request)
    .then((result) => sendResponse({ ok: true, result } satisfies WorkerResponse))
    .catch((e: unknown) =>
      sendResponse({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        kind: e instanceof Error && e.name === "SelectorMiss" ? "selector_miss" : "error",
      } satisfies WorkerResponse),
    );
  return true;
});
