# FlipHaus Handoff

Last updated: 2026-05-24 13:32 CEST
Project path: `/Users/clairehardman/fliphaus`
Git remote: `https://github.com/chardma3/fliphaus.git`
Current HEAD: pending commit for Hemnet refresh safety
Working tree at handoff creation: contains Hemnet refresh safety changes until committed

## Purpose of this file

This file is the continuity source of truth for long FlipHaus sessions. If the WhatsApp/Hermes chat is reset, read this file first before searching old session history.

## Operating agreement with Claire

Before building or changing code, Hermes should briefly answer with:
- what the task appears to be
- what will be checked or changed
- likely risk
- whether Claire needs to approve anything

During long work, Hermes should:
- work in bounded chunks
- update this file before/after meaningful coding chunks
- update this file before risky changes, long tests/builds, or reset/context warnings
- report back after each chunk with what changed, what was verified, and what remains
- avoid relying on old chat history when this file has the needed context

## Current objective

Make the Hemnet refresh pipeline reliable and safe: fail clearly on bot-protection/parser failures, never let a zero active-listing scrape mark existing listings as disappeared, split long sold-data refreshes into shorter bounded requests, keep the daily cron, and document operations in the README.

## Current known plan

Implementation plan exists at:

`/Users/clairehardman/fliphaus/docs/plans/fix-profit-roi-and-sold-status.md`

Priority from that plan:
1. Finish/verify Tasks 1-4 first: shared profitability logic, suppress misleading renovation ROI, separate renovation upside from market-gap upside, and use BRF/sold-comparable confidence before showing strong profit claims.
2. Then Tasks 5-6: improve sold-status semantics and sold-listing reconciliation.
3. Add regression tests before deployment where possible.

## Known bug context

Problem listing: Skrakgränd 3, Hemnet id `21672135`.

Previous issue:
- The AI/property analysis correctly identified the apartment as substantially renovated / move-in ready / low renovation upside.
- The frontend profit badge nevertheless calculated roughly +1.0m profit because it used area renovated sqm price minus asking price and renovation cost.
- That double-counted the renovated premium for an apartment that was already renovated.

Expected behaviour:
- Skrakgränd 3 must not show a large positive renovation ROI badge.
- It should show low renovation upside / move-in-ready / neutral wording, or cautiously label any spread as a possible market gap rather than renovation ROI.

## Relevant files

Likely files for profitability/UI work:
- `profitability.js`
- `index.html`
- `favorites.html`
- `tests/*.test.js`

Likely files for sold-status work:
- `api/scrape.js`
- `api/scrape-sold.js`
- `api/listing.model.js`
- `models/sold.model.js`
- potentially `api/reconcile-sold.js`
- `server.js`

## Project commands

From `/Users/clairehardman/fliphaus`:

```bash
npm install
npm test
npm start
```

Package test script currently is:

```bash
node --test tests/*.test.js
```

## Current repo state at this handoff

Checked on 2026-05-22 15:21 CEST:
- `/Users/clairehardman/fliphaus` exists and is a git repo.
- Remote is `https://github.com/chardma3/fliphaus.git`.
- Branch is `main`, tracking `origin/main`.
- Working tree was clean when this file was first created.
- There are also directories `/Users/clairehardman/FlipHaus` and `/Users/clairehardman/Documents/fliphaus`; use `/Users/clairehardman/fliphaus` unless Claire explicitly says otherwise.

## Next recommended step

Latest chunk completed on 2026-05-24 13:32 CEST:
- Added `api/hemnet-refresh-safety.js` and `tests/hemnet-refresh-safety.test.js`.
- Active and sold scrapers now detect Hemnet bot-protection / missing `__NEXT_DATA__` pages and return clear errors instead of silently treating them as zero results.
- Active scrape now refuses to persist a zero-listing result, so a blocked scrape cannot mark existing active listings as `disappeared`.
- Sold scrape now supports area-bounded requests through `/api/scrape-sold?area=<area>&detailLimit=20`.
- GitHub Actions daily refresh still runs at `20 5 * * *`, but now splits sold comparable-property scraping into separate Rissne and Farsta requests.
- README now documents the refresh pipeline, UTC/Stockholm schedule, safety rules, stale-data checks, and timeout/bot-block troubleshooting.
- Verified full `npm test` passes: 26/26 tests.
- Verified syntax/checks: `node --check api/hemnet-refresh-safety.js`, `node --check api/scrape.js`, `node --check api/scrape-sold.js`, `node --check server.js`, and `git diff --check`.

Recommended next step:
- Commit and push these changes, then watch the next GitHub Actions refresh run. If `/api/scrape-sold` still times out, lower `detailLimit` from 20 to 10 in `.github/workflows/refresh-fliphaus.yml`.

## Historical notes

Previous chunk completed on 2026-05-22 15:31 CEST:
- Added `api/listing-presenter.js` and `tests/listing-presenter.test.js` to keep listing lifecycle status separate from Claire's saved/rejected preference status.
- Updated `/api/listings`, `/api/favorites`, and `index.html` to expose `preferenceStatus` separately and preserve lifecycle status.
- Verified relevant presenter tests and full `npm test` passed at that time.

## Reporting template

After each chunk, report to Claire:

1. What I checked/changed
2. What I verified
3. Any risk or blocker
4. Exact next step
5. Whether a reset is safe now
