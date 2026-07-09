const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBrfIntelligence,
  buildSoldIndex,
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

  // A prebuilt index (what the feed passes, built once for the whole batch) must
  // yield byte-identical intelligence to passing the raw array — this is the
  // invariant the O(sold+listings) optimization rests on.
  assert.deepEqual(
    buildBrfIntelligence(listing, buildSoldIndex(soldListings)),
    intelligence
  );

  assert.equal(intelligence.brf.name, "BRF Solgläntan 1");
  assert.equal(intelligence.brf.stambyte.status, "done");
  assert.equal(intelligence.brf.avgiftRisk, "medium");
  assert.equal(intelligence.renovationArbitrage.scope, "same_brf");
  assert.equal(intelligence.renovationArbitrage.confidence, "high"); // 4 same-BRF comps
  assert.equal(intelligence.renovationArbitrage.totalComparableSales, 4);
  // Primary estimate: 75th percentile of the four sold kr/m² (52/54/66/68k).
  assert.equal(intelligence.renovationArbitrage.estimatedRenovatedSqm, 66500);
  // Classified split still surfaced as a richer per-flat uplift when tagged.
  assert.equal(intelligence.renovationArbitrage.renovatedSales, 2);
  assert.equal(intelligence.renovationArbitrage.unrenovatedSales, 2);
  assert.equal(intelligence.renovationArbitrage.estimatedUpliftPerSqm, 14000);
  assert.equal(intelligence.renovationArbitrage.estimatedUpliftTotal, 588000);
});

test("sub-area labels match their parent scraped area's sold comps", () => {
  // "Södermalm - Sofo" must use the comps stored under "Södermalm" — a comma /
  // dash / slash sub-label used to break the exact-token match and throw the data
  // away. Bromma sub-labels and dash-joined names match too; truly unscraped
  // areas (Kungsholmen) honestly stay unmatched.
  const sodermalmSub = { brfName: "BRF X", size: "50 m²", locationDescription: "Södermalm - Sofo, Stockholm" };
  const comps = Array.from({ length: 12 }, (_, i) => ({
    area: "Södermalm", locationDescription: "Södermalm, Stockholm", soldPriceSqm: 100000 + i * 1000, sizeNum: 50,
  }));
  const arb = buildBrfIntelligence(sodermalmSub, comps).renovationArbitrage;
  assert.equal(arb.scope, "area");
  assert.equal(arb.confidence, "high");
  assert.equal(arb.totalComparableSales, 12);

  // Unscraped area stays unmatched (no false positive against Södermalm comps).
  const kungsholmen = { brfName: "BRF Y", size: "50 m²", locationDescription: "Kungsholmen - Fredhäll, Stockholm" };
  assert.equal(buildBrfIntelligence(kungsholmen, comps).renovationArbitrage.scope, "none");
});

test("comps match on real location, not the search catchment they were scraped under", () => {
  // A Kungsholmen flat caught by the Stora-Essingen search: area is the catchment
  // ("Stora Essingen"), locationDescription is the real area. It must back a
  // Kungsholmen listing, not a Stora-Essingen one.
  const listing = { brfName: "BRF Z", size: "50 m²", locationDescription: "Kungsholmen - Fredhäll, Stockholm" };
  const comps = Array.from({ length: 8 }, (_, i) => ({
    area: "Stora Essingen", // broad search catchment label
    locationDescription: "Kungsholmen, Stockholm", // real area
    soldPriceSqm: 95000 + i * 1000,
    sizeNum: 50,
  }));
  const arb = buildBrfIntelligence(listing, comps).renovationArbitrage;
  assert.equal(arb.scope, "area");
  assert.equal(arb.totalComparableSales, 8);
  assert.equal(arb.confidence, "medium"); // 8 area comps
});

test("a year of UNCLASSIFIED area comps still yields a confident resale estimate", () => {
  // The whole point: none of these sales carries a condition label or score, yet
  // we have plenty of them — so the estimate is real and confident, no longer
  // thrown away as "not enough similar sales".
  const listing = { brfName: "BRF Whatever", size: "50 m²", locationDescription: "Farsta, Stockholm" };
  const soldListings = Array.from({ length: 14 }, (_, i) => ({
    area: "Farsta",
    locationDescription: "Farsta, Stockholm",
    soldPriceSqm: 48000 + i * 1000, // 48k..61k, no conditionLabel / renovationScore
    sizeNum: 50,
  }));

  const arb = buildBrfIntelligence(listing, soldListings).renovationArbitrage;
  assert.equal(arb.scope, "area");
  assert.equal(arb.confidence, "high"); // 14 area comps >= 12
  assert.equal(arb.totalComparableSales, 14);
  assert.ok(arb.estimatedRenovatedSqm > 0, "resale estimate computed without any classification");
  assert.equal(arb.renovatedSales, 0); // nothing was tagged
  assert.equal(arb.estimatedUpliftPerSqm, null); // classified uplift unavailable, but estimate still confident
});

test("falls back to area-level evidence with low confidence when comps are sparse", () => {
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
  assert.equal(intelligence.renovationArbitrage.confidence, "low"); // only 2 area comps
  assert.equal(intelligence.renovationArbitrage.estimatedRenovatedSqm, 59000); // p75 of 50k/62k
  assert.equal(intelligence.renovationArbitrage.estimatedUpliftPerSqm, 12000);
});
