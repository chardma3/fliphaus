const test = require("node:test");
const assert = require("node:assert/strict");

const { sourceEntry, findCanonicalMatch } = require("../api/listing-ingest");
const { blockingKey } = require("../api/listing-fingerprint");

// Minimal fake mirroring Listing.find({ fingerprintKey, status: { $ne: "removed" } }).
function fakeListing(docs) {
  return {
    find: async (q) =>
      docs.filter((d) => d.fingerprintKey === q.fingerprintKey && d.status !== "removed"),
  };
}

const hemnetDoc = {
  streetAddress: "Årstavägen 67",
  size: "72 m²",
  rooms: "3 rum",
  floor: "3 tr",
  coordinates: { lat: 59.298, lng: 18.045 },
  locationDescription: "Årsta, Stockholm",
  status: "active",
  fingerprintKey: "arsta|72|3",
  sources: [{ source: "hemnet", sourceId: "H1" }],
};

test("sourceEntry builds a normalized provenance entry", () => {
  const e = sourceEntry("booli", 12345, "https://booli.se/x", new Date("2026-07-26T00:00:00Z"));
  assert.equal(e.source, "booli");
  assert.equal(e.sourceId, "12345"); // coerced to string
  assert.equal(e.url, "https://booli.se/x");
  assert.deepEqual(e.firstSeen, new Date("2026-07-26T00:00:00Z"));
});

test("a Booli record for the same flat finds the existing Hemnet listing", async () => {
  const incoming = {
    streetAddress: "Årstavägen 67",
    size: "72",
    rooms: "3 rum",
    coordinates: { lat: 59.29801, lng: 18.04502 },
    locationDescription: "Årsta",
  };
  // sanity: they share a bucket
  assert.equal(blockingKey(incoming), hemnetDoc.fingerprintKey);
  const match = await findCanonicalMatch(incoming, { Listing: fakeListing([hemnetDoc]) });
  assert.equal(match, hemnetDoc);
});

test("a different-size flat in the same bucket area does not match (creates new, returns null)", async () => {
  const incoming = {
    streetAddress: "Årstavägen 99",
    size: "72",
    rooms: "3 rum",
    coordinates: { lat: 59.31, lng: 18.06 }, // far from hemnetDoc
    locationDescription: "Årsta",
  };
  const match = await findCanonicalMatch(incoming, { Listing: fakeListing([hemnetDoc]) });
  assert.equal(match, null);
});

test("an unbucketable record returns null without a wrong merge", async () => {
  const incoming = { streetAddress: "No area, no size" };
  const match = await findCanonicalMatch(incoming, { Listing: fakeListing([hemnetDoc]) });
  assert.equal(match, null);
});

test("a removed listing in the bucket is ignored", async () => {
  const removed = { ...hemnetDoc, status: "removed" };
  const incoming = {
    streetAddress: "Årstavägen 67",
    size: "72",
    rooms: "3 rum",
    coordinates: { lat: 59.298, lng: 18.045 },
    locationDescription: "Årsta",
  };
  const match = await findCanonicalMatch(incoming, { Listing: fakeListing([removed]) });
  assert.equal(match, null);
});
