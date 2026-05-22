const test = require("node:test");
const assert = require("node:assert/strict");

const { presentListingForFeed } = require("../api/listing-presenter");

test("feed presentation preserves lifecycle status separately from saved/rejected preference", () => {
  const listing = {
    id: "21672135",
    streetAddress: "Skrakgränd 3",
    status: "disappeared",
    soldStatusConfidence: "unconfirmed",
  };

  const presented = presentListingForFeed(listing, "rejected");

  assert.equal(presented.status, "disappeared");
  assert.equal(presented.listingStatus, "disappeared");
  assert.equal(presented.preferenceStatus, "rejected");
  assert.equal(presented.soldStatusConfidence, "unconfirmed");
});

test("feed presentation keeps active listings active when there is no user preference", () => {
  const listing = {
    id: "active-1",
    streetAddress: "Active listing",
    status: "active",
  };

  const presented = presentListingForFeed(listing, null);

  assert.equal(presented.status, "active");
  assert.equal(presented.listingStatus, "active");
  assert.equal(presented.preferenceStatus, null);
});
