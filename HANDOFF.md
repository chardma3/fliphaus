# FlipHaus Handoff

Last updated: 2026-05-22 15:31 CEST
Project path: `/Users/clairehardman/fliphaus`
Git remote: `https://github.com/chardma3/fliphaus.git`
Current HEAD: `bf13ec3` — `Fix FlipHaus profitability and sold data views`
Working tree at handoff creation: clean

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

Continue improving FlipHaus listing evaluation so the app does not show misleading renovation ROI for already-renovated or low-upside properties, and so sold/disappeared listing status is represented more accurately.

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

Latest chunk completed on 2026-05-22 15:31 CEST:
- Verified `npm test` passed before changes: 19/19 tests.
- Added `api/listing-presenter.js` and `tests/listing-presenter.test.js` to keep listing lifecycle status (`active`, `disappeared`, `confirmed_sold`, etc.) separate from Claire's saved/rejected preference status.
- Updated `/api/listings` and `/api/favorites` to return `status` / `listingStatus` for lifecycle state and `preferenceStatus` for saved/rejected UI state.
- Updated `index.html` to use `preferenceStatus` for saved/rejected card styling so lifecycle status is no longer overwritten.
- Verified `node --test tests/listing-presenter.test.js`, full `npm test` (21/21 tests), `node --check server.js`, `node --check api/listing-presenter.js`, and `git diff --check` all pass.

Current uncommitted changes after this chunk:
- `api/listing-presenter.js`
- `tests/listing-presenter.test.js`
- `server.js`
- `index.html`
- `HANDOFF.md` remains untracked unless explicitly added.

Recommended next step:
- Review `git diff`, then either commit/push these small status-presentation fixes or run a local/production API smoke check before deployment.

Suggested commands:

```bash
cd /Users/clairehardman/fliphaus
git diff
npm test
```

Then inspect:
- `profitability.js`
- relevant functions/usages in `index.html` and `favorites.html`
- existing tests under `tests/`

## Reporting template

After each chunk, report to Claire:

1. What I checked/changed
2. What I verified
3. Any risk or blocker
4. Exact next step
5. Whether a reset is safe now
