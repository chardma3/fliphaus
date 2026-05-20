# Fix Profit ROI and Sold Status Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Stop FlipHaus from showing outrageous renovation ROI on already-renovated listings, and improve checks for whether evaluated listings have actually sold.

**Architecture:** Split the current single "profit" badge into conservative renovation-upside logic plus separate market-gap logic. Confirm sold status via sold-listing reconciliation rather than treating every disappeared active listing as sold.

**Tech Stack:** Node/Express, Mongo/Mongoose, vanilla frontend JS, Hemnet scrape data.

---

## Context from bug report

Problem listing: Skrakgränd 3, Hemnet id `21672135`.

Live API showed:
- streetAddress: `Skrakgränd 3`
- price: `2,350,000 kr`
- size: `76 m²`
- rooms: `4 rum`
- renovationScore: `2`
- totalEstimatedCostSEK: `45,000`
- investmentPotential: `low`
- AI summary correctly says it is substantially renovated / move-in ready / low renovation upside.

But the frontend profit badge calculated around +1.0m profit because `calcInvestment()` used:

```js
estimated resale value = size * hardcoded renovated sqm price for area
```

For Farsta this was roughly:

```text
76 * 45,600 = 3,465,600 kr
3,465,600 - 2,350,000 - 45,000 - 51,464 carrying cost = about 1,019,136 kr
```

This is misleading because the apartment is already renovated, so the model double-counts the renovated premium.

Relevant files:
- `/Users/clairehardman/fliphaus/index.html`
- `/Users/clairehardman/fliphaus/favorites.html`
- `/Users/clairehardman/fliphaus/profitability.js`
- `/Users/clairehardman/fliphaus/api/scrape.js`
- `/Users/clairehardman/fliphaus/api/scrape-sold.js`
- `/Users/clairehardman/fliphaus/api/listing.model.js`
- `/Users/clairehardman/fliphaus/models/sold.model.js`
- `/Users/clairehardman/fliphaus/api/brf-intelligence.js`

Current sold check:
- `api/scrape.js` marks listings no longer present in active scrape as `status: "sold"`.
- This is weak: disappeared could mean removed, paused, changed broker/id, outside filters, etc.
- There is a sold scraper (`api/scrape-sold.js`), but no strong reconciliation back to active evaluated listings.

---

## Task 1: Move profitability logic into a shared module

**Objective:** Avoid duplicated buggy `calcInvestment()` logic in `index.html` and `favorites.html`.

**Files:**
- Modify: `/Users/clairehardman/fliphaus/profitability.js`
- Modify: `/Users/clairehardman/fliphaus/index.html`
- Modify: `/Users/clairehardman/fliphaus/favorites.html`

**Steps:**
1. Expand `profitability.js` to export:
   - `getAreaSqmPrice(locationDesc)`
   - `isRenovationUpsideCandidate(listing)`
   - `calcInvestment(listing)`
   - `formatProfitBadgeModel(listing)` or similar.
2. Remove duplicated local `RENOVATED_SQM` and `calcInvestment()` definitions from the HTML files.
3. Make the pages call the shared functions loaded from `/profitability.js`.

**Acceptance:**
- One source of truth for profit logic.
- Both index and favorites still render cards.

---

## Task 2: Suppress renovation ROI for move-in-ready listings

**Objective:** Prevent listings like Skrakgränd 3 from showing +1m renovation ROI.

**Rules to implement in shared profitability logic:**

Do not show a positive renovation ROI badge if any of these are true:
- `renovationScore <= 3`
- `investmentPotential === "low"`
- `totalEstimatedCostSEK < 75000`
- renovation summary contains strong move-in-ready signals like `move-in ready`, `substantially renovated`, `recently renovated`, `low renovation upside`

Instead return a neutral badge/model such as:

```js
{
  type: "low-upside",
  label: "Move-in ready",
  detail: "Low renovation upside",
  profit: null,
  roi: null
}
```

Only show a green profit badge when:
- `renovationScore >= 5` or `investmentPotential` is `medium`/`high`, and
- `totalEstimatedCostSEK >= 75000`, and
- calculated profit is positive, and
- confidence/comparable evidence is not clearly low.

**Acceptance test idea:**

For Skrakgränd 3 fixture:

```js
const listing = {
  streetAddress: "Skrakgränd 3",
  askingPriceNum: 2350000,
  size: "76 m²",
  fee: "7 352 kr/mån",
  locationDescription: "Farsta, Stockholms kommun",
  renovationScore: 2,
  investmentPotential: "low",
  totalEstimatedCostSEK: 45000,
  renovationSummary: "This apartment has been substantially renovated... move-in ready... low renovation upside"
};
```

Expected:
- no `+1.0m` badge
- no positive ROI percentage
- badge/detail says low renovation upside / move-in ready

---

## Task 3: Separate renovation upside from market-gap upside

**Objective:** If a move-in-ready property appears underpriced, label that as market gap, not renovation ROI.

**Implementation idea:**
- `calcInvestment()` should return fields like:
  - `estimatedRenovatedSalePrice`
  - `grossMarketGap`
  - `renovationProfit`
  - `classification: "renovation-upside" | "market-gap" | "low-upside" | "unprofitable" | "insufficient-data"`
- For already-renovated listings, possible positive spread should be classified as `market-gap` and shown cautiously, e.g. `Possible market gap`, not `ROI`.

**Acceptance:**
- Skrakgränd 3 may show “possible market gap” only if we decide to show anything, but must not say renovation ROI.

---

## Task 4: Use BRF/sold-comparable confidence before displaying big claims

**Objective:** Stop confident ROI display when `brfIntelligence.renovationArbitrage` says evidence is insufficient/low.

**Rules:**
- If `listing.brfIntelligence.renovationArbitrage.confidence === "low"` and `estimatedUpliftTotal == null`, suppress strong green profit badge.
- Show muted text: `Insufficient comparable sales evidence`.
- Prefer BRF/same-area uplift data over hardcoded area sqm defaults when available.

**Acceptance:**
- Listings with no comparable renovated/unrenovated sold evidence do not get large confident ROI labels.

---

## Task 5: Improve sold-status model semantics

**Objective:** Distinguish confirmed sold from disappeared/unknown.

**Files:**
- Modify: `/Users/clairehardman/fliphaus/api/listing.model.js`
- Modify: `/Users/clairehardman/fliphaus/api/scrape.js`

**Changes:**
- Add/standardize statuses:
  - `active`
  - `confirmed_sold`
  - `disappeared`
  - `removed`
  - `unknown`
- In `api/scrape.js`, when a previously active listing is absent from the latest active scrape, mark it `disappeared`, not `sold`.
- Set fields:
  - `disappearedAt`
  - `lastSeenAt`
  - `soldStatusConfidence: "unconfirmed"`

**Acceptance:**
- The app no longer assumes all disappeared listings were sold.

---

## Task 6: Add sold-listing reconciliation

**Objective:** Confirm sold status only when a matching sold record appears.

**Files:**
- Create or modify: `/Users/clairehardman/fliphaus/api/reconcile-sold.js`
- Modify: `/Users/clairehardman/fliphaus/api/scrape-sold.js`
- Modify: `/Users/clairehardman/fliphaus/server.js`

**Match logic:**
Match `Listing` to `SoldListing` using weighted fields:
- normalized street address exact or close match
- size within ±2 m²
- rooms exact or near match
- same area/location token
- same BRF when available

If match score is high:
- `status = "confirmed_sold"`
- `soldPrice = sold.soldPrice`
- `soldDate = sold.soldDate`
- `soldStatusConfidence = "confirmed"`
- maybe `soldListingId` / `matchedSoldHemnetId`

If not matched:
- keep as `disappeared`/`unknown`.

**Acceptance:**
- Confirmed sold records have actual sold price from sold scrape.
- Disappeared listings are not treated as confirmed sold.

---

## Task 7: Add regression tests

**Objective:** Make sure this exact bug cannot come back.

**Files:**
- Create tests if the project has a test setup, otherwise create a small Node script under `/Users/clairehardman/fliphaus/tests/`.

Test cases:
1. Skrakgränd 3 fixture returns low-upside/no ROI.
2. Unrenovated high-score listing can return renovation-upside if profitable.
3. Low comparable confidence suppresses strong ROI.
4. Disappeared active listing is not automatically `confirmed_sold`.
5. Sold reconciliation confirms only strong address/size/room matches.

---

## Task 8: Deploy and verify

**Objective:** Confirm production no longer shows the outrageous evaluation.

**Commands:**

```bash
cd /Users/clairehardman/fliphaus
git status
git diff
npm test || true
git add .
git commit -m "fix: suppress misleading renovation ROI and improve sold status"
git push
```

Then verify production after Render deploy:

```bash
curl -s 'https://fliphaus.onrender.com/api/listings?sort=renovation' | node -e '
let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
  const data=JSON.parse(d);
  const l=data.listings.find(x=>x.id==="21672135" || x.streetAddress==="Skrakgränd 3");
  console.log(JSON.stringify({streetAddress:l?.streetAddress, renovationScore:l?.renovationScore, totalEstimatedCostSEK:l?.totalEstimatedCostSEK, investmentPotential:l?.investmentPotential, summary:l?.renovationSummary}, null, 2));
});'
```

Manual UI check:
- Open `https://fliphaus.onrender.com`
- Find Skrakgränd 3
- Confirm it does not show `+1.0m` / huge ROI.
- Confirm it says move-in-ready / low renovation upside or no profit badge.

---

## Priority recommendation

Do Tasks 1-4 first. They fix the user-visible false-positive ROI issue.

Then do Tasks 5-6 to improve sold-status accuracy.

Task 7 should be done before deployment if possible, because this bug is easy to reintroduce.
