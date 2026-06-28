const test = require("node:test");
const assert = require("node:assert/strict");

const { buildActiveFeedFilter, DEAL_MIN_SCORE, SITTING_MIN_DAYS } = require("../api/listings-query");

test("deals view shows scored strong flips (>=6) only — unscored and new-builds excluded", () => {
  // areaConstraints: [] isolates the view/score shape from the live per-area caps
  // (Östermalm/Södermalm), which are covered by their own tests below.
  assert.deepEqual(buildActiveFeedFilter({ view: "deals", maxPrice: 4000000, areaConstraints: [] }), {
    status: "active",
    locationDescription: { $not: /husby|rinkeby|vällingby|akalla|rissne|hallonbergen/i },
    askingPriceNum: { $lte: 4000000 },
    streetAddress: { $not: /^[^0-9]+$/ },
    renovationScore: { $gte: 6 },
  });
});

test("deals are NOT hidden when a wet room wasn't pictured — they show flagged instead", () => {
  // A blind-bathroom deal stays visible (the card shows a provisional warning and
  // the coverage sweep corrects it). Hiding it made it vanish: gated out of Deals,
  // score too high for Move-in ready. So no coverage clause on the deals filter.
  const f = buildActiveFeedFilter({ view: "deals", areaConstraints: [] });
  assert.equal(f.bathroomPictured, undefined);
  assert.equal(f.kitchenPictured, undefined);
});

test("move-in-ready view shows scored-but-not-strong listings (1..5) and excludes unscored", () => {
  const f = buildActiveFeedFilter({ view: "moveinready", maxPrice: 4000000 });
  assert.deepEqual(f.renovationScore, { $gte: 1, $lte: 5 });
  assert.deepEqual(f.streetAddress, { $not: /^[^0-9]+$/ });
});

test("new-build view shows only projekt listings (name-only address), no score filter", () => {
  const f = buildActiveFeedFilter({ view: "newbuild", maxPrice: 4000000, areaConstraints: [] });
  assert.deepEqual(f, {
    status: "active",
    locationDescription: { $not: /husby|rinkeby|vällingby|akalla|rissne|hallonbergen/i },
    askingPriceNum: { $lte: 4000000 },
    streetAddress: /^[^0-9]+$/,
  });
  assert.equal(f.renovationScore, undefined);
});

test("defaults to the deals view", () => {
  assert.deepEqual(buildActiveFeedFilter({ maxPrice: 4000000 }).renovationScore, { $gte: 6 });
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

test("move-in-ready excludes sitting listings when given the cutoff (mutual exclusion)", () => {
  const cutoff = new Date("2026-06-12T00:00:00Z");
  const f = buildActiveFeedFilter({ view: "moveinready", sittingBefore: cutoff, areaConstraints: [] });
  // A listing on the market past the cutoff (publishedAt <= cutoff, non-null) is
  // "sitting" and must be excluded here: keep only newer or undated ones.
  assert.deepEqual(f.$or, [
    { publishedAt: { $gt: cutoff } },
    { publishedAt: null },
  ]);
});

test("deals are EXEMPT from the sitting exclusion — an aged strong flip stays a deal", () => {
  const cutoff = new Date("2026-06-12T00:00:00Z");
  const f = buildActiveFeedFilter({ view: "deals", sittingBefore: cutoff, areaConstraints: [] });
  assert.equal(f.$or, undefined);
  assert.equal(f.publishedAt, undefined);
});

test("without a cutoff, move-in-ready adds no publishedAt clause (shape unchanged)", () => {
  const f = buildActiveFeedFilter({ view: "moveinready", areaConstraints: [] });
  assert.equal(f.$or, undefined);
  assert.equal(f.publishedAt, undefined);
});

test("new-build view ignores the sitting cutoff (projekt listings never sit)", () => {
  const f = buildActiveFeedFilter({ view: "newbuild", sittingBefore: new Date("2026-06-12T00:00:00Z"), areaConstraints: [] });
  assert.equal(f.$or, undefined);
  assert.equal(f.publishedAt, undefined);
});

test("status override keeps the buyability gates but targets a different status (disappeared digest)", () => {
  const f = buildActiveFeedFilter({
    view: "sitting",
    status: "disappeared",
    areaConstraints: [{ name: "Östermalm", filters: { maxPriceSEK: 6_000_000, compsOnly: false } }],
  });
  assert.equal(f.status, "disappeared");
  // The per-area cap still applies, so an over-cap Östermalm unit is excluded
  // from Disappeared exactly as it was from every active section.
  assert.deepEqual(f.$nor, [
    { locationDescription: /Östermalm/i, askingPriceNum: { $gt: 6_000_000 } },
  ]);
  assert.deepEqual(f.streetAddress, { $not: /^[^0-9]+$/ }); // real apartments only
  assert.equal(f.renovationScore, undefined); // any score
});

test("status defaults to active (unchanged behaviour)", () => {
  assert.equal(buildActiveFeedFilter({ areaConstraints: [] }).status, "active");
});

// --- per-area filters (api/area-priority.js) wired into the feed ---

test("with no active area constraints, no $nor clause is added (additive wiring)", () => {
  assert.deepEqual(buildActiveFeedFilter({ view: "deals", maxPrice: 4000000, areaConstraints: [] }), {
    status: "active",
    locationDescription: { $not: /husby|rinkeby|vällingby|akalla|rissne|hallonbergen/i },
    askingPriceNum: { $lte: 4000000 },
    streetAddress: { $not: /^[^0-9]+$/ },
    renovationScore: { $gte: 6 },
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

test("the live area-priority backlog now surfaces the Östermalm + Södermalm 6M caps", () => {
  const { activeAreaConstraints } = require("../api/listings-query");
  // Activated 2026-06-24: both inner-city cores are live with a 6M maxPriceSEK cap,
  // so the wiring is no longer dormant. (Nacka is active too but its excludeNewBuild
  // filter isn't consumed by the feed, so it produces no listings-query constraint.)
  const capped = activeAreaConstraints()
    .filter((a) => a.filters.maxPriceSEK != null)
    .map((a) => a.name)
    .sort();
  assert.deepEqual(capped, ["Södermalm", "Östermalm"]);
});
