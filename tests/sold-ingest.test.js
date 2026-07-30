const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sameSale,
  findCanonicalSoldMatch,
  buildSoldMergeUpdate,
  buildSoldInsert,
  isUsableSoldComp,
  isDifferentRecordFromSameSource,
  ingestBooliSold,
} = require("../api/sold-ingest");
const { blockingKey } = require("../api/listing-fingerprint");

// A Hemnet sale already in the store, and the same sale as Booli reports it.
const hemnetSale = {
  _id: "doc1",
  hemnetId: "21672135",
  streetAddress: "Årstavägen 70",
  locationDescription: "Årsta",
  area: "Årsta",
  rooms: "2 rum",
  size: "55 m²",
  sizeNum: 55,
  soldPrice: 3600000,
  soldPriceSqm: 65454,
  soldDate: new Date("2026-07-27"),
  brfName: "Brf Årstalunden",
  sources: [{ source: "hemnet", sourceId: "21672135" }],
  fingerprintKey: "arsta|55|2",
};

const booliSale = {
  source: "booli",
  booliId: "6171318",
  streetAddress: "Årstavägen 70",
  locationDescription: "Årsta",
  area: "Årsta",
  rooms: "2 rum",
  size: "55 m²",
  sizeNum: 55,
  floor: 5,
  soldPrice: 3600000,
  soldPriceSqm: 65500,
  askingPriceNum: 3395000,
  priceChange: 6,
  soldDate: "2026-07-27",
  daysOnMarket: 39,
  housingForm: "Lägenhet",
  coordinates: { lat: 59.29828141, lng: 18.04782648 },
  link: "https://www.booli.se/annons/6171318",
};

function fakeSoldModel(docs = []) {
  const calls = { created: [], updated: [], queries: [] };
  return {
    calls,
    async find(filter) {
      calls.queries.push(filter);
      return docs.filter((d) => !filter.fingerprintKey || d.fingerprintKey === filter.fingerprintKey);
    },
    async create(doc) {
      calls.created.push(doc);
      return doc;
    },
    async updateOne(filter, update) {
      calls.updated.push({ filter, update });
      return { modifiedCount: 1 };
    },
  };
}

test("sameSale merges one sale reported by two sources", () => {
  const verdict = sameSale(booliSale, hemnetSale);
  assert.equal(verdict.same, true);
  assert.ok(verdict.reasons.some((r) => /sold date within/.test(r)));
});

test("sameSale keeps a genuine RE-SALE of the same flat separate", () => {
  // Same apartment, sold again three years later. Merging these would silently
  // delete a real comp — the single most damaging failure mode here.
  const earlier = { ...hemnetSale, soldDate: new Date("2023-05-14"), soldPrice: 2950000 };
  const verdict = sameSale(booliSale, earlier);
  assert.equal(verdict.same, false);
  assert.ok(verdict.reasons.some((r) => /different sale/.test(r)));
});

test("sameSale tolerates a small reporting-date difference between sources", () => {
  const shifted = { ...hemnetSale, soldDate: new Date("2026-07-09") }; // 18 days
  assert.equal(sameSale(booliSale, shifted).same, true);
});

test("sameSale refuses to merge when a sold date is missing", () => {
  const undated = { ...hemnetSale, soldDate: null };
  const verdict = sameSale(booliSale, undated);
  assert.equal(verdict.same, false);
  assert.ok(verdict.reasons.some((r) => /date missing/.test(r)));
});

test("sameSale refuses to merge when the two prices disagree", () => {
  // Same flat, same window, materially different price = different transaction
  // (or a bad parse). Either way, merging would corrupt a comp.
  const conflicting = { ...hemnetSale, soldPrice: 4200000 };
  const verdict = sameSale(booliSale, conflicting);
  assert.equal(verdict.same, false);
  assert.ok(verdict.reasons.some((r) => /price differs/.test(r)));
});

test("sameSale treats a floor mismatch as a different apartment", () => {
  // Real Årsta case: Johanneshovsvägen 106, two 81 m² 3-rooms on floors 4 and 7,
  // sold weeks apart at similar prices. Every other signal matches, so only the
  // floor separates them — sameListing's -12 penalty was not enough.
  const upstairs = { ...hemnetSale, sizeNum: 81, size: "81 m²", rooms: "3 rum", floor: 7, soldPrice: 5895000 };
  const downstairs = { ...booliSale, sizeNum: 81, size: "81 m²", rooms: "3 rum", floor: 4, soldPrice: 5800000 };
  const verdict = sameSale(downstairs, upstairs);
  assert.equal(verdict.same, false);
  assert.ok(verdict.reasons.some((r) => /floor differs — different apartment/.test(r)));
});

test("sameSale separates two near-identical flats sold days apart", () => {
  // Real Årsta case: Rämensvägen 45, both 45 m² 2-rooms on floor 3, 15 days apart
  // for 2 825 000 and 2 880 000 — a 2% price tolerance merged these and ate a comp.
  const a = { ...booliSale, sizeNum: 45, size: "45 m²", floor: 3, soldPrice: 2825000, soldDate: "2026-06-11" };
  const b = { ...hemnetSale, sizeNum: 45, size: "45 m²", floor: 3, soldPrice: 2880000, soldDate: new Date("2026-05-27") };
  assert.equal(sameSale(a, b).same, false);
});

test("isDifferentRecordFromSameSource distinguishes structurally, not heuristically", () => {
  const storedBooli = { booliId: "111", sources: [{ source: "booli", sourceId: "111" }] };
  // same source, different id => different sale, whatever the attributes say
  assert.equal(isDifferentRecordFromSameSource({ ...booliSale, booliId: "222" }, storedBooli), true);
  // same source, same id => the same record (a re-run)
  assert.equal(isDifferentRecordFromSameSource({ ...booliSale, booliId: "111" }, storedBooli), false);
  // a Hemnet-only document is cross-source — merging is exactly what we want
  assert.equal(isDifferentRecordFromSameSource(booliSale, hemnetSale), false);
});

test("findCanonicalSoldMatch will not merge two records from the same source", async () => {
  // Both from Booli, attributes identical, different Booli ids: two real sales.
  const storedBooli = {
    ...hemnetSale,
    _id: "b1",
    hemnetId: undefined,
    booliId: "6086409",
    sources: [{ source: "booli", sourceId: "6086409" }],
  };
  const model = fakeSoldModel([storedBooli]);
  const other = { ...booliSale, booliId: "6143428" };
  assert.equal(await findCanonicalSoldMatch(other, { SoldListing: model }), null);
});

test("sameSale does not merge a different flat at the same address", () => {
  const neighbour = { ...hemnetSale, sizeNum: 78, size: "78 m²", rooms: "3 rum" };
  assert.equal(sameSale(booliSale, neighbour).same, false);
});

test("findCanonicalSoldMatch only queries the record's fingerprint bucket", async () => {
  const model = fakeSoldModel([hemnetSale]);
  const match = await findCanonicalSoldMatch(booliSale, { SoldListing: model });
  assert.equal(match.hemnetId, "21672135");
  assert.deepEqual(model.calls.queries[0], { fingerprintKey: "arsta|55|2" });
});

test("findCanonicalSoldMatch returns null when the record can't be bucketed", async () => {
  const model = fakeSoldModel([hemnetSale]);
  const unbucketable = { ...booliSale, locationDescription: null, area: null };
  assert.equal(await findCanonicalSoldMatch(unbucketable, { SoldListing: model }), null);
  assert.equal(model.calls.queries.length, 0, "must not scan the collection");
});

test("buildSoldMergeUpdate fills blanks but never overwrites stored values", () => {
  const existing = { ...hemnetSale, floor: null, daysOnMarket: null, coordinates: { lat: null, lng: null } };
  const update = buildSoldMergeUpdate(existing, booliSale);
  assert.equal(update.set.floor, 5); // was blank → filled
  assert.equal(update.set.daysOnMarket, 39);
  assert.deepEqual(update.set.coordinates, booliSale.coordinates);
  assert.equal(update.set.booliId, "6171318");
  // Hemnet's own values are authoritative and must be untouched
  assert.equal("soldPrice" in update.set, false);
  assert.equal("soldPriceSqm" in update.set, false);
  assert.equal("brfName" in update.set, false);
  assert.equal(update.push.source, "booli");
});

test("buildSoldMergeUpdate never clobbers our renovation analysis", () => {
  const analysed = { ...hemnetSale, renovationScore: 8, conditionLabel: "unrenovated", images: ["a.jpg"] };
  const update = buildSoldMergeUpdate(analysed, booliSale);
  for (const field of ["renovationScore", "renovationConfidence", "renovationSummary", "renovationRooms", "conditionLabel", "images"]) {
    assert.equal(field in update.set, false, `${field} must not be written by a Booli merge`);
  }
});

test("buildSoldMergeUpdate returns null when there is nothing to add", () => {
  const complete = {
    ...hemnetSale,
    floor: 5,
    daysOnMarket: 39,
    housingForm: "Lägenhet",
    askingPrice: "3 395 000 kr",
    askingPriceNum: 3395000,
    priceChange: 6,
    coordinates: { lat: 59.29828141, lng: 18.04782648 },
    booliId: "6171318",
    sources: [{ source: "hemnet", sourceId: "21672135" }, { source: "booli", sourceId: "6171318" }],
  };
  assert.equal(buildSoldMergeUpdate(complete, booliSale), null);
});

test("buildSoldInsert leaves hemnetId unset and stamps provenance", () => {
  const doc = buildSoldInsert(booliSale);
  assert.equal("hemnetId" in doc, false, "a Booli-only sale has no Hemnet id");
  assert.equal(doc.booliId, "6171318");
  assert.equal(doc.fingerprintKey, blockingKey(booliSale));
  assert.equal(doc.sources[0].source, "booli");
  assert.ok(doc.soldDate instanceof Date);
});

test("isUsableSoldComp rejects records that can't serve as comps", () => {
  assert.equal(isUsableSoldComp(booliSale), true);
  assert.equal(isUsableSoldComp({ ...booliSale, soldPrice: null }), false);
  assert.equal(isUsableSoldComp({ ...booliSale, sizeNum: 0 }), false);
  assert.equal(isUsableSoldComp({ ...booliSale, soldDate: null }), false);
  assert.equal(isUsableSoldComp({ ...booliSale, streetAddress: null }), false);
});

test("ingestBooliSold merges an overlapping sale and inserts a new one", async () => {
  const model = fakeSoldModel([{ ...hemnetSale, floor: null }]);
  const newSale = {
    ...booliSale,
    booliId: "999",
    streetAddress: "Möckelvägen 32",
    sizeNum: 42,
    size: "42 m²",
    soldPrice: 2375000,
    soldPriceSqm: 56500,
  };
  const summary = await ingestBooliSold({ records: [booliSale, newSale], SoldListing: model, dryRun: false });
  assert.equal(summary.merged, 1);
  assert.equal(summary.inserted, 1);
  assert.equal(model.calls.created.length, 1);
  assert.equal(model.calls.created[0].streetAddress, "Möckelvägen 32");
  assert.equal(model.calls.updated.length, 1);
  assert.equal(model.calls.updated[0].update.$push.sources.source, "booli");
});

test("ingestBooliSold writes nothing on a dry run", async () => {
  const model = fakeSoldModel([{ ...hemnetSale, floor: null }]);
  const summary = await ingestBooliSold({
    records: [booliSale, { ...booliSale, booliId: "999", streetAddress: "Nowhere 1", sizeNum: 30, size: "30 m²" }],
    SoldListing: model,
    dryRun: true,
  });
  assert.equal(summary.merged, 1);
  assert.equal(summary.inserted, 1);
  assert.equal(model.calls.created.length, 0);
  assert.equal(model.calls.updated.length, 0);
});

test("ingestBooliSold skips unusable records instead of storing half-comps", async () => {
  const model = fakeSoldModel([]);
  const summary = await ingestBooliSold({
    records: [{ ...booliSale, soldPrice: null }, { ...booliSale, sizeNum: null }],
    SoldListing: model,
    dryRun: false,
  });
  assert.equal(summary.skipped, 2);
  assert.equal(summary.inserted, 0);
  assert.equal(model.calls.created.length, 0);
});

test("ingestBooliSold re-run is idempotent once provenance is recorded", async () => {
  // Second run over the same Booli page must not re-push a duplicate source entry.
  const stored = {
    ...hemnetSale,
    floor: 5,
    daysOnMarket: 39,
    housingForm: "Lägenhet",
    askingPrice: "3 395 000 kr",
    askingPriceNum: 3395000,
    priceChange: 6,
    coordinates: booliSale.coordinates,
    booliId: "6171318",
    sources: [{ source: "hemnet", sourceId: "21672135" }, { source: "booli", sourceId: "6171318" }],
  };
  const model = fakeSoldModel([stored]);
  const summary = await ingestBooliSold({ records: [booliSale], SoldListing: model, dryRun: false });
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.merged, 0);
  assert.equal(model.calls.updated.length, 0);
});

test("a Hemnet sold record as scrape-sold stores it CAN be fingerprinted", () => {
  // The fields api/scrape-sold.js writes must be enough to produce a blocking key —
  // otherwise newly scraped sales land unfingerprinted and are invisible to Booli
  // dedup, so the same sale gets stored twice and double-weighted in the kr/m²
  // percentile. Observed drift before the scraper stamped it: 9852 stored, 9838 keyed.
  const asStored = {
    streetAddress: "Årstavägen 70",
    locationDescription: "Årsta",
    area: "Årsta",
    rooms: "2 rum",
    size: "55 m²",
    sizeNum: 55,
    soldPrice: 3600000,
  };
  assert.equal(blockingKey(asStored), "arsta|55|2");

  // And a sale missing the area still degrades honestly to null rather than
  // bucketing wrongly (ingest then inserts instead of risking a loose merge).
  assert.equal(blockingKey({ ...asStored, locationDescription: null, area: null }), null);
});
