const test = require("node:test");
const assert = require("node:assert/strict");

const { precomputeEstimates, SOLD_COMP_FIELDS } = require("../api/precompute-estimates");

// Stub Mongoose models: find() returns fixtures, bulkWrite() captures the ops, so
// we can assert what precomputeEstimates computes and writes without a real DB.
function makeModels({ sold = [], listings = [] } = {}) {
  const calls = { soldProjection: undefined, listingQuery: undefined, bulkOps: null };
  const SoldListing = {
    find(_query, projection) {
      calls.soldProjection = projection;
      return { sort: () => ({ lean: async () => sold }) };
    },
  };
  const Listing = {
    find(query) {
      calls.listingQuery = query;
      return { lean: async () => listings };
    },
    async bulkWrite(ops) { calls.bulkOps = ops; },
  };
  return { Listing, SoldListing, calls };
}

// Enough area comps that the estimate is backed (area scope).
const SOLD = Array.from({ length: 8 }, (_, i) => ({
  soldPriceSqm: 55000 + i * 1000,
  locationDescription: "Farsta",
  area: "Farsta",
}));

test("precomputeEstimates computes brfIntelligence and stamps brfIntelligenceAt per active listing", async () => {
  const listings = [
    { _id: "a", id: "l1", locationDescription: "Farsta", size: "50 m²" },
    { _id: "b", id: "l2", locationDescription: "Farsta", size: "62 m²" },
  ];
  const { Listing, SoldListing, calls } = makeModels({ sold: SOLD, listings });

  const result = await precomputeEstimates({ Listing, SoldListing });

  assert.equal(result.updated, 2);
  assert.ok(result.at instanceof Date);
  assert.equal(calls.bulkOps.length, 2);
  for (const op of calls.bulkOps) {
    const set = op.updateOne.update.$set;
    assert.ok(set.brfIntelligence.renovationArbitrage, "stores the arbitrage estimate");
    assert.ok(set.brfIntelligence.renovationArbitrage.estimatedRenovatedSqm > 0, "estimate is a real number");
    assert.equal(set.brfIntelligenceAt, result.at, "stamps the same run time on every listing");
  }
});

test("precomputeEstimates targets only the given ids when provided", async () => {
  const { Listing, SoldListing, calls } = makeModels({ sold: SOLD, listings: [{ _id: "a", id: "l1", locationDescription: "Farsta", size: "50 m²" }] });
  await precomputeEstimates({ Listing, SoldListing, ids: ["l1"] });
  assert.deepEqual(calls.listingQuery, { id: { $in: ["l1"] } });
});

test("precomputeEstimates queries all active listings when no ids given", async () => {
  const { Listing, SoldListing, calls } = makeModels({ sold: SOLD, listings: [] });
  await precomputeEstimates({ Listing, SoldListing });
  assert.deepEqual(calls.listingQuery, { status: "active" });
});

test("the sold projection excludes images[] (never loads data comps don't use)", async () => {
  const { Listing, SoldListing, calls } = makeModels({ sold: SOLD, listings: [] });
  await precomputeEstimates({ Listing, SoldListing });
  assert.equal(calls.soldProjection, SOLD_COMP_FIELDS);
  assert.equal(SOLD_COMP_FIELDS.images, undefined, "images must not be in the projection");
  assert.equal(SOLD_COMP_FIELDS.soldPriceSqm, 1, "the price-per-sqm the estimate needs IS projected");
});

test("precomputeEstimates does no write when there are no listings", async () => {
  const { Listing, SoldListing, calls } = makeModels({ sold: SOLD, listings: [] });
  const result = await precomputeEstimates({ Listing, SoldListing });
  assert.equal(result.updated, 0);
  assert.equal(calls.bulkOps, null);
});
