const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findMatchingListing,
  isUsableListing,
  buildListingMergeUpdate,
  buildListingSet,
  buildListingInsertOnly,
  ingestBooliListings,
} = require("../api/booli-listing-ingest");
const { buildActiveFeedFilter } = require("../api/listings-query");

const hemnetListing = {
  _id: "doc1",
  id: "21672135",
  streetAddress: "Årstavägen 72",
  locationDescription: "Årsta",
  area: "Årsta",
  rooms: "2 rum",
  size: "44 m²",
  askingPriceNum: 4495000,
  renovationScore: 8,
  conditionLabel: "unrenovated",
  images: ["hemnet-1.jpg", "hemnet-2.jpg"],
  floor: null,
  fee: null,
  coordinates: { lat: null, lng: null },
  sources: [{ source: "hemnet", sourceId: "21672135" }],
  fingerprintKey: "arsta|44|2",
};

const booliListing = {
  id: "booli-6208449",
  source: "booli",
  booliId: "6208449",
  streetAddress: "Årstavägen 72",
  locationDescription: "Årsta",
  area: "Årsta",
  housingForm: "Bostadsrätt",
  rooms: "2 rum",
  size: "44 m²",
  sizeNum: 44,
  floor: "3",
  askingPrice: "4 495 000 kr",
  askingPriceNum: 4495000,
  fee: "4 594 kr/mån",
  feeNum: 4594,
  brokerAgencyName: "Fastighetsbyrån",
  images: ["https://bcdn.se/images/cache/2_1024x0.jpg"],
  coordinates: { lat: 59.297, lng: 18.045 },
  isUpcoming: false,
  sourceEstimateNum: 4880000,
  link: "https://www.booli.se/bostad/679504",
};

const kommandeListing = {
  ...booliListing,
  id: "booli-5868305",
  booliId: "5868305",
  streetAddress: "Möckelvägen 32",
  askingPrice: null,
  askingPriceNum: null,
  isUpcoming: true,
  sourceEstimateNum: 2540000,
};

function fakeListingModel(docs = []) {
  const calls = { queries: [], updates: [] };
  return {
    calls,
    async find(filter) {
      calls.queries.push(filter);
      return docs.filter((d) => d.fingerprintKey === filter.fingerprintKey);
    },
    async updateOne(filter, update, options) {
      calls.updates.push({ filter, update, options });
      return { modifiedCount: 1 };
    },
  };
}

test("isUsableListing drops half-records rather than storing them", () => {
  assert.equal(isUsableListing(booliListing), true);
  assert.equal(isUsableListing({ ...booliListing, id: null }), false);
  assert.equal(isUsableListing({ ...booliListing, streetAddress: null }), false);
  assert.equal(isUsableListing({ ...booliListing, sizeNum: 0 }), false);
});

test("merging into a Hemnet listing fills blanks and never touches its own data", () => {
  const update = buildListingMergeUpdate(hemnetListing, booliListing);
  assert.equal(update.set.floor, "3");
  assert.equal(update.set.fee, "4 594 kr/mån");
  assert.deepEqual(update.set.coordinates, { lat: 59.297, lng: 18.045 });
  assert.equal(update.set.booliId, "6208449");
  // Booli's valuation is new information even when Hemnet has the listing
  assert.equal(update.set.sourceEstimateNum, 4880000);
  // Hemnet's price, photos and our analysis are authoritative
  for (const field of ["askingPrice", "askingPriceNum", "images", "thumbnail", "renovationScore", "conditionLabel", "description"]) {
    assert.equal(field in update.set, false, `${field} must not be overwritten by a Booli merge`);
  }
  assert.equal(update.push.source, "booli");
});

test("merging is idempotent once Booli provenance is recorded", () => {
  const complete = {
    ...hemnetListing,
    floor: "3",
    fee: "4 594 kr/mån",
    feeNum: 4594,
    brokerAgencyName: "Fastighetsbyrån",
    housingForm: "Bostadsrätt",
    coordinates: { lat: 59.297, lng: 18.045 },
    booliId: "6208449",
    sourceEstimateNum: 4880000,
    sources: [{ source: "hemnet", sourceId: "21672135" }, { source: "booli", sourceId: "6208449" }],
  };
  assert.equal(buildListingMergeUpdate(complete, booliListing), null);
});

test("$set and $setOnInsert stay disjoint (Mongo rejects overlapping paths)", () => {
  const set = buildListingSet(booliListing);
  const insertOnly = buildListingInsertOnly(booliListing);
  const overlap = Object.keys(set).filter((k) => k in insertOnly);
  assert.deepEqual(overlap, [], `overlapping paths would fail the write: ${overlap.join(", ")}`);
  assert.equal("sizeNum" in set, false, "sizeNum isn't on the Listing schema");
  assert.equal(set.status, "active");
  assert.equal(set.fingerprintKey, "arsta|44|2");
  assert.ok(insertOnly.firstSeenAt instanceof Date);
  assert.equal(insertOnly.sources[0].source, "booli");
});

test("ingest merges a listing Hemnet already has, and inserts one it doesn't", async () => {
  const model = fakeListingModel([hemnetListing]);
  const summary = await ingestBooliListings({
    records: [booliListing, kommandeListing],
    Listing: model,
    dryRun: false,
  });
  assert.equal(summary.merged, 1);
  assert.equal(summary.inserted, 1);
  assert.equal(summary.insertedUpcoming, 1);
  assert.equal(summary.insertedPriced, 0);
  const insert = model.calls.updates.find((u) => u.options && u.options.upsert);
  assert.equal(insert.filter.id, "booli-5868305");
  // the pre-market listing must never be given a price
  assert.equal(insert.update.$set.askingPriceNum, null);
  assert.equal(insert.update.$set.isUpcoming, true);
  assert.equal(insert.update.$set.sourceEstimateNum, 2540000);
});

test("ingest writes nothing on a dry run", async () => {
  const model = fakeListingModel([hemnetListing]);
  const summary = await ingestBooliListings({ records: [booliListing, kommandeListing], Listing: model, dryRun: true });
  assert.equal(summary.merged, 1);
  assert.equal(summary.inserted, 1);
  assert.equal(model.calls.updates.length, 0);
});

// ── feed placement ──────────────────────────────────────────────────────────────

test("the kommande view is a shortlist: rejected scores out, UNSCORED kept", () => {
  const filter = buildActiveFeedFilter({ view: "kommande", dealMinScore: 6 });
  assert.equal(filter.isUpcoming, true);
  assert.equal(filter.status, "active");
  // Only assessed-and-rejected listings (1..5 = already renovated / no upside) are
  // dropped. $not over the range also matches null/missing, so freshly harvested
  // unscored listings still appear — they're the newest, and early sight is the
  // whole point of a pre-market view.
  assert.deepEqual(filter.renovationScore, { $not: { $gte: 1, $lte: 5 } });
});

test("the kommande budget cap applies to the VALUATION, not the absent asking price", () => {
  // Mongo's $lte doesn't match null, so leaving the base askingPriceNum clause here
  // would match nothing at all — and maxPrice defaults to 4M, so the tab would have
  // been permanently empty.
  const filter = buildActiveFeedFilter({ view: "kommande", maxPrice: 4000000 });
  assert.equal("askingPriceNum" in filter, false, "a price cap cannot apply to a price-less listing");
  assert.deepEqual(filter.$or, [{ sourceEstimateNum: { $lte: 4000000 } }, { sourceEstimateNum: null }]);
});

test("a kommande listing with no valuation yet is kept, not assumed unaffordable", () => {
  const filter = buildActiveFeedFilter({ view: "kommande", maxPrice: 4000000 });
  assert.ok(filter.$or.some((clause) => clause.sourceEstimateNum === null));
});

test("every other view EXCLUDES pre-market listings", () => {
  // A price-less card in Deals can't be ranked by ROI or carry a profit badge.
  for (const view of ["deals", "moveinready", "sitting", "newbuild"]) {
    const filter = buildActiveFeedFilter({ view });
    assert.deepEqual(filter.isUpcoming, { $ne: true }, `${view} must exclude pre-market listings`);
  }
});

test("kommande still respects the area exclusions and 1-room rule", () => {
  const filter = buildActiveFeedFilter({ view: "kommande" });
  assert.ok(filter.locationDescription.$not, "thin-liquidity areas stay excluded");
  assert.ok(filter.rooms.$not, "studios are never flip candidates");
  assert.ok(filter.streetAddress.$not, "new-build projekt addresses stay out");
});

test("two DIFFERENT Booli listings never merge into each other", async () => {
  // Proved necessary by a live run: harvesting Årsta into an empty store produced 6
  // merges — Booli listings collapsing together, because one building can hold two
  // same-size same-room flats at one address that no attribute separates. Here a
  // wrong merge makes a card VANISH from the dashboard.
  const storedBooli = {
    _id: "b1",
    id: "booli-6208449",
    booliId: "6208449",
    streetAddress: "Årstavägen 72",
    locationDescription: "Årsta",
    rooms: "2 rum",
    size: "44 m²",
    coordinates: { lat: 59.297, lng: 18.045 },
    status: "active",
    sources: [{ source: "booli", sourceId: "6208449" }],
    fingerprintKey: "arsta|44|2",
  };
  const model = fakeListingModel([storedBooli]);
  const other = { ...booliListing, id: "booli-9999", booliId: "9999" };
  assert.equal(await findMatchingListing(other, { Listing: model }), null);

  // ...but a HEMNET listing for the same flat still merges — that's the whole point.
  const hemnetModel = fakeListingModel([hemnetListing]);
  const match = await findMatchingListing(booliListing, { Listing: hemnetModel });
  assert.equal(match && match.id, "21672135");
});

test("ingest inserts rather than merges when a batch contains look-alike flats", async () => {
  const model = fakeListingModel([]);
  const twin = { ...booliListing, id: "booli-7777", booliId: "7777" };
  const summary = await ingestBooliListings({ records: [booliListing, twin], Listing: model, dryRun: true });
  assert.equal(summary.inserted, 2);
  assert.equal(summary.merged, 0);
});
