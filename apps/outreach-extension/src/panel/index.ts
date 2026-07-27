import type { ScrapeSource, WorkerRequest, WorkerResponse } from "../lib/messages";

const $ = <T extends Element>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`panel markup is missing ${selector}`);
  return el;
};

const status = $<HTMLDivElement>("#status");

function setStatus(message: string, isError = false): void {
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

async function call<T>(request: WorkerRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as WorkerResponse<T>;
  if (!response.ok) {
    const error = new Error(response.error);
    error.name = response.kind === "selector_miss" ? "SelectorMiss" : "Error";
    throw error;
  }
  return response.result;
}

/** Disable the button for the duration so a double-click cannot start two runs. */
async function withButton(button: HTMLButtonElement, label: string, fn: () => Promise<string>) {
  button.disabled = true;
  setStatus(`${label}…`);
  try {
    setStatus(await fn());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setStatus(
      e instanceof Error && e.name === "SelectorMiss"
        ? `Selector out of date.\n\n${message}`
        : message,
      true,
    );
  } finally {
    button.disabled = false;
  }
}

// --- tabs -----------------------------------------------------------------

for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".tab")) other.classList.remove("is-active");
    for (const panel of document.querySelectorAll(".panel")) panel.classList.add("is-hidden");
    tab.classList.add("is-active");
    $(`#panel-${tab.dataset.tab}`).classList.remove("is-hidden");
  });
}

// --- scraping -------------------------------------------------------------

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-scrape]")) {
  button.addEventListener("click", () =>
    withButton(button, `Scraping ${button.textContent?.toLowerCase()}`, async () => {
      const source = button.dataset.scrape as ScrapeSource;
      const summary = await call<{
        found: number;
        created: number;
        existing: number;
        skipped: number;
      }>({ type: "scrape:run", source });
      await refresh();
      return (
        `Found ${summary.found} · ${summary.created} new · ` +
        `${summary.existing} already known · ${summary.skipped} skipped`
      );
    }),
  );
}

$<HTMLButtonElement>("#enrich").addEventListener("click", (e) =>
  withButton(e.currentTarget as HTMLButtonElement, "Enriching profiles", async () => {
    const result = await call<{ attempted: number; enriched: number; failed: number }>({
      type: "enrich:run",
      batchSize: 10,
    });
    await refresh();
    return `Enriched ${result.enriched} of ${result.attempted}` +
      (result.failed ? ` · ${result.failed} failed` : "");
  }),
);

// --- selector health ------------------------------------------------------

$<HTMLButtonElement>("#check-health").addEventListener("click", (e) =>
  withButton(e.currentTarget as HTMLButtonElement, "Checking selectors", async () => {
    const health = await call<Record<string, boolean>>({ type: "selectorHealth" });
    const list = $<HTMLUListElement>("#health");
    list.innerHTML = "";
    for (const [target, ok] of Object.entries(health)) {
      const li = document.createElement("li");
      li.textContent = target;
      li.className = ok ? "is-ok" : "is-error";
      list.append(li);
    }
    const broken = Object.values(health).filter((ok) => !ok).length;
    // Not every selector applies to every page, so a miss here is a prompt to
    // look rather than proof of a regression.
    return broken
      ? `${broken} selector(s) did not match this page — expected if the page has no such element.`
      : "All selectors match.";
  }),
);

$<HTMLButtonElement>("#diagnose").addEventListener("click", (e) =>
  withButton(e.currentTarget as HTMLButtonElement, "Capturing page state", async () => {
    const diagnosis = await call<Record<string, unknown>>({ type: "diagnose" });
    const json = JSON.stringify(diagnosis, null, 2);
    $<HTMLPreElement>("#diagnosis").textContent = json;
    await navigator.clipboard.writeText(json).catch(() => {
      // Clipboard can be blocked when the panel lacks focus; the <pre> above
      // still holds the text, so this is not worth failing the action over.
    });
    return "Copied. Paste it back so the selectors can be fixed from real markup.";
  }),
);

// --- settings -------------------------------------------------------------

$<HTMLButtonElement>("#save-settings").addEventListener("click", (e) =>
  withButton(e.currentTarget as HTMLButtonElement, "Connecting", async () => {
    const account = await call<{ account: { label: string; email: string } }>({
      type: "settings:set",
      apiBaseUrl: $<HTMLInputElement>("#api-url").value.trim(),
      token: $<HTMLInputElement>("#token").value.trim(),
    });
    $("#account").textContent = `${account.account.label} · ${account.account.email}`;
    await refresh();
    return "Connected.";
  }),
);

// --- data refresh ---------------------------------------------------------

async function refresh(): Promise<void> {
  try {
    const { bySource } = await call<{
      bySource: Array<{ source: string; total: number; enriched: number }>;
    }>({ type: "stats:get" });
    const body = $<HTMLTableSectionElement>("#stats tbody");
    body.innerHTML = "";
    for (const row of bySource) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = row.source.replace(/_/g, " ");
      const count = document.createElement("td");
      count.textContent = `${row.total} (${row.enriched} enriched)`;
      tr.append(name, count);
      body.append(tr);
    }

    const { runs } = await call<{
      runs: Array<{
        source: string;
        found_count: number;
        new_count: number;
        error: string | null;
        created_at: string;
      }>;
    }>({ type: "runs:get" });
    const list = $<HTMLUListElement>("#runs");
    list.innerHTML = "";
    for (const run of runs.slice(0, 10)) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = run.source.replace(/_/g, " ");
      const detail = document.createElement("span");
      detail.textContent = run.error
        ? "failed"
        : `${run.new_count} new / ${run.found_count} found`;
      if (run.error) li.classList.add("is-error");
      li.title = run.error ?? new Date(run.created_at).toLocaleString();
      li.append(label, detail);
      list.append(li);
    }
  } catch {
    // Not configured yet, or the service is unreachable. The Settings tab is
    // where that gets fixed, so don't shout about it on every refresh.
  }
}

async function init(): Promise<void> {
  const settings = await call<{ apiBaseUrl: string; token: string }>({ type: "settings:get" });
  $<HTMLInputElement>("#api-url").value = settings.apiBaseUrl;
  $<HTMLInputElement>("#token").value = settings.token;

  if (settings.apiBaseUrl && settings.token) {
    try {
      const me = await call<{ account: { label: string; email: string } }>({
        type: "settings:test",
      });
      $("#account").textContent = `${me.account.label} · ${me.account.email}`;
      setStatus("Ready.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
    }
  } else {
    setStatus("Add the service URL and your token in Settings.");
  }
  await refresh();
}

void init();
