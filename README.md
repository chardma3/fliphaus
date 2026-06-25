# FlipHaus

AI-powered digital investment platform for co-investing in renovation-based apartment flips in Stockholm. Uses a SPV-per-property model where investors receive a fixed, market-linked return, builders receive a performance bonus, and FlipHaus manages the full renovation cycle with AI-driven property selection.

## How it works

1. **AI identifies property** — scrapes Hemnet, analyses photos and floorplans for renovation potential
2. **Builder reviews and accepts** — inputs timeline + 1-month buffer, cost structure
3. **Inspector confirms feasibility** — pre-purchase verification
4. **SPV opens for investor funding** — escrow partner holds funds
5. **Renovation executes** — mid-project inspector check
6. **Property sold** — investors receive capital + ROI, builder gets bonus, FlipHaus takes profit share

## AI renovation analysis

Listing photos are analysed by Anthropic Claude (vision) in a two-stage pipeline (`api/analyze.js`), not by hardcoded colour/appliance heuristics:

1. **Triage (cheap, every photo)** — `TRIAGE_MODEL` (default `claude-haiku-4-5`) classifies each photo by room type and judges whether the kitchen and bathroom look original or already renovated (cabinet fronts and worktops first, not sink material). If both wet rooms are already modern, the expensive scoring pass is **gated out** — there's no renovation upside to score.

2. **Renovation scoring** — `ANALYSIS_MODEL` (default `claude-haiku-4-5`, override to `claude-sonnet-4-6` via env for stronger scoring) scores 1–10 (higher = more original/more upside), with a room-by-room breakdown, an estimated renovation cost, and a confidence flag. A score ≥ `DEAL_MIN_SCORE` (7) is a "strong flip" — both wet rooms need work.

**Photo curation & coverage.** A fresh scrape only stores ~5 Hemnet search-card thumbnails, which usually omit the bathroom. Before scoring, the analyser hydrates the full detail-page gallery (`api/listing-gallery.js`), curates a wet-rooms-first set (≤ `MAX_DISPLAY_IMAGES`) to persist, and records `kitchenPictured`/`bathroomPictured` measured against the *persisted* photos. A listing whose bathroom couldn't be fetched (Hemnet bot-block) keeps `bathroomPictured: false` and is re-tried by the coverage self-heal sweep (see below); its card is flagged "score provisional" until the wet room is actually seen.

Both model ids are environment-overridable, so the whole pipeline can be made cheaper (Haiku) or stronger (Sonnet) without a redeploy.

## Financial model (base case)

| Item | Amount |
|------|--------|
| Apartment price | 2,500,000 SEK |
| Deposit | 500,000 SEK |
| Renovation | 250,000 SEK |
| Sale uplift | 200,000 SEK |
| Investor ROI (6 months) | 5.125% (25,625 SEK) |
| Builder bonus | 10,000 SEK |
| Inspector cost | 12,000 SEK |
| FlipHaus profit | ~152,375 SEK |

## Revenue streams

- SPV profit share
- Subscription tiers (premium investor access & analytics)
- Data licensing (to brokers, banks, insurers)
- White-label API (partner banks)
- Secondary share marketplace (future)

## Tech stack

- **Runtime / API:** Node.js 20, Express 5 — a single always-on web service (hosted on Render) that also serves the static frontend.
- **Database:** MongoDB Atlas via Mongoose; sessions stored in Mongo (`express-session` + `connect-mongo`).
- **AI:** Anthropic Claude via `@anthropic-ai/sdk` — Haiku triage + Haiku/Sonnet renovation scoring (model ids env-overridable).
- **Scraping:** Puppeteer + `puppeteer-extra-plugin-stealth`, routed through a Sweden residential proxy (Cheerio for light HTML parsing).
- **Scheduling:** GitHub Actions for the daily heavy jobs; a lightweight in-process loop for the 5-minute coverage self-heal.
- **Auth:** Passport — Google OAuth 2.0 + email/password (bcrypt); token magic-links for builders. Role-based routing (admin / investor / builder).
- **Frontend:** Server-served static HTML/CSS/vanilla-JS (no framework); Leaflet/OpenStreetMap for maps.
- **Tests:** Node's built-in `node --test`; pure-function unit tests (no DB/network), run with `npm test`.

## Backend architecture

Express app (`server.js`) + ~22 focused modules under `api/`. The heavy lifting is split into three pipelines that all share one MongoDB and one process-wide job lock.

### Models (`models/`, plus `api/listing.model.js`)
`listing` (active/disappeared/sold lifecycle, score, photos, coverage flags), `sold` (slutpriser comparables), `scrapeRun` (one row per scrape/analysis run actually performed — the audit log behind the dashboard's *Completed scrapes* list), `user`, `builder`, `assignment`, `proposal`, `investment`, `preference`.

### 1. Scraping pipeline
`api/scrape.js` (active listings) and `api/scrape-sold.js` (final sale prices) drive Puppeteer through the residential proxy. `api/hemnet-refresh-safety.js` is the safety + targeting layer: it holds `LOCATION_IDS` (the live areas), splits the active scrape into staggered batches (`getAreaBatch`), refuses to persist a zero/bot-blocked scrape, and scopes disappearance reconciliation to areas that actually scraped. The expansion backlog and per-area filters live in `api/area-priority.js`.

### 2. Analysis pipeline
`api/analyze.js` (the two-stage Claude pipeline above) + `api/analyze-refresh.js`, which selects which listings to (re)analyse: new/unscored listings, a bounded **self-heal** retry for listings missing a wet-room photo, a targeted single-listing re-score, and a one-shot deals re-score for prompt rollouts. `api/image-selection.js` curates the persisted photo set; `api/brf-intelligence.js` / `api/area-intelligence.js` add BRF debt + renovated-vs-unrenovated sold-comp signal.

### 3. Feed
`api/listings-query.js` builds the active-feed Mongo query, split into views — **deals** (score ≥ 7), **move-in ready** (1–6), **sitting** (long on market), **new builds** (projekt listings) — and applies the active per-area filters (price cap, comps-only). `api/listing-presenter.js` / `api/profitability.js` shape the investment maths per listing.

### Scheduling & concurrency
- **GitHub Actions** runs the daily heavy work: three staggered active-scrape batches + a sold/analysis/reconcile refresh (see *Data refresh pipeline* below).
- The **in-process nightly scheduler** (`api/scheduler.js`) is intentionally **off** in production (`ENABLE_SCHEDULER` unset) — GitHub Actions already does that work, and running it in-process too would double-scrape.
- The **coverage self-heal sweep** *is* in-process (`ENABLE_COVERAGE_SWEEP=true`): every `COVERAGE_SWEEP_MINUTES` (default 5) it re-hydrates and re-scores listings still missing a displayed wet room, so a bathroom-blind deal is corrected in minutes rather than the next day.
- **`api/job-lock.js`** is a process-wide mutex shared by every Puppeteer job (HTTP `/api/scrape`, `/api/analyze-images`, and the sweep) so two headless Chromium sessions never run at once on the single instance — the sweep defers to any in-flight scrape and retries on its next tick.

## Scale plan

Launch in Sweden → expand to Australia, UK, Portugal, Netherlands.

## Data refresh pipeline

FlipHaus depends on fresh Hemnet data for property selection, renovation analysis, and sold-market evidence. The front-end health banner and `/api/scrape-health` endpoint should be checked whenever the dashboard looks wrong.

### Scheduled refresh

The active scrape is split across **three staggered GitHub Actions workflows** (`scrape-batch-{1,2,3}.yml`) so a single `/api/scrape?batch=N` request stays well under Hemnet's ~100s Cloudflare edge timeout as areas grow. Each batch also reconciles its own areas' disappearances, so withdrawals are caught same-day.

| Workflow | Cron (UTC) | Stockholm (CEST) | Does |
|----------|-----------|------------------|------|
| `scrape-batch-1.yml` | `0 11`  | 13:00 | Active listings, batch 1/3 |
| `scrape-batch-2.yml` | `25 11` | 13:25 | Active listings, batch 2/3 |
| `scrape-batch-3.yml` | `50 11` | 13:50 | Active listings, batch 3/3 |
| `refresh-fliphaus.yml` | `20 12` | 14:20 | Sold prices + image analysis + sold reconciliation (runs **after** the batches) |

All workflows use the `FLIPHAUS_REFRESH_URL` and `FLIPHAUS_REFRESH_TOKEN` GitHub secrets. Do not commit token values.

`refresh-fliphaus.yml` steps:

1. `/api/scrape-sold?area=Farsta&detailLimit=5&includeDetails=false&includeAnalysis=false` refreshes Farsta sold comparables.
2. A looped step refreshes sold comparables for every other live area (Kista, Bagarmossen, …, Östermalm, Södermalm, Finntorp, Ektorp, Sickla), tolerating per-area blocks. The loop is the single source — add an area to `LOCATION_IDS` *and* to this loop.
3. `/api/analyze-images?dataset=all&limit=10` scores newly-scraped photos and runs the bounded self-heal (separate post-scrape step, see below).
4. `/api/reconcile-sold` confirms disappeared dashboard listings only when they match scraped sold records strongly enough.

The sold scrape is intentionally split by area and capped at a low `detailLimit` per request to keep each HTTP request short and avoid Render/GitHub/Cloudflare timeouts. (Rissne was dropped as an area — thin owner-occupier resale; it must not be scraped.)

### Run history — every scrape that actually ran (not just the schedule)

**What it is.** The table above is the *schedule* — what is *meant* to run. Separately, the dashboard's *Completed scrapes (most recent first)* list and `/api/scrape-health` (`recentRuns`) show every scrape/analysis that the server *actually performed*: timestamp, label (e.g. "Active listings — batch 2 of 3"), outcome status (✓ success / ⚠ partial / ✗ failed), and a one-line result summary (listings found, sold added, photos analysed, or the error).

**How it works.** Each of the three refresh endpoints — `/api/scrape`, `/api/scrape-sold`, `/api/analyze-images` (`server.js`) — records one row to a `scrapeRun` collection (`api/scrape-run.model.js`) when it finishes, capturing start time, duration, status and the endpoint's own result object. Recording is **best-effort**: `recordScrapeRun()` swallows its own errors so a logging hiccup can never fail or slow a scrape that already succeeded. `/api/scrape-health` reads back the 20 most recent rows via `getRecentScrapeRuns()`. Because every run logs itself regardless of trigger, the list is **trigger-agnostic** — it captures GitHub Actions batches, a manual `curl`, and the in-process scheduler identically. Note it records runs *going forward*: scrapes from before this was deployed were never logged, so the history fills in from first run after deploy.

**Why we built it.** Previously the panel rendered only the static schedule plus one "last updated" timestamp, so it looked like a single scrape — there was no way to see whether each staggered batch fired, whether an area was blocked, or how many listings/sold/photos a run actually returned. Operationally, "is the data fresh?" was answerable but "did batch 3 run and what did it find?" was not — that lived only in GitHub Actions logs, off the dashboard. The run log puts that on the dashboard.

**Why this technology / why not the alternatives.** It reuses the stack already in place — Mongoose on the existing MongoDB Atlas connection — so there is no new service, dependency, or credential. Two alternatives were considered and rejected:

- **Query the GitHub Actions API on each health check.** That is GitHub's own run record, but it adds an external API call (latency + rate limits + a stored token) to a frequently-polled endpoint, and it only ever sees GitHub-triggered runs — not a manual `curl` or the in-process scheduler. The dashboard is meant to reflect what *the server did*, which a self-written log captures directly.
- **Derive run history from listings' `lastSeenAt` timestamps.** No extra writes, but it is an expensive, approximate read (clustering thousands of timestamps into "runs") and structurally **cannot** represent a *failed* run, a *sold*-scrape, or a *photo-analysis* run — those don't touch `lastSeenAt`. It would under-report exactly the events you most want to see.

**Why this is the efficient choice.** Write volume is ~4 rows/day (one per scheduled run) — a single indexed insert each, negligible against the scrape work itself. A single index on `startedAt` does double duty: it is both the TTL that auto-expires rows after 180 days (MongoDB prunes in the background, so the collection never grows unbounded — ~720 rows at steady state) **and** the sort key for the limit-20 read, so the dashboard query is an indexed descending scan with no in-memory sort. There are deliberately **no** per-field indexes on `job`/`status` because nothing queries by them yet — adding unused indexes would only tax every write. If run analytics are wanted later (e.g. success rate per batch over 30 days), the collection is already the right shape to aggregate over.

### Continuous coverage self-heal (in-process, not GitHub Actions)

Independently of the daily workflows, the always-on web service runs the coverage sweep every `COVERAGE_SWEEP_MINUTES` (default 5) when `ENABLE_COVERAGE_SWEEP=true`. It re-hydrates and re-scores listings still missing a displayed kitchen/bathroom — the bot-block tail — so a bathroom-blind deal self-corrects in minutes. It defers to any in-flight scrape via the shared job lock, and its last run is visible at `/api/scrape-health` (`coverageSweep.lastRun`) alongside the daily-scrape schedule and a "ran today" flag. Keep `ENABLE_SCHEDULER` **off** (GitHub Actions owns the daily scrape); the sweep has its own flag.

A single stuck deal can be force-corrected without the sweep by re-running the **Reanalyse deals (manual)** workflow, or `GET /api/analyze-images?dataset=active&target=<hemnet-id-or-slug>`.

Longer-term architecture note: if Hemnet scraping continues to exceed HTTP/proxy time limits even after area splitting and lower `detailLimit` values, move the actual browser scraping into a background worker/queue. In that model the HTTP endpoint should enqueue a refresh job and return quickly, while the worker updates MongoDB and exposes job status separately.

### Prototype proxy setup for Hemnet bot protection

Fresh prototype/demo listings may require routing Puppeteer through a residential proxy because Hemnet can block Render/cloud datacenter IPs with Cloudflare security verification.

The scraper supports these Render environment variables:

- `HEMNET_PROXY_SERVER` — proxy host URL, for example `http://host:port` or `http://gate.provider.example:7000`
- `HEMNET_PROXY_USERNAME` — proxy username, if the provider requires authentication
- `HEMNET_PROXY_PASSWORD` — proxy password, if the provider requires authentication

Do not commit proxy credentials. Add them only in Render service environment variables.

Recommended setup:

1. Choose a residential proxy or scraping-browser provider with Sweden/Stockholm residential exits.
2. In Render, open the FlipHaus web service.
3. Go to Environment.
4. Add `HEMNET_PROXY_SERVER`, `HEMNET_PROXY_USERNAME`, and `HEMNET_PROXY_PASSWORD` using the provider values.
5. Save changes and let Render redeploy.
6. Manually run the GitHub Actions workflow `Refresh FlipHaus data`.
7. Check the workflow logs. A successful active scrape should return a JSON body like `Scrape complete` with a non-zero `total`.
8. Check `/api/scrape-health` and confirm the active `lastScrapeDate` moved to today.

Known working Smartproxy shape for the prototype:

- `HEMNET_PROXY_SERVER`: `http://eu.smartproxy.net:3120`
- `HEMNET_PROXY_USERNAME`: Smartproxy-generated username with Sweden/Stockholm targeting, for example a value containing `_area-SE_city-STOCKHOLM`
- `HEMNET_PROXY_PASSWORD`: Smartproxy password

Do not use `proxy.eu.smartproxy.net`; that host may not resolve. Do not put the username or password inside `HEMNET_PROXY_SERVER` when separate username/password environment variables are configured.

Before running the full workflow, test the proxy inside Render Web Shell without exposing secrets:

```bash
curl -sS --max-time 25 -x "$HEMNET_PROXY_SERVER" -U "$HEMNET_PROXY_USERNAME:$HEMNET_PROXY_PASSWORD" "https://api.ipify.org?format=json"
```

Then test what Hemnet serves to Puppeteer:

```bash
node - <<'NODE'
const puppeteer = require('puppeteer');
const { buildPuppeteerLaunchOptions, authenticateProxyPage } = require('./api/puppeteer-options');

(async () => {
  const browser = await puppeteer.launch(buildPuppeteerLaunchOptions());
  try {
    const page = await browser.newPage();
    await authenticateProxyPage(page);
    await page.goto('https://www.hemnet.se/bostader?location_ids%5B%5D=18031', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    console.log('TITLE:', await page.title());
    console.log('HAS NEXT_DATA:', await page.evaluate(() => !!document.querySelector('#__NEXT_DATA__')));
    console.log('BODY PREVIEW:', await page.evaluate(() => document.body.innerText.slice(0, 2000)));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
```

If the title is `Just a moment...` and `HAS NEXT_DATA` is `false`, the proxy is connected but Hemnet is still showing bot protection. If the title is a real Hemnet page and `HAS NEXT_DATA` is `true`, run the workflow.

The scheduled workflow calls `/api/scrape?includeDetails=false` for the active refresh. This updates active listings quickly from Hemnet search result pages and skips slower detail-page work so GitHub Actions can continue to the sold comparable-property steps. The scheduled sold refreshes also use `includeDetails=false&includeAnalysis=false` with small per-area requests; run richer sold refreshes manually if detail-page enrichment is needed. Each scheduled scrape request has a five-minute curl timeout and retries twice because residential proxy exits can occasionally receive Hemnet bot-protection pages.

Image analysis is deliberately a separate post-scrape step: `/api/analyze-images?dataset=all&limit=10`. It analyses photos already saved in MongoDB, so it does not keep a Puppeteer browser open or actively scrape Hemnet while the AI model is working. The workflow marks this step `continue-on-error: true`, so a temporary model/API failure does not make the core scrape look failed or stale.

Cost note: this should not require a new paid Render service, but the residential proxy/scraping provider itself is usually paid, and the separate image-analysis step uses the configured AI vision API. The scheduled workflow keeps that to a small batch of 10 items per run.

### Safety rules

The scraper must fail loudly rather than silently corrupting data:

- If Hemnet serves a Cloudflare/security-verification/bot-protection page, the API returns an error with a clear detail message.
- If a Hemnet page is missing `__NEXT_DATA__`, the API returns an error instead of parsing an empty result.
- If the active-listing scrape produces zero listings, FlipHaus refuses to persist the result. This prevents a blocked scrape from marking existing active listings as `disappeared`.
- Missing active listings are marked `disappeared`, not `sold`. They become `confirmed_sold` only after `/api/reconcile-sold` finds a strong sold-listing match.

### Scrape resilience (retry + rotation)

The residential proxy pool is mixed: some exits are datacenter IPs that Hemnet blocks with Cloudflare bot-protection, and the provider can't guarantee a residential IP per request. The scraper therefore retries each area up to `SCRAPE_MAX_AREA_ATTEMPTS` times (default 6), and because every request draws a fresh proxy exit, a block is usually cleared by simply retrying until a residential IP is drawn. So a transient datacenter-exit block is self-healing — it is **not** a persistent failure. An area only lands in `failedAreas` if it is still blocked after all attempts.

### Listing lifecycle and why disappeared listings are kept, not deleted

```
active ──(absent from a complete scrape)──▶ disappeared ──(matches a slutpris)──▶ confirmed_sold
```

- The active feed (`/api/listings`) returns **only `status: "active"`**. A listing that left Hemnet (`disappeared`/`removed`/`sold`/`confirmed_sold`) is hidden from the buyable feed — but **retained in the database, not deleted**.
- Retention is deliberate: `disappeared` listings are the input to `/api/reconcile-sold`, which matches them to scraped final-sale prices and promotes them to `confirmed_sold`. The `/api/sold` page is built from `confirmed_sold`/`sold` listings. So a removed listing we scored becomes the record of *what it actually sold for* — the evidence that validates our renovation-upside calls. Deleting on disappearance would break that learning loop and the sold view. (A hard purge, if ever wanted, belongs in a later retention job after a listing has been `confirmed_sold` and aged out — never at the moment it disappears.)
- **Disappearance detection is twofold.** Per-run reconciliation (mark anything absent this run as `disappeared`) runs only after a *complete* scrape — if any area failed, it is skipped to avoid falsely marking the unseen area's listings as gone. Because a complete scrape isn't guaranteed, a **staleness safety net** also marks any `active` listing unseen for more than `DISAPPEARED_AFTER_DAYS` (default 14) as `disappeared`, regardless of partial scrapes. It is self-correcting: a real listing in a temporarily-failing area is re-marked `active` by the next successful scrape.
- **Same street address is expected, not a duplicate.** A building can hold dozens of apartments at one address. Listings are de-duplicated by Hemnet listing `id` only (never by address), so every distinct apartment is kept. A re-listed apartment gets a new Hemnet `id`; the old `id` becomes `disappeared` and the new one is `active`.

### Operational checks

Use `/api/scrape-health` to inspect:

- active listing count and latest active scrape date
- sold comparable-property count and latest sold scrape date
- stale flags for each dataset separately
- `recentRuns` — the last 20 scrape/analysis runs that actually executed, with per-run status and result counts (see *Run history* above)

If data is stale and GitHub Actions failed:

1. Open the failed GitHub Actions run and identify which endpoint failed.
2. If the error mentions Hemnet bot protection or missing `__NEXT_DATA__`, the source site blocked or changed the scraper; do not trust zero-result data.
3. If the error is `524` or a long timeout on `/api/scrape-sold`, keep the area-split workflow and lower `detailLimit` further.
4. Re-run the workflow manually only after checking that the source site is reachable.

## Setup

```bash
npm install
cp .env.example .env  # fill in MONGO_URI, Google OAuth creds, SESSION_SECRET, REFRESH_TOKEN
npm start
```
