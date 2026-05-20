const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calcInvestment,
  formatProfitBadgeModel,
  isRenovationUpsideCandidate,
  sortListingsByProfit,
} = require("../profitability");

function fakeCalc(listing) {
  return { profit: listing.profit };
}

test("sorts profitable listings from highest profit to lowest profit", () => {
  const listings = [
    { id: "low", profit: 75000 },
    { id: "high", profit: 320000 },
    { id: "mid", profit: 180000 },
  ];

  const sorted = sortListingsByProfit(listings, "desc", fakeCalc);

  assert.deepEqual(sorted.map((listing) => listing.id), ["high", "mid", "low"]);
  assert.deepEqual(listings.map((listing) => listing.id), ["low", "high", "mid"], "does not mutate the original list");
});

test("sorts unprofitable listings from closest to profitable down to worst loss", () => {
  const listings = [
    { id: "worst", profit: -250000 },
    { id: "closest", profit: -10000 },
    { id: "middle", profit: -90000 },
  ];

  const sorted = sortListingsByProfit(listings, "desc", fakeCalc);

  assert.deepEqual(sorted.map((listing) => listing.id), ["closest", "middle", "worst"]);
});

test("Skrakgränd 3 fixture returns low-upside style badge, not renovation ROI", () => {
  const listing = {
    streetAddress: "Skrakgränd 3",
    askingPriceNum: 2350000,
    size: "76 m²",
    fee: "7 352 kr/mån",
    locationDescription: "Farsta, Stockholms kommun",
    renovationScore: 2,
    investmentPotential: "low",
    totalEstimatedCostSEK: 45000,
    renovationSummary: "This apartment has been substantially renovated and is move-in ready with low renovation upside",
  };

  const calc = calcInvestment(listing);
  const badge = formatProfitBadgeModel(listing);

  assert.equal(isRenovationUpsideCandidate(listing), false);
  assert.notEqual(calc.classification, "renovation-upside");
  assert.equal(calc.profit, 0);
  assert.equal(calc.roi, 0);
  assert.equal(badge.roi, null);
  assert.equal(badge.profit, null);
  assert.match(`${badge.label} ${badge.detail}`, /market gap|move-in ready|low renovation upside/i);
});

test("unrenovated high-score profitable listing can return renovation-upside", () => {
  const listing = {
    streetAddress: "Needs Work 1",
    askingPriceNum: 1900000,
    size: "76 m²",
    fee: "4 000 kr/mån",
    locationDescription: "Farsta, Stockholms kommun",
    renovationScore: 8,
    investmentPotential: "high",
    totalEstimatedCostSEK: 250000,
    renovationSummary: "Original kitchen and bathroom need full renovation",
    brfIntelligence: { renovationArbitrage: { confidence: "medium", estimatedUpliftTotal: 400000 } },
  };

  const calc = calcInvestment(listing);
  const badge = formatProfitBadgeModel(listing);

  assert.equal(calc.classification, "renovation-upside");
  assert.equal(badge.type, "renovation-upside");
  assert.ok(calc.renovationProfit > 0);
  assert.ok(badge.roi > 0);
});

test("low comparable confidence suppresses strong ROI", () => {
  const listing = {
    streetAddress: "Low Evidence 1",
    askingPriceNum: 1900000,
    size: "76 m²",
    fee: "4 000 kr/mån",
    locationDescription: "Farsta, Stockholms kommun",
    renovationScore: 8,
    investmentPotential: "high",
    totalEstimatedCostSEK: 250000,
    renovationSummary: "Original kitchen and bathroom need full renovation",
    brfIntelligence: { renovationArbitrage: { confidence: "low", estimatedUpliftTotal: null } },
  };

  const calc = calcInvestment(listing);
  const badge = formatProfitBadgeModel(listing);

  assert.equal(calc.classification, "insufficient-data");
  assert.equal(calc.profit, 0);
  assert.equal(calc.roi, 0);
  assert.equal(badge.type, "insufficient-data");
  assert.equal(badge.roi, null);
  assert.match(badge.detail, /insufficient comparable sales evidence/i);
});
