# FlipHaus Handoff

Last updated: 2026-07-31
Project path: `/Users/clairehardman/fliphaus` (the active clone — what deploys to Render)
Git remote: `https://github.com/chardma3/fliphaus.git`
Current HEAD: `5b891f7` — Fix the cast error that killed the Booli listings stage (#149)
Working tree: clean · `npm test` → **298 pass, 0 fail**

## Purpose of this file

Continuity source of truth for long FlipHaus sessions. Read this first before
searching old session history.

## Where things stand (2026-07-31)

The daily refresh is **healthy** and Booli is live as a second source for sold comps.

```
ACTIVE: 2630 listings · lastScrapeDate 2026-07-31 · ranToday true · stale false
SOLD:   9948 comps
booli-sold  2026-07-31 11:37  commit=True  harvested=175  inserted=1  merged=1  unchanged=173
```

That last row is the shape to want: the run recognises nearly everything as already
held instead of duplicating it.

### Two live things worth knowing

1. **`BOOLI_SOLD_INGEST=commit`** is set on the scrape cron service. Booli sold comps
   merge into the sold store daily. The **merged** count in `/api/scrape-health`
   (`job: "booli-sold"`) is the health signal — near-zero merges in an area we already
   scrape would mean matching is failing, not that Booli is unique.
2. **`BOOLI_LISTINGS` is NOT set yet.** The for-sale + Kommande feed is built and
   fixed but has never completed a run. Setting it to `dry` then `commit` is the next
   action (see below).

## Immediate next steps

1. **Turn on the Booli feed.** Set `BOOLI_LISTINGS=dry` on the scrape cron service,
   Trigger Run, and read `/api/scrape-health` (`job: "booli-listings"`). Expect ~70
   Årsta listings: ~47 pre-market, ~23 priced. Then `commit`.
   - Its first attempt (08:17 today) failed on a `nextShowing` cast error; fixed in
     #149 but **not yet re-run**.
2. **Judge Kommande after a fortnight** on one question: did it ever prompt Claire to
   contact an agent? If not, set `BOOLI_LISTINGS` back to `dry`/unset — `commit` still
   brings in the ~1/3 of Booli listings that have a real price, and those slot into
   Deals with full profit maths. The tab is a shortlist, not a feed, by design.
3. **Task #1 — Booli sold depth.** At `BOOLI_SOLD_PAGES=5` we take 175 of the ~8,300
   sold apartments Booli holds for Årsta alone. Deeper coverage is the real
   resale-estimate win; it costs proxy GB and cron runtime. Decide a depth per area.
4. **Scoring backlog.** Photo analysis is capped at 10/run (`SCRAPE_ANALYZE_LIMIT`).
   Committing the Booli feed adds ~70 Årsta listings to that queue.

## Hard-won operational facts (do not re-derive)

- **Render's interactive shell serves a STALE checkout.** It snapshots the commit from
  when the session started, so a just-merged fix isn't there. Always run
  `git log --oneline -1` in a shell before trusting its output — two rounds of "your
  fix isn't working" were this. `git fetch --depth 1 origin main && git reset --hard
  FETCH_HEAD` fixes it in place. It also drops long connections, which is why both
  Booli runs exist as **cron stages** that record to `/api/scrape-health`.
- **The 2026-07-25 → 07-29 outage was proxy quota**, not Hemnet and not the scraper.
  Claire topped up the residential proxy and the 13:00 run recovered on its own
  (22/22 areas, 0 failed). Hemnet was verified healthy throughout by hitting the real
  scrape URL from a home IP and parsing 50 listings.
- **`Refusing to persist zero active listings` is a SYMPTOM, not a diagnosis.** It's
  the guard working after every area already failed. The dashboard now classifies the
  real per-area cause (proxy / blocked / parser / timeout / network / browser) via
  `api/scrape-failures.js` — see the health panel's "Why the refresh is stalled".
- **Hemnet and Booli can both be scraped LOCALLY** from Claire's residential IP with
  no proxy (`npm install` first; `~/fliphaus` has no `.env`). This is the fastest way
  to separate a source problem from a transport problem.
- **Booli specifics.** Its GraphQL rejects our own queries (403); the data comes from
  the server-rendered page's `__NEXT_DATA__`. `?q=<name>` is silently ignored and
  falls back to areaId `77104` = *"Sverige"* (2.9M rows) — an unresolved area must
  always be treated as fatal. Årsta = `874649`.
- **No `MONGO_URI` locally**, so DB-touching scripts can only be run from Render.

## What NOT to repeat

Three bugs this week all shipped looking correct and were only caught by a real run.
The dry-run defaults are what made each cheap to find — keep them:

- `booliId` declared `unique + sparse` **and** `default: null`. Sparse still indexes
  stored nulls, so the migration died on `E11000 dup key { booliId: null }`. Uniqueness
  over an optional field needs a **partial** index.
- The Kommande view inherited the base `askingPriceNum ≤ maxPrice` clause. Mongo's
  `$lte` doesn't match null, and `maxPrice` defaults to 4M — so the tab would have been
  permanently **empty**. A budget cap can't apply to a price-less listing.
- `nextShowing` arrives from Booli as an **object**, our schema stores a string, and
  the cast error killed the entire stage. Every listing in the original probe happened
  to have `nextShowing: null`. There's now a test asserting no object leaks into any
  scalar field.

Two dedup rules, both learned from live data rather than reasoning:

- **Never merge two records from the same source** — within a source, different ids
  mean different records. Real Årsta data has distinct flats identical on every
  comparable attribute (Skälderviksplan 11: two 54 m² 2-rooms, same floor, same
  building). For sold comps a bad merge skews the kr/m² percentile; for listings it
  makes a card **vanish**.
- **Sold identity is "same flat AND same sale event"** — one flat legitimately sells
  more than once, and those are separate comps. A known floor mismatch disqualifies,
  and prices must agree within 0.5% (a 2% window merged two different flats sold weeks
  apart).

## Project commands

From `/Users/clairehardman/fliphaus`:

```bash
npm install
npm test        # node --test tests/*.test.js  → 298 tests
npm start
```

## Reporting template

After each chunk, report to Claire:

1. What was checked/changed
2. What was verified (and how — live run, tests, or neither)
3. Any risk or blocker
4. The exact next step
5. Whether a reset is safe now
