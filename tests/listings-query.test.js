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

// --- per-area filters (api/area-priority.js) wired into the feed ---

test("with no active area constraints the filter is unchanged (byte-identical)", () => {
  assert.deepEqual(buildActiveFeedFilter({ view: "deals", maxPrice: 4000000, areaConstraints: [] }), {
    status: "active",
    locationDescription: { $not: /husby|rinkeby|vällingby|akalla|rissne|hallonbergen/i },
    askingPriceNum: { $lte: 4000000 },
    streetAddress: { $not: /^[^0-9]+$/ },
    renovationScore: { $gte: 7 },
  });
});

test("a per-area maxPriceSEK cap adds a NOT(in-area AND over-cap) clause, leaving other areas free", () => {
  const f = buildActiveFeedFilter({
    view: "deals",
    areaConstraints: [
      { name: "Östermalm", filters: { maxPriceSEK: 6_000_000, compsOnly: false } },
    ],
  });
  assert.deepEqual(f.$nor, [
    { locationDescription: /Östermalm/i, askingPriceNum: { $gt: 6_000_000 } },
  ]);
  // A global price cap is untouched and composes with the per-area $nor.
  assert.equal(f.askingPriceNum, undefined);
});

test("the per-area cap applies across views, not just deals", () => {
  const constraints = [{ name: "Södermalm", filters: { maxPriceSEK: 6_000_000, compsOnly: false } }];
  for (const view of ["deals", "moveinready", "sitting", "newbuild"]) {
    const f = buildActiveFeedFilter({ view, areaConstraints: constraints });
    assert.deepEqual(f.$nor, [
      { locationDescription: /Södermalm/i, askingPriceNum: { $gt: 6_000_000 } },
    ]);
  }
});

test("a compsOnly area is folded into the exclusion regex (never surfaced as buyable)", () => {
  const f = buildActiveFeedFilter({
    view: "deals",
    areaConstraints: [{ name: "Stuvsta", filters: { maxPriceSEK: null, compsOnly: true } }],
  });
  const re = f.locationDescription.$not;
  assert.ok(re.test("Stuvsta, Huddinge"), "compsOnly area is excluded");
  assert.ok(re.test("Rissne"), "the hardcoded exclusions are preserved");
  assert.ok(!re.test("Östermalm"), "unrelated areas still pass");
  assert.equal(f.$nor, undefined, "compsOnly does not add a price clause");
});

test("the live area-priority backlog produces no active constraints yet (additive, zero current effect)", () => {
  const { activeAreaConstraints } = require("../api/listings-query");
  // Gärdet/Essingeöarna are active but carry null filters; Östermalm/Södermalm
  // are still pending. So wiring is dormant until Claire flips a capped area live.
  assert.deepEqual(activeAreaConstraints(), []);
});
