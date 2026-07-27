# @supersonic/outreach-extension

MV3 Chrome extension for internal LinkedIn outreach. Drives the teammate's own
logged-in tab; it never exports the session cookie and never talks to LinkedIn
from a server.

## Build and load

```bash
npm install
npm run build        # or: npm run watch
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → select
**`dist/`**, not the package root. (The source manifest lives at
`src/manifest.json` precisely so the root cannot be selected by mistake — with a
manifest beside `package.json`, Chrome accepts the source directory and then
fails on the missing bundle.)

The extension ID is **pinned**, not assigned at load time:

```
lkjbbipgcljkefgpefbebjjjjlmoekna
```

That comes from the `key` field in `manifest.json`, which holds the *public* half
of an RSA pair. Without it Chrome derives the ID from the install path, so every
teammate gets a different one and the service's `ALLOWED_ORIGINS` needs an entry
per machine. Pinning it means one allowlist entry works everywhere, and it can
be set before the extension has ever been loaded.

The private half lives in `extension-key.pem` (gitignored). It is only needed to
pack a `.crx` under the same ID — loading unpacked does not use it. Stash it in
the team password manager; regenerating it changes the ID and breaks the
allowlist.

Click the toolbar icon to open the side panel. Paste the service URL and the
`sok_…` token from `services/outreach/scripts/create-account.ts` into Settings.

## Architecture

Three contexts, with a deliberate split of responsibility:

- **`src/content/`** — the only code that touches LinkedIn's DOM. Stateless: it
  scrapes what is on screen and returns it. Never sees the account token.
- **`src/background/`** — owns settings, all network calls, and any flow that
  spans a navigation (the enrichment pass drives the tab from here, so a page
  load cannot lose work in flight).
- **`src/panel/`** — side panel UI. Talks only to the service worker.

## Sources

| Source | Where to run it | Notes |
|---|---|---|
| Post likers | A post permalink page | Warmest cold source — they engaged with your content already |
| Post commenters | A post permalink page | Warmer still; comments paginate rather than infinite-scroll |
| Search results | A people-search results page | Coldest source, capped low by default |
| My connections | `/mynetwork/invite-connect/connections/` | Pool for message-only sequences |

Scraping only yields name, headline, and profile URL. The **enrichment** pass
then visits profiles one at a time to collect role, company, location, and
recent activity — that is the only context the copy generator is permitted to
reference, which is what stops it inventing details about real people.

## Verifying selectors

`src/content/selectors.ts` is the only file allowed to contain a LinkedIn CSS
selector, and it is the file that will rot. Two things keep that manageable:

1. **Every target is a list of candidates**, tried in order. Semantic anchors
   (`href` shape, `aria-label`, `role`) come first because they survive a
   restyle; branded class names are last, as hints.
2. **A miss throws rather than returning nothing.** The failure mode that must
   never happen quietly is a scrape that "succeeds" with zero results — it is
   indistinguishable from an empty list until a campaign has been dead for a
   week. Misses surface in the panel, and land in `scrape_runs` server-side.

The **Health** tab reports which targets match on the currently open tab. Run it
against a post permalink, a search results page, and the connections page after
any LinkedIn UI change. Note that not every target applies to every page, so a
red row is a prompt to look, not proof of a regression.

Person extraction itself (`src/content/people.ts`) deliberately does *not* match
card classes. It anchors on `a[href*="/in/"]` — the one thing LinkedIn cannot
restyle away — and works outward. Every class hint in that file can vanish and
extraction still returns a name and a URL.

## Pacing

All page interaction goes through `src/content/human.ts`. Scroll rounds pause
0.9–2.2s, discrete actions 1.8–4.2s, and profile visits 4–9s apart. Scraping
fast is the single easiest way to get an account restricted, and none of this
work is urgent enough to be worth that.

## Tests

`npm test` covers the DOM-free helpers (text cleaning, name derivation). The DOM
walk can only be verified against live markup — use the Health tab for that.

## Status

Phase 1 (sourcing + enrichment) is complete. Sending is **not** implemented:
there is no invite or message action in this codebase yet. Phases 2–4 add copy
generation with an approval queue, the paced executor with per-account caps, and
reply detection.
