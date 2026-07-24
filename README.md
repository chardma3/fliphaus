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

2. **Renovation scoring** — `ANALYSIS_MODEL` (default `claude-sonnet-4-6`; Haiku's scores were too weak, so the scorer was upgraded — bump to `claude-opus-4-8` via env for the strongest vision if Sonnet isn't enough) scores 1–10 (higher = more original/more upside), with a room-by-room breakdown, an estimated renovation cost, and a confidence flag. A score ≥ `DEAL_MIN_SCORE` (6) is a "strong flip" — both wet rooms need work.

**Photo curation & coverage.** A fresh scrape only stores ~5 Hemnet search-card thumbnails, which usually omit the bathroom. Before scoring, the analyser hydrates the full detail-page gallery (`api/listing-gallery.js`), curates a wet-rooms-first set (≤ `MAX_DISPLAY_IMAGES`) to persist, and records `kitchenPictured`/`bathroomPictured` measured against the *persisted* photos. A listing whose bathroom couldn't be fetched (Hemnet bot-block) keeps `bathroomPictured: false` and is re-tried by the coverage self-heal sweep (see below); its card is flagged "score provisional" until the wet room is actually seen.

Both model ids are environment-overridable, so the worker (triage) and architect (scoring) can be retuned independently — cheaper (Haiku) or stronger (Sonnet → Opus) — without a code change.

**Manual re-score.** Each Deals / Move-in ready card has an admin-only **Reanalyze (Opus)** button (`POST /api/admin/reanalyze/:id`, session-auth + admin role) that re-scores a single listing with `claude-opus-4-8` — bypassing the triage gate and re-fetching the full gallery — to correct a listing the default Sonnet pass scored or classified wrong. The override is per-request and allowlisted, so Sonnet stays the everyday default with no env change.

## Profit estimate

Each scored listing's ROI is estimated from **real sold comparables**, not a hardcoded benchmark. `api/brf-intelligence.js` takes the trailing-12-month sold `kr/m²` for the same BRF (or the same area if there's no BRF match) and uses the **75th percentile** as the renovated-resale level — renovated flips sell near the top of the local range, so this needs no per-comp renovated/unrenovated tagging. Confidence scales with the number of comparables (same-BRF ≥ 4, or area ≥ 12 → high); `profitability.js` only falls back to the per-area benchmark (flagged "preliminary") when too few comps exist. Sub-area labels like "Södermalm - Sofo" are mapped to their parent scraped area, and comps are matched on each sale's real `locationDescription` rather than the broad search catchment it was scraped under. `scripts/diagnose-estimate-backing.js` (read-only) reports, per area, how many listings are sold-comp-backed vs still on the benchmark.

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
- **AI:** Anthropic Claude via `@anthropic-ai/sdk` — Haiku 4.5 triage (worker) + Sonnet 4.6 renovation scoring (architect); model ids env-overridable.
- **Scraping:** Puppeteer + `puppeteer-extra-plugin-stealth`, routed through a Sweden residential proxy (Cheerio for light HTML parsing).
- **Scheduling:** a dedicated **Render Cron Job** runs the daily scrape on its **own instance** (`scripts/scheduled-scrape.js`), separate from the web service so scraping never blocks the app. (GitHub Actions is no longer used for scraping.)
- **Auth:** Passport — Google OAuth 2.0 + email/password (bcrypt); token magic-links for builders. Role-based routing (admin / investor / friend / builder), enforced server-side (`requireAdmin` on every `/api/admin/*` route).
- **Frontend:** Server-served static HTML/CSS/vanilla-JS (no framework); Leaflet/OpenStreetMap for maps. The listing card — its markup, styles and money/text formatters — is one shared module (`card.js`, exposing `window.FlipCard`, + `card.css`) that both the dashboard (`index.html` / `/friends`) and the favorites page (`favorites.html`) render from, so the two can't drift; `profitability.js` (also used server-side) supplies the investment maths.
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
`api/listings-query.js` builds the active-feed Mongo query, split into views — **deals** (score ≥ `DEAL_MIN_SCORE`, currently 6), **move-in ready** (1 .. `DEAL_MIN_SCORE`-1), **sitting** (on the market ≥ `SITTING_MIN_DAYS`, currently 14), **new builds** (projekt listings) — and applies the active per-area filters (price cap, comps-only). The views are **mutually exclusive** with a strict precedence — **Sitting > Deals > Move-in ready** — so a listing surfaces in exactly one tab: an aged listing shows under Sitting only (both flip views exclude anything past the sitting cutoff), and non-sitting flips split by score. `api/listing-presenter.js` / `api/profitability.js` shape the investment maths per listing.

**District labels come from `locationDescription`, not the scrape `area`.** A Hemnet `location_id` is a broad *catchment*, not a tidy district — the Östermalm node (473448), for instance, also returns listings in Gärdet, Kungsholmen, Vasastan and even Saltsjöqvarn (Nacka kommun). `api/scrape.js` stamps every listing a node returns with that node's name in the `area` field, so `area` is only a coarse **sourcing bucket**. The *real* per-listing district is the first part of Hemnet's `locationDescription` (e.g. `"Gärdet, Stockholms kommun"` → *Gärdet*), and that is what every per-listing surface shows — the cards (`card.js`), investor and listing-detail pages, the sold/market tables, and (since PR #128) the *Last 24h* daily digest. The coarse `area` bucket is still used for the **aggregate** stats/filters on the Areas and Sold pages (so e.g. "Östermalm" market stats include some Kungsholmen/Nacka sales) and for the per-area price caps — re-bucketing those by real district is a known, larger follow-up.

**Estimates are precomputed, not crunched per request.** Each listing's sold-comp estimate (`brfIntelligence`) is computed **once** — at the end of the daily refresh and on manual reanalyse (`api/precompute-estimates.js`) — and stored on the listing with a `brfIntelligenceAt` stamp. The feed serves that stored value and only falls back to a live crunch when a listing hasn't been precomputed yet (new/just-scored), so in steady state the feed **never loads the sold collection at all**. Previously it loaded and re-indexed the entire ~9,500-row sold set (`SoldListing.find({})` + `buildSoldIndex`) on *every* request; that per-request memory spike is what collided with the daily scrape and hung the app. Freshness is guaranteed because the recompute runs immediately after the sold data updates — see *Data refresh pipeline*. `/api/scrape-health` reports precomputed-estimate freshness; `scripts/diagnose-precomputed-estimates.js` is the read-only check.

**Bounded sold collection.** Every consumer of sold data uses at most ~12 months of history, so `api/prune-sold.js` (via `POST /api/prune-sold`, dry-run by default) drops rows older than `SOLD_RETENTION_MONTHS` (default 15) to keep the collection from growing without limit. Sold reads for comps also project away the large unused `images[]` arrays (`SOLD_COMP_FIELDS`).

### Dashboard tiers (who sees what)

Three role-scoped surfaces sit on top of the same data, plus the builder portal:

| Role | Lands on | Sees | Can do |
|------|----------|------|--------|
| **admin** (Claire) | `/` (`index.html`) | Everything: all sections, the *Completed scrapes* activity log, BRF/area intelligence | Reanalyse (Opus) on **every** listing, Send to builders, invite/assign builders, **share listings with friends**, **manage friend access** |
| **investor** | `/invest` (`investor.html`) | Builder-accepted listings with funding maths | Invest / fund |
| **friend** (family) | `/friends` (`index.html` in *friends mode*) | **Read-only** view of only the listings the admin has **shared**, across all four sections, with the internal score/profit **filter bars hidden** (PR #127); prices in **AUD** as well as SEK; a slim cross-page nav to Areas / How it works / Market / Glossary | Nothing — view only |
| **builder** | `/builder` (magic-link) | Listings assigned to them | Submit renovation proposals |

- **Admin-only actions are enforced server-side.** `requireAdmin` (`server.js`) gates every `/api/admin/*` route (reanalyse, builder invite/assign, listing share, user-role changes) — previously they were only `requireAuth`, so any logged-in user could have called them. The scraping activity log and the admin action buttons live on the admin dashboard only; a logged-in non-admin who hits `/` is redirected to their own view.
- **Friends see a curated set, not the whole feed.** The admin picks which listings friends see with a ☆ **Share with friends** toggle on each card (`POST /api/admin/listings/:id/share` sets a `sharedWithFriends` flag). The friends `/api/listings` path passes `sharedOnly` so **every** view (deals / move-in ready / sitting / new builds) is intersected with the shared set — friends browse the same sections, but only the properties the admin hand-picked. (Phase 2, later: choose *which* friend each listing goes to.)
- **Friend access is managed in-app, not in env.** The admin promotes signed-up users on the **Friends access** page (`/manage-friends`, admin-only): `GET /api/admin/users` lists everyone, `POST /api/admin/users/:id/role` flips a user between `investor` and `friend` (admins can't be re-roled → no lockout). `api/roles.js` `syncUserRole` is **promote-only** — the legacy `FRIEND_EMAILS` env allowlist can still lift an investor to friend on login as a convenience, but login **never demotes**, so a manual promotion sticks. Flow: a friend signs up (lands as investor) → admin flips them to friend → they get `/friends`. Friend-appropriate pages (Areas / How it works / Market / Glossary) swap their admin nav for the slim friend nav when the logged-in user is a friend.
- **SEK → AUD** for the friends view comes from `api/fx.js` (`/api/fx/sek-aud`): a daily rate from Frankfurter (free, no key), cached in-process for 24h, degrading to the last good rate and then a fixed fallback (`FALLBACK_SEK_AUD`) so the page never shows a broken figure.

### Scheduling & concurrency
- **Scraping runs on a separate Render Cron Job** (`scripts/scheduled-scrape.js`), on its **own instance** — not the web service — so a scrape can never starve the app. See *Data refresh pipeline* below.
- The **in-process nightly scheduler** (`api/scheduler.js`, `ENABLE_SCHEDULER`) stays **off** in production — the cron worker owns the daily scrape, so running it in-process too would double-scrape.
- The **coverage self-heal** used to run in-process on the web service (`ENABLE_COVERAGE_SWEEP`, hourly). It now runs on the cron worker as a bounded stage (`SCRAPE_SELFHEAL_ROUNDS` × `SCRAPE_ANALYZE_LIMIT` active re-hydration passes/day), so `ENABLE_COVERAGE_SWEEP` can be left **off** and the web service runs **no** Puppeteer at all. (It still skips the model call when Hemnet returns no richer gallery, and drains bot-blocked listings after `MAX_HYDRATION_ATTEMPTS`.)
- **`api/job-lock.js`** is a process-wide mutex for the on-demand Puppeteer endpoints on the web service (`/api/scrape`, `/api/analyze-images`, the admin *Reanalyze* button) so two headless Chromium sessions never run at once. The daily pipeline no longer competes for it — it's on the separate cron instance.

## Scale plan

Launch in Sweden → expand to Australia, UK, Portugal, Netherlands.

## Data refresh pipeline

FlipHaus depends on fresh Hemnet data for property selection, renovation analysis, and sold-market evidence. The front-end health banner and `/api/scrape-health` endpoint should be checked whenever the dashboard looks wrong.

### Scheduled refresh (the Render cron worker)

The daily refresh is a single standalone script, **`scripts/scheduled-scrape.js`**, run by a **Render Cron Job** on its own 2 GB instance (schedule `0 11 * * 1-5` UTC ≈ 13:00 Stockholm, weekdays). It calls the scrape functions **directly** (no HTTP), so none of the per-request Cloudflare/Render timeouts apply and it scrapes all areas in one pass. Because it's a different instance from the web service, the app stays fully responsive no matter how long a scrape takes.

Stages, in order (each isolated — a failure records `failed` but never aborts the rest, and each writes a `scrapeRun` row so `/api/scrape-health` shows it, labelled *"… — all areas"*):

1. **Active listings — all areas** (+ per-area disappearance reconciliation).
2. **Sold prices — all areas** (+ sold reconciliation, built into the sold scrape).
3. **Photo analysis & scoring** — one `dataset:"all"` pass (new active + sold).
4. **Gallery self-heal (active)** — bounded `SCRAPE_SELFHEAL_ROUNDS` × `SCRAPE_ANALYZE_LIMIT` re-hydration passes; replaces the old web-box coverage sweep.
5. **Precompute resale estimates** — rebuilds every active listing's stored sold-comp estimate from the fresh data, so the feed serves it without crunching.

Human-like **jittered pacing** (`api/scrape-pacing.js`, env-tunable: `SCRAPE_AREA_DELAY_MS`, `SCRAPE_RETRY_BASE_MS`, `SOLD_PAGE_DELAY_MS`, `SOLD_DETAIL_DELAY_MS`) spaces requests out to trip Hemnet's Cloudflare bot detection less. (Rissne was dropped as an area — thin owner-occupier resale; it must not be scraped.)

**Render setup** (defined in `render.yaml`; the live job was created manually so don't re-apply the Blueprint):
- Build: `npm install && npx puppeteer browsers install chrome`
- Env: `PUPPETEER_CACHE_DIR=/opt/render/project/src/.cache/puppeteer` + the same secrets as the web service (`MONGO_URI`, `ANTHROPIC_API_KEY`, `HEMNET_PROXY_*`, optional `ANALYSIS_MODEL`/`TRIAGE_MODEL`).
- Modes: `node scripts/scheduled-scrape.js` (full) · `active` · `sold`.

**GitHub Actions** has been removed entirely — the repo has no workflows. Scraping runs on the Render cron worker; the previously-manual operations (precompute, prune-sold, reanalyse-deals) are folded into that nightly run or remain available as web-service endpoints you can `curl` on demand: `/api/precompute-estimates`, `/api/prune-sold`, `/api/analyze-images`.

### Run history — every scrape that actually ran (not just the schedule)

**What it is.** The table above is the *schedule* — what is *meant* to run. Separately, the dashboard's *Completed scrapes (most recent first)* list and `/api/scrape-health` (`recentRuns`) show every scrape/analysis that the server *actually performed*: timestamp, label (e.g. "Active listings — all areas", "Photo analysis & scoring"), outcome status (✓ success / ⚠ partial / ✗ failed), and a one-line result summary (listings found — with an **N/N-areas coverage tally** on the active scrape, so a clean run reads `22/22 areas` and a blocked one names the failed areas (PR #126) — sold added, photos analysed, or the error).

**How it works.** Each of the three refresh endpoints — `/api/scrape`, `/api/scrape-sold`, `/api/analyze-images` (`server.js`) — records one row to a `scrapeRun` collection (`api/scrape-run.model.js`) when it finishes, capturing start time, duration, status and the endpoint's own result object. Recording is **best-effort**: `recordScrapeRun()` swallows its own errors so a logging hiccup can never fail or slow a scrape that already succeeded. `/api/scrape-health` reads back the 20 most recent rows via `getRecentScrapeRuns()`. Because every run logs itself regardless of trigger, the list is **trigger-agnostic** — it captures the cron worker's stages, a manual `curl`, and the in-process scheduler identically. Note it records runs *going forward*: scrapes from before this was deployed were never logged, so the history fills in from first run after deploy.

**Why we built it.** Previously the panel rendered only the static schedule plus one "last updated" timestamp, so it looked like a single scrape — there was no way to see whether each staggered batch fired, whether an area was blocked, or how many listings/sold/photos a run actually returned. Operationally, "is the data fresh?" was answerable but "did batch 3 run and what did it find?" was not — that lived only in GitHub Actions logs, off the dashboard. The run log puts that on the dashboard.

**Why this technology / why not the alternatives.** It reuses the stack already in place — Mongoose on the existing MongoDB Atlas connection — so there is no new service, dependency, or credential. Two alternatives were considered and rejected:

- **Query the GitHub Actions API on each health check.** That is GitHub's own run record, but it adds an external API call (latency + rate limits + a stored token) to a frequently-polled endpoint, and it only ever sees GitHub-triggered runs — not a manual `curl` or the in-process scheduler. The dashboard is meant to reflect what *the server did*, which a self-written log captures directly.
- **Derive run history from listings' `lastSeenAt` timestamps.** No extra writes, but it is an expensive, approximate read (clustering thousands of timestamps into "runs") and structurally **cannot** represent a *failed* run, a *sold*-scrape, or a *photo-analysis* run — those don't touch `lastSeenAt`. It would under-report exactly the events you most want to see.

**Why this is the efficient choice.** Write volume is ~4 rows/day (one per scheduled run) — a single indexed insert each, negligible against the scrape work itself. A single index on `startedAt` does double duty: it is both the TTL that auto-expires rows after 180 days (MongoDB prunes in the background, so the collection never grows unbounded — ~720 rows at steady state) **and** the sort key for the limit-20 read, so the dashboard query is an indexed descending scan with no in-memory sort. There are deliberately **no** per-field indexes on `job`/`status` because nothing queries by them yet — adding unused indexes would only tax every write. If run analytics are wanted later (e.g. success rate per batch over 30 days), the collection is already the right shape to aggregate over.

### Coverage self-heal (now on the cron worker)

Listings that got bot-blocked during a scrape keep a partial gallery (missing a displayed kitchen/bathroom) — the "bot-block tail". Re-hydrating and re-scoring them is **stage 4 of the cron worker** (`SCRAPE_SELFHEAL_ROUNDS` bounded `dataset:"active"` passes per daily run). The same **cost guard** applies: when a fetch returns no richer gallery than what's stored, it skips the model call and counts the attempt, so a permanently-blocked listing drains out after `MAX_HYDRATION_ATTEMPTS` (default 4).

The old in-process web-service sweep (`ENABLE_COVERAGE_SWEEP`, every `COVERAGE_SWEEP_MINUTES`) still exists as a fallback but is meant to stay **off** in production now that the worker handles it — that keeps the web service free of Puppeteer entirely. Keep `ENABLE_SCHEDULER` **off** too (the cron worker owns the daily scrape).

A single stuck deal can be force-corrected via the admin **Reanalyze (Opus)** button or `GET /api/analyze-images?dataset=active&target=<hemnet-id-or-slug>` (curl). A prompt/model change can be rolled out to existing deals in a nightly worker run by setting `REANALYZE_DEALS_ONCE=true`.

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
2. In Render, open the **scrape cron job** (and the web service, if you use it for on-demand reanalyse).
3. Go to Environment.
4. Add `HEMNET_PROXY_SERVER`, `HEMNET_PROXY_USERNAME`, and `HEMNET_PROXY_PASSWORD` using the provider values.
5. Save changes and let Render redeploy.
6. On the cron job, click **Trigger Run** (or run `node scripts/scheduled-scrape.js active` from the Shell).
7. Check the cron job's run logs. A successful active scrape logs `✓ Active listings — all areas` with a non-zero `total`.
8. Check `/api/scrape-health` and confirm the active `lastScrapeDate` moved to today.

Known working Smartproxy shape for the prototype:

- `HEMNET_PROXY_SERVER`: `http://eu.smartproxy.net:3120`
- `HEMNET_PROXY_USERNAME`: Smartproxy-generated username with Sweden/Stockholm targeting, for example a value containing `_area-SE_city-STOCKHOLM`
- `HEMNET_PROXY_PASSWORD`: Smartproxy password

Do not use `proxy.eu.smartproxy.net`; that host may not resolve. Do not put the username or password inside `HEMNET_PROXY_SERVER` when separate username/password environment variables are configured.

Before running a full scrape, test the proxy inside Render Web Shell without exposing secrets:

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

If the title is `Just a moment...` and `HAS NEXT_DATA` is `false`, the proxy is connected but Hemnet is still showing bot protection. If the title is a real Hemnet page and `HAS NEXT_DATA` is `true`, trigger a scrape run (the Render cron job's **Trigger Run**, or `node scripts/scheduled-scrape.js`).

The cron worker scrapes active listings with `includeDetails=false` — quickly from Hemnet search result pages, skipping slower detail-page work (galleries are hydrated later by the analysis/self-heal stages). The sold scrape also uses `includeDetails=false&includeAnalysis=false` with a low `detailLimit`. Because the worker calls the functions directly (no HTTP), there's no curl/Cloudflare request timeout; per-area retries + jittered pacing handle the occasional bot-protection page.

Image analysis is deliberately a separate post-scrape step: `/api/analyze-images?dataset=all&limit=10`. It analyses photos already saved in MongoDB, so it does not keep a Puppeteer browser open or actively scrape Hemnet while the AI model is working. On the cron worker each stage is wrapped by `stage()` (records a `scrapeRun` row, never throws), so a temporary model/API failure logs as "failed" but doesn't abort the run or make the core scrape look stale.

Cost note: the scrape runs on its own Render cron instance (Standard plan for the 2 GB Chromium needs), and the residential proxy/scraping provider itself is usually paid; the separate image-analysis step uses the configured AI vision API and is kept to a small batch (`SCRAPE_ANALYZE_LIMIT`, default 10) per run.

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
- `estimates` — precomputed-estimate freshness: `precomputed` / `missing` counts over active listings and the `oldestAt` stamp. If `missing` climbs or `oldestAt` ages past a day, the daily precompute isn't running (`scripts/diagnose-precomputed-estimates.js` breaks it down per area). See *Backend architecture → Feed*.

If data is stale and the scrape failed:

1. Open the **cron job's run log** (Render → the scrape cron job → Logs / Runs) and identify which stage failed.
2. If the error mentions Hemnet bot protection or missing `__NEXT_DATA__`, the source site blocked or changed the scraper; do not trust zero-result data.
3. **`Refusing to persist zero active listings`** = the scraper got nothing from Hemnet across all areas. The guard is working — it refuses to save a zero result that would mark every listing `disappeared`, so no data is lost. Check the **residential proxy** (credit/blocked) and Cloudflare bot-blocking; ease it with the pacing env vars if needed.
4. **`Could not find Chrome`** = the cron job didn't install the browser — set Build Command to `npm install && npx puppeteer browsers install chrome` + `PUPPETEER_CACHE_DIR=/opt/render/project/src/.cache/puppeteer`, then **Clear build cache & deploy** (a plain Trigger Run won't rebuild).
5. **Trigger Run** again after checking the source site is reachable, or run `node scripts/scheduled-scrape.js active` from the cron job's Shell.

### Dashboard data endpoints (read-only, no auth)

- `/api/areas` → `{ areas: [...] }` — the live area names from `LOCATION_IDS`. The account-page area picker and the areas-page cards/intro read this, so they never drift from what's actually scraped.
- `/api/market-stats` — aggregates over ALL active listings (count, avg price, high-reno count, avg kr/m², new this week/month). Powers the areas-page "Market snapshot" (don't compute it from `/api/listings`, which returns only the ~10 deals).
- `/api/daily-digest?hours=24` — what changed in the window: new deals / move-in-ready / new builds (by `firstSeenAt`, falling back to `publishedAt` for older rows), **newly sitting** (crossed `SITTING_MIN_DAYS`), and **disappeared** (by `disappearedAt`). Powers the homepage "Last 24h" panel. Each listing is labelled by its real district (first part of `locationDescription`), not the coarse scrape `area`.
- `/api/fx/sek-aud` → `{ rate, asOf, source }` — daily-cached SEK→AUD rate (`source`: `live` | `cached` | `fallback`) used by the friends dashboard to show Australian-dollar figures.

## Setup

```bash
npm install
cp .env.example .env  # fill in MONGO_URI, Google OAuth creds, SESSION_SECRET, REFRESH_TOKEN
npm start
```

Optional env:
- `SOLD_RETENTION_MONTHS` — how many months of sold comparables to keep (default **15**). `POST /api/prune-sold` (dry-run by default) deletes sold rows older than this; every consumer uses ≤12 months, so 15 leaves a safe margin. Lower it to shrink the collection now, raise it to keep more history.
- `FRIEND_EMAILS` — **legacy/optional.** Comma-separated emails that are auto-promoted to the read-only `friend` role on login. Friend access is now managed in-app on `/manage-friends` (admin promotes signed-up users), so this env var is no longer required — it only pre-authorises an email before it signs up. Because `syncUserRole` is promote-only, removing an email here no longer demotes anyone; demote from the Friends access page instead.
