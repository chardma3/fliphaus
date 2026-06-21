const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAreaIntelligence, buildAllAreaIntelligence, isNewBuild } = require("../api/area-intelligence");

const sold = (over = {}) => ({ area: "Kista", soldDate: "2025-06-01", soldPriceSqm: 30000, daysOnMarket: 20, priceChange: 0, conditionLabel: "unknown", buildYear: 1975, ...over });

test("renovation spread = renovated avg minus unrenovated avg kr/m², with % uplift", () => {
  const intel = buildAreaIntelligence([
    sold({ conditionLabel: "renovated", soldPriceSqm: 40000 }),
    sold({ conditionLabel: "renovated", soldPriceSqm: 42000 }),
    sold({ conditionLabel: "renovated", soldPriceSqm: 44000 }),
    sold({ conditionLabel: "unrenovated", soldPriceSqm: 30000 }),
    sold({ conditionLabel: "unrenovated", soldPriceSqm: 31000 }),
    sold({ conditionLabel: "unrenovated", soldPriceSqm: 32000 }),
  ]);
  assert.equal(intel.byCondition.renovated.avgSqm, 42000);
  assert.equal(intel.byCondition.unrenovated.avgSqm, 31000);
  assert.equal(intel.renovationSpread.perSqm, 11000);
  assert.equal(intel.renovationSpread.pctUplift, 35.5); // 11000/31000
  assert.equal(intel.renovationSpread.confident, true); // 3 + 3 comps
});

test("renovation spread is flagged not-confident on a thin sample", () => {
  const intel = buildAreaIntelligence([
    sold({ conditionLabel: "renovated", soldPriceSqm: 40000 }),
    sold({ conditionLabel: "unrenovated", soldPriceSqm: 30000 }),
  ]);
  assert.equal(intel.renovationSpread.perSqm, 10000);
  assert.equal(intel.renovationSpread.confident, false);
});

test("spread is null when one side has no comps", () => {
  const intel = buildAreaIntelligence([sold({ conditionLabel: "renovated", soldPriceSqm: 40000 })]);
  assert.equal(intel.renovationSpread.perSqm, null);
  assert.equal(intel.byCondition.unrenovated.n, 0);
});

test("new-build detection uses build year within ~3y of sold year", () => {
  assert.equal(isNewBuild({ soldDate: "2025-06-01", buildYear: 2024 }), true);
  assert.equal(isNewBuild({ soldDate: "2025-06-01", buildYear: 2022 }), true);
  assert.equal(isNewBuild({ soldDate: "2025-06-01", buildYear: 2021 }), false);
  assert.equal(isNewBuild({ soldDate: "2025-06-01", buildYear: 1975 }), false);
  assert.equal(isNewBuild({ soldDate: "2025-06-01", buildYear: null }), false);
});

test("new-build segment reports premium and faster-sale signal", () => {
  const intel = buildAreaIntelligence([
    sold({ buildYear: 2024, soldPriceSqm: 50000, daysOnMarket: 10 }),
    sold({ buildYear: 2023, soldPriceSqm: 52000, daysOnMarket: 12 }),
    sold({ buildYear: 2024, soldPriceSqm: 51000, daysOnMarket: 8 }),
    sold({ buildYear: 1975, soldPriceSqm: 30000, daysOnMarket: 30 }),
    sold({ buildYear: 1980, soldPriceSqm: 31000, daysOnMarket: 40 }),
    sold({ buildYear: 1978, soldPriceSqm: 32000, daysOnMarket: 35 }),
  ]);
  assert.equal(intel.newBuild.new.n, 3);
  assert.equal(intel.newBuild.existing.n, 3);
  assert.equal(intel.newBuild.premiumPerSqm, 51000 - 31000); // 20000
  assert.equal(intel.newBuild.fasterSaleDays, 35 - 10); // existing avg 35, new avg 10 -> +25 faster
  assert.equal(intel.newBuild.confident, true);
});

test("ignores listings without a usable kr/m² and reports coverage honestly", () => {
  const intel = buildAreaIntelligence([
    sold({ soldPriceSqm: 0 }),
    sold({ soldPriceSqm: null }),
    sold({ conditionLabel: "renovated", soldPriceSqm: 40000, daysOnMarket: null, buildYear: null }),
  ]);
  assert.equal(intel.sampleSize, 1);
  assert.equal(intel.coverage.withConditionLabel, 1);
  assert.equal(intel.coverage.withDaysOnMarket, 0);
  assert.equal(intel.coverage.withBuildYear, 0);
});

test("buildAllAreaIntelligence groups by area", () => {
  const all = buildAllAreaIntelligence([sold({ area: "Kista" }), sold({ area: "Farsta" }), sold({ area: "Kista" })]);
  assert.equal(all.Kista.sampleSize, 2);
  assert.equal(all.Farsta.sampleSize, 1);
});
