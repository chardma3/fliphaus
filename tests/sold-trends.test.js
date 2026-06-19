const test = require("node:test");
const assert = require("node:assert/strict");

const { buildAreaTrends, monthlySqmSeries, priceDirection } = require("../api/sold-trends");

// Fixed reference "now" so day-window math is deterministic.
const NOW = new Date("2026-06-15T00:00:00Z");

function daysAgo(n) {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

test("priceDirection flags a falling area when recent avg kr/m² is below the prior window", () => {
  const listings = [
    // prior 90d window (days 91-180): ~55000
    { soldDate: daysAgo(100), soldPriceSqm: 56000 },
    { soldDate: daysAgo(120), soldPriceSqm: 55000 },
    { soldDate: daysAgo(140), soldPriceSqm: 54000 },
    { soldDate: daysAgo(160), soldPriceSqm: 55000 },
    // recent 90d window: ~51000
    { soldDate: daysAgo(10), soldPriceSqm: 51000 },
    { soldDate: daysAgo(30), soldPriceSqm: 52000 },
    { soldDate: daysAgo(50), soldPriceSqm: 50000 },
    { soldDate: daysAgo(70), soldPriceSqm: 51000 },
  ];
  const dir = priceDirection(listings, { now: NOW });
  assert.equal(dir.level, "down");
  assert.ok(dir.pct < 0, "pct should be negative");
  assert.equal(dir.recentCount, 4);
  assert.equal(dir.priorCount, 4);
});

test("priceDirection returns insufficient when either window is below minCount", () => {
  const listings = [
    { soldDate: daysAgo(10), soldPriceSqm: 51000 },
    { soldDate: daysAgo(30), soldPriceSqm: 52000 },
    { soldDate: daysAgo(120), soldPriceSqm: 55000 },
  ];
  const dir = priceDirection(listings, { now: NOW });
  assert.equal(dir.level, "insufficient");
  assert.equal(dir.pct, null);
});

test("priceDirection treats sub-1.5% moves as flat", () => {
  const listings = [
    { soldDate: daysAgo(100), soldPriceSqm: 50000 },
    { soldDate: daysAgo(120), soldPriceSqm: 50000 },
    { soldDate: daysAgo(140), soldPriceSqm: 50000 },
    { soldDate: daysAgo(160), soldPriceSqm: 50000 },
    { soldDate: daysAgo(10), soldPriceSqm: 50200 },
    { soldDate: daysAgo(30), soldPriceSqm: 50100 },
    { soldDate: daysAgo(50), soldPriceSqm: 50300 },
    { soldDate: daysAgo(70), soldPriceSqm: 50000 },
  ];
  assert.equal(priceDirection(listings, { now: NOW }).level, "flat");
});

test("monthlySqmSeries buckets by month chronologically and skips rows without sqm", () => {
  const listings = [
    { soldDate: new Date("2026-04-10T00:00:00Z"), soldPriceSqm: 50000 },
    { soldDate: new Date("2026-04-20T00:00:00Z"), soldPriceSqm: 52000 },
    { soldDate: new Date("2026-05-05T00:00:00Z"), soldPriceSqm: 53000 },
    { soldDate: new Date("2026-05-05T00:00:00Z"), soldPriceSqm: null }, // skipped
  ];
  const series = monthlySqmSeries(listings, { now: NOW });
  assert.deepEqual(series, [
    { month: "2026-04", avgSqm: 51000, count: 2 },
    { month: "2026-05", avgSqm: 53000, count: 1 },
  ]);
});

test("buildAreaTrends groups by area and yields series + direction per area", () => {
  const listings = [
    { area: "Kista", soldDate: daysAgo(10), soldPriceSqm: 40000 },
    { area: "Årsta", soldDate: daysAgo(10), soldPriceSqm: 70000 },
  ];
  const trends = buildAreaTrends(listings, { now: NOW });
  assert.ok(trends.Kista);
  assert.ok(trends.Årsta);
  assert.ok(Array.isArray(trends.Kista.series));
  assert.equal(trends.Kista.direction.level, "insufficient"); // only 1 sale
});
