import { SelectorMiss, selectorHealth, type SelectorTarget } from "./selectors";
import { diagnose } from "./diagnose";
import {
  readProfilePage,
  scrapeConnections,
  scrapePostCommenters,
  scrapePostLikers,
  scrapeSearchResults,
  type ScrapeResult,
} from "./scrape";
import type { ContentRequest, ContentResponse } from "../lib/messages";

/**
 * The content script is a thin executor: it owns DOM access and nothing else.
 * All state, scheduling, and network traffic live in the service worker, so a
 * page navigation cannot lose work in flight.
 */

const HEALTH_TARGETS: SelectorTarget[] = [
  "reactionsButton",
  "reactorsModal",
  "commentsList",
  "searchResults",
  "connectionsList",
  "profileHeadline",
];

async function handle(request: ContentRequest): Promise<ContentResponse> {
  switch (request.type) {
    case "ping":
      return { ok: true, result: { url: location.href } };

    case "selectorHealth":
      return { ok: true, result: selectorHealth(HEALTH_TARGETS) };

    case "diagnose":
      return { ok: true, result: diagnose() };

    case "scrape": {
      let result: ScrapeResult;
      switch (request.source) {
        case "post_likers":
          result = await scrapePostLikers(request.limit);
          break;
        case "post_commenters":
          result = await scrapePostCommenters(request.limit);
          break;
        case "search":
          result = await scrapeSearchResults(request.limit);
          break;
        case "connections":
          result = await scrapeConnections(request.limit);
          break;
      }
      return { ok: true, result };
    }

    case "readProfile":
      return { ok: true, result: readProfilePage() };
  }
}

chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
  handle(request)
    .then(sendResponse)
    .catch((e: unknown) => {
      // A SelectorMiss is a maintenance signal, not a generic crash — tag it so
      // the panel and the audit trail can call it out specifically.
      const isSelectorMiss = e instanceof SelectorMiss;
      sendResponse({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        kind: isSelectorMiss ? "selector_miss" : "error",
      });
    });
  // Returning true keeps the message channel open for the async response.
  return true;
});
