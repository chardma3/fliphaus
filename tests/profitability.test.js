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

  // Not a renovation play, but a move-in-ready unit priced below market is a
  // buy-and-resell profit — so it now carries an estimated resale profit + ROI,
  // not a vague "possible market gap" placeholder.
  assert.equal(isRenovationUpsideCandidate(listing), false);
  assert.notEqual(calc.classification, "renovation-upside");
  assert.equal(calc.classification, "market-gap");
  assert.ok(calc.profit > 0);
  assert.ok(calc.roi > 0);
  assert.equal(badge.profit, calc.renovationProfit);
  assert.equal(badge.roi, calc.roi);
  assert.doesNotMatch(badge.label, /possible market gap/i);
  assert.match(badge.label, /ROI/);
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
    brfIntelligence: { renovationArbitrage: { confidence: "medium", avgRenovatedSqm: 55000, estimatedUpliftTotal: 400000 } },
  };

  const calc = calcInvestment(listing);
  const badge = formatProfitBadgeModel(listing);

  assert.equal(calc.classification, "renovation-upside");
  assert.equal(badge.type, "renovation-upside");
  assert.ok(calc.renovationProfit > 0);
  assert.ok(badge.roi > 0);
  // Confident estimate uses the sold-comparable average, not the area benchmark.
  assert.equal(calc.estimateSource, "sold-comparables");
  assert.equal(calc.sqmPrice, 55000);
  assert.equal(calc.preliminary, false);
});

test("low comparable confidence keeps a profitable renovation as preliminary instead of hiding it", () => {
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

  assert.equal(calc.classification, "preliminary-renovation-upside");
  assert.ok(calc.profit > 0);
  assert.equal(calc.roi, 0);
  assert.equal(badge.type, "preliminary-renovation-upside");
  assert.equal(badge.roi, null);
  assert.match(badge.detail, /preliminary/i);
  assert.match(badge.detail, /similar sold properties/i);
  // Falls back to the area benchmark and is flagged preliminary, but still
  // produces a number — never the old "Needs similar sales" dead-end.
  assert.equal(calc.estimateSource, "area-benchmark");
  assert.equal(calc.preliminary, true);
  assert.ok(calc.estimatedRenovatedSalePrice > 0);
});

test("a benchmark-based estimate that loses money stays preliminary (shown, not filtered)", () => {
  const listing = {
    streetAddress: "Thin Comps Loss 1",
    askingPriceNum: 3200000,
    size: "60 m²",
    fee: "5 000 kr/mån",
    locationDescription: "Farsta, Stockholms kommun",
    renovationScore: 8,
    investmentPotential: "high",
    totalEstimatedCostSEK: 300000,
    renovationSummary: "Original kitchen and bathroom need full renovation",
    brfIntelligence: { renovationArbitrage: { confidence: "low", avgRenovatedSqm: null } },
  };

  const calc = calcInvestment(listing);
  const badge = formatProfitBadgeModel(listing);

  // 60 × 45,600 benchmark = 2.74M < 3.2M asking -> loses money, but preliminary.
  assert.ok(calc.renovationProfit < 0);
  assert.equal(calc.classification, "preliminary-unprofitable");
  assert.equal(badge.type, "preliminary-unprofitable");
  assert.match(badge.detail, /preliminary/i);
  // Crucially NOT "unprofitable" — the Deals tab only filters confident losses.
  assert.notEqual(calc.classification, "unprofitable");
});

test("a sold-comp-backed estimate that loses money is confidently unprofitable (filtered)", () => {
  const listing = {
    streetAddress: "Confident Loss 1",
    askingPriceNum: 3200000,
    size: "60 m²",
    fee: "5 000 kr/mån",
    locationDescription: "Farsta, Stockholms kommun",
    renovationScore: 8,
    investmentPotential: "high",
    totalEstimatedCostSEK: 300000,
    renovationSummary: "Original kitchen and bathroom need full renovation",
    brfIntelligence: { renovationArbitrage: { confidence: "high", avgRenovatedSqm: 46000 } },
  };

  const calc = calcInvestment(listing);

  // 60 × 46,000 sold avg = 2.76M < 3.2M asking -> loses money, and confident.
  assert.ok(calc.renovationProfit < 0);
  assert.equal(calc.estimateSource, "sold-comparables");
  assert.equal(calc.preliminary, false);
  assert.equal(calc.classification, "unprofitable");
});
