const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBrfIntelligence,
  classifySoldCondition,
  normalizeBrfName,
} = require("../api/brf-intelligence");

test("normalizes BRF names for reliable same-association matching", () => {
  assert.equal(normalizeBrfName("BRF Solgläntan nr 1"), "solgläntan 1");
  assert.equal(normalizeBrfName("Bostadsrättsföreningen Solgläntan 1"), "solgläntan 1");
  assert.equal(normalizeBrfName(null), null);
});

test("classifies sold condition from explicit label or renovation score", () => {
  assert.equal(classifySoldCondition({ conditionLabel: "renovated" }), "renovated");
  assert.equal(classifySoldCondition({ conditionLabel: "unrenovated" }), "unrenovated");
  assert.equal(classifySoldCondition({ renovationScore: 2 }), "renovated");
  assert.equal(classifySoldCondition({ renovationScore: 5 }), "partly_renovated");
  assert.equal(classifySoldCondition({ renovationScore: 8 }), "unrenovated");
  assert.equal(classifySoldCondition({}), "unknown");
});

test("calculates high-confidence same-BRF renovation uplift", () => {
  const listing = {
    brfName: "BRF Solgläntan 1",
    buildYear: 1962,
    stambyteStatus: "done",
    stambyteYear: 2018,
    brfDebtPerSqm: 7800,
    totalApartments: 84,
    size: "42 m²",
    locationDescription: "Rissne, Sundbyberg",
  };

  const soldListings = [
    { brfName: "Bostadsrättsföreningen Solgläntan nr 1", soldPriceSqm: 52000, conditionLabel: "unrenovated", sizeNum: 41, soldDate: new Date("2026-01-10") },
    { brfName: "BRF Solgläntan 1", soldPriceSqm: 54000, renovationScore: 8, sizeNum: 43, soldDate: new Date("2026-02-12") },
    { brfName: "BRF Solgläntan 1", soldPriceSqm: 66000, conditionLabel: "renovated", sizeNum: 40, soldDate: new Date("2026-03-01") },
    { brfName: "BRF Solgläntan 1", soldPriceSqm: 68000, renovationScore: 2, sizeNum: 44, soldDate: new Date("2026-04-15") },
    { brfName: "BRF Other", soldPriceSqm: 90000, conditionLabel: "renovated", sizeNum: 42, soldDate: new Date("2026-05-01") },
  ];

  const intelligence = buildBrfIntelligence(listing, soldListings);

  assert.equal(intelligence.brf.name, "BRF Solgläntan 1");
  assert.equal(intelligence.brf.stambyte.status, "done");
  assert.equal(intelligence.brf.avgiftRisk, "medium");
  assert.equal(intelligence.renovationArbitrage.scope, "same_brf");
  assert.equal(intelligence.renovationArbitrage.confidence, "high");
  assert.equal(intelligence.renovationArbitrage.renovatedSales, 2);
  assert.equal(intelligence.renovationArbitrage.unrenovatedSales, 2);
  assert.equal(intelligence.renovationArbitrage.avgRenovatedSqm, 67000);
  assert.equal(intelligence.renovationArbitrage.avgUnrenovatedSqm, 53000);
  assert.equal(intelligence.renovationArbitrage.estimatedUpliftPerSqm, 14000);
  assert.equal(intelligence.renovationArbitrage.estimatedUpliftTotal, 588000);
});

test("falls back to area-level evidence with lower confidence", () => {
  const listing = {
    brfName: "BRF Unknown",
    size: "50 m²",
    locationDescription: "Farsta, Stockholm",
  };

  const soldListings = [
    { area: "Farsta", locationDescription: "Farsta, Stockholm", soldPriceSqm: 50000, conditionLabel: "unrenovated", sizeNum: 51 },
    { area: "Farsta", locationDescription: "Farsta Centrum", soldPriceSqm: 62000, conditionLabel: "renovated", sizeNum: 49 },
  ];

  const intelligence = buildBrfIntelligence(listing, soldListings);

  assert.equal(intelligence.renovationArbitrage.scope, "area");
  assert.equal(intelligence.renovationArbitrage.confidence, "medium");
  assert.equal(intelligence.renovationArbitrage.estimatedUpliftPerSqm, 12000);
  assert.equal(intelligence.renovationArbitrage.estimatedUpliftTotal, 600000);
});
