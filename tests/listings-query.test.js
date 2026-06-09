const test = require("node:test");
const assert = require("node:assert/strict");

const { buildActiveFeedFilter, DEAL_MIN_SCORE } = require("../api/listings-query");

test("deals view shows scored strong flips (>=7) only — unscored excluded", () => {
  assert.deepEqual(buildActiveFeedFilter({ view: "deals", maxPrice: 4000000 }), {
    status: "active",
    locationDescription: { $not: /husby|rinkeby|vällingby|akalla/i },
    askingPriceNum: { $lte: 4000000 },
    renovationScore: { $gte: 7 },
  });
});

test("move-in-ready view shows scored-but-not-strong listings (1..6) and excludes unscored", () => {
  const f = buildActiveFeedFilter({ view: "moveinready", maxPrice: 4000000 });
  assert.deepEqual(f.renovationScore, { $gte: 1, $lte: 6 });
});

test("defaults to the deals view", () => {
  assert.deepEqual(buildActiveFeedFilter({ maxPrice: 4000000 }).renovationScore, { $gte: 7 });
});

test("the deal threshold is the single source of truth for the cut", () => {
  const f = buildActiveFeedFilter({ view: "moveinready", maxPrice: 4000000, dealMinScore: DEAL_MIN_SCORE });
  assert.equal(f.renovationScore.$lte, DEAL_MIN_SCORE - 1);
});
