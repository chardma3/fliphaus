const test = require("node:test");
const assert = require("node:assert/strict");

const { buildActiveFeedFilter, DEAL_MIN_SCORE, SITTING_MIN_DAYS } = require("../api/listings-query");

test("deals view shows scored strong flips (>=7) only — unscored and new-builds excluded", () => {
  assert.deepEqual(buildActiveFeedFilter({ view: "deals", maxPrice: 4000000 }), {
    status: "active",
    locationDescription: { $not: /husby|rinkeby|vällingby|akalla|rissne|hallonbergen/i },
    askingPriceNum: { $lte: 4000000 },
    streetAddress: { $not: /^[^0-9]+$/ },
    renovationScore: { $gte: 7 },
  });
});

test("move-in-ready view shows scored-but-not-strong listings (1..6) and excludes unscored", () => {
  const f = buildActiveFeedFilter({ view: "moveinready", maxPrice: 4000000 });
  assert.deepEqual(f.renovationScore, { $gte: 1, $lte: 6 });
  assert.deepEqual(f.streetAddress, { $not: /^[^0-9]+$/ });
});

test("new-build view shows only projekt listings (name-only address), no score filter", () => {
  const f = buildActiveFeedFilter({ view: "newbuild", maxPrice: 4000000 });
  assert.deepEqual(f, {
    status: "active",
    locationDescription: { $not: /husby|rinkeby|vällingby|akalla|rissne|hallonbergen/i },
    askingPriceNum: { $lte: 4000000 },
    streetAddress: /^[^0-9]+$/,
  });
  assert.equal(f.renovationScore, undefined);
});

test("defaults to the deals view", () => {
  assert.deepEqual(buildActiveFeedFilter({ maxPrice: 4000000 }).renovationScore, { $gte: 7 });
});

test("the deal threshold is the single source of truth for the cut", () => {
  const f = buildActiveFeedFilter({ view: "moveinready", maxPrice: 4000000, dealMinScore: DEAL_MIN_SCORE });
  assert.equal(f.renovationScore.$lte, DEAL_MIN_SCORE - 1);
});

test("sitting view filters by publishedAt cutoff, any score, real apartments only", () => {
  const cutoff = new Date("2026-06-12T00:00:00Z");
  const f = buildActiveFeedFilter({ view: "sitting", maxPrice: 4000000, sittingBefore: cutoff });
  assert.equal(f.status, "active");
  assert.deepEqual(f.streetAddress, { $not: /^[^0-9]+$/ }); // excludes new-builds
  assert.deepEqual(f.publishedAt, { $lte: cutoff, $ne: null });
  assert.equal(f.renovationScore, undefined); // any score, incl. unscored
});

test("sitting view without a cutoff omits the publishedAt bound", () => {
  const f = buildActiveFeedFilter({ view: "sitting", maxPrice: 4000000 });
  assert.equal(f.publishedAt, undefined);
  assert.equal(f.renovationScore, undefined);
});

test("SITTING_MIN_DAYS is exported and at least a week", () => {
  assert.ok(SITTING_MIN_DAYS >= 7);
});
