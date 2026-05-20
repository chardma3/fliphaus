const test = require("node:test");
const assert = require("node:assert/strict");

const { findBestSoldMatch, scoreSoldMatch } = require("../api/reconcile-sold");

test("sold reconciliation confirms strong address, size, room, and area matches", () => {
  const listing = {
    streetAddress: "Skrakgränd 3",
    size: "76 m²",
    rooms: "4 rum",
    locationDescription: "Farsta, Stockholms kommun",
    brfName: "Brf Test",
  };
  const sold = {
    hemnetId: "sold-1",
    streetAddress: "Skrakgränd 3",
    size: "75.5 m²",
    rooms: "4 rum",
    locationDescription: "Farsta, Stockholms kommun",
    brfName: "BRF Test",
    soldPrice: 2600000,
  };

  const match = findBestSoldMatch(listing, [sold]);

  assert.ok(match);
  assert.equal(match.sold.hemnetId, "sold-1");
  assert.ok(match.score >= 80);
});

test("sold reconciliation rejects weak matches", () => {
  const listing = {
    streetAddress: "Skrakgränd 3",
    size: "76 m²",
    rooms: "4 rum",
    locationDescription: "Farsta, Stockholms kommun",
  };
  const sold = {
    hemnetId: "sold-2",
    streetAddress: "Differentgatan 9",
    size: "52 m²",
    rooms: "2 rum",
    locationDescription: "Rissne, Sundbybergs kommun",
  };

  const score = scoreSoldMatch(listing, sold);
  const match = findBestSoldMatch(listing, [sold]);

  assert.ok(score.score < 80);
  assert.equal(match, null);
});

test("disappeared active listing is not automatically confirmed sold without sold match", () => {
  const listing = {
    status: "disappeared",
    streetAddress: "Skrakgränd 3",
    size: "76 m²",
    rooms: "4 rum",
    locationDescription: "Farsta, Stockholms kommun",
  };

  const match = findBestSoldMatch(listing, []);

  assert.equal(match, null);
});
