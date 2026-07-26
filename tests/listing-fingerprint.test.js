const test = require("node:test");
const assert = require("node:assert/strict");

const { blockingKey, sameListing, metresApart } = require("../api/listing-fingerprint");

const hemnet = {
  streetAddress: "Årstavägen 67",
  size: "72 m²",
  rooms: "3 rum",
  floor: "3 tr",
  coordinates: { lat: 59.298, lng: 18.045 },
  locationDescription: "Årsta, Stockholm",
  brfName: "Brf Årsta",
};

test("same flat from another source (Booli) matches, despite formatting differences", () => {
  const booli = {
    streetAddress: "Årstavägen 67",
    size: "72", // no unit suffix
    rooms: "3 rum",
    floor: "vån 3", // different floor phrasing, same number
    coordinates: { lat: 59.29801, lng: 18.04502 }, // ~1.5m away
    locationDescription: "Årsta",
  };
  const r = sameListing(hemnet, booli);
  assert.equal(r.same, true, r.reasons.join(", "));
});

test("coordinates rescue a same-flat match when the address string differs (floor in address)", () => {
  const other = {
    streetAddress: "Årstavägen 67, 3tr", // floor folded into address → weak token overlap
    size: "72",
    rooms: "3 rum",
    coordinates: { lat: 59.298, lng: 18.045 },
  };
  assert.equal(sameListing(hemnet, other).same, true);
});

test("no-coordinates fallback still matches on exact address + size + rooms", () => {
  const noCoords = { streetAddress: "Årstavägen 67", size: "72 m²", rooms: "3 rum" };
  assert.equal(sameListing(hemnet, noCoords).same, true);
});

test("a re-listing of the identical flat matches", () => {
  assert.equal(sameListing(hemnet, { ...hemnet }).same, true);
});

test("a different-size unit in the SAME building does NOT match (size conflict)", () => {
  const neighbour = {
    streetAddress: "Årstavägen 67",
    size: "45 m²",
    rooms: "2 rum",
    floor: "1 tr",
    coordinates: { lat: 59.298, lng: 18.045 }, // same building
  };
  const r = sameListing(hemnet, neighbour);
  assert.equal(r.same, false, r.reasons.join(", "));
});

test("same size but a different location does NOT match (no location anchor)", () => {
  const elsewhere = {
    streetAddress: "Sveavägen 12",
    size: "72 m²",
    rooms: "3 rum",
    coordinates: { lat: 59.34, lng: 18.06 }, // ~5km away
    locationDescription: "Vasastan",
  };
  assert.equal(sameListing(hemnet, elsewhere).same, false);
});

test("blockingKey buckets the same flat identically across sources, null when unbucketable", () => {
  const booli = { locationDescription: "Årsta", size: "72", rooms: "3 rum" };
  assert.equal(blockingKey(hemnet), blockingKey(booli));
  assert.equal(blockingKey(hemnet), "arsta|72|3");
  assert.equal(blockingKey({ streetAddress: "No area or size" }), null);
});

test("metresApart is ~0 for identical points and null when a coordinate is missing", () => {
  assert.ok(metresApart({ lat: 59.3, lng: 18 }, { lat: 59.3, lng: 18 }) < 0.001);
  assert.equal(metresApart({ lat: 59.3, lng: 18 }, null), null);
  assert.equal(metresApart({ lat: 59.3 }, { lat: 59.3, lng: 18 }), null);
});
