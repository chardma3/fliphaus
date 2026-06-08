const test = require("node:test");
const assert = require("node:assert/strict");

const { buildActiveFeedFilter, DEAL_MIN_SCORE } = require("../api/listings-query");

test("deals view shows strong flips (>=7) and not-yet-scored listings", () => {
  assert.deepEqual(buildActiveFeedFilter({ view: "deals", maxPrice: 4000000 }), {
    status: "active",
    locationDescription: { $not: /husby|rinkeby|vällingby|akalla/i },
    askingPriceNum: { $lte: 4000000 },
    $or: [{ renovationScore: { $gte: 7 } }, { renovationScore: null }],
  });
});

test("move-in-ready view shows scored-but-not-strong listings (1..6) and excludes unscored", () => {
  const f = buildActiveFeedFilter({ view: "moveinready", maxPrice: 4000000 });
  assert.deepEqual(f.renovationScore, { $gte: 1, $lte: 6 });
  assert.equal(f.$or, undefined); // unscored (null) never appears in move-in ready
});

test("defaults to the deals view", () => {
  assert.ok(buildActiveFeedFilter({ maxPrice: 4000000 }).$or);
});

test("the deal threshold is the single source of truth for the cut", () => {
  const f = buildActiveFeedFilter({ view: "moveinready", maxPrice: 4000000, dealMinScore: DEAL_MIN_SCORE });
  assert.equal(f.renovationScore.$lte, DEAL_MIN_SCORE - 1);
});
