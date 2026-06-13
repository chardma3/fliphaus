const test = require("node:test");
const assert = require("node:assert/strict");

const { isProjectListing } = require("../api/project-listing");

test("name-only addresses are new-build/projekt listings", () => {
  // Real examples seen in the data.
  for (const addr of ["Sjöhusen i Klockelund", "Fågelboet", "Fransyskan", "Haga Palett Ockra", "Hassellunden", "Skogsvaktaren"]) {
    assert.equal(isProjectListing({ streetAddress: addr }), true, addr);
  }
  assert.equal(isProjectListing("Fransyskan"), true, "accepts a bare string too");
});

test("numbered street addresses are NOT projekt listings", () => {
  for (const addr of ["Bergshöjden 34", "Nynäsvägen 342 B", "Tyska Bottens Väg 37G A-1303", "Garvis Carlssons gata 32"]) {
    assert.equal(isProjectListing({ streetAddress: addr }), false, addr);
  }
});

test("a missing address is not treated as a projekt listing", () => {
  assert.equal(isProjectListing({ streetAddress: null }), false);
  assert.equal(isProjectListing({}), false);
  assert.equal(isProjectListing(null), false);
});
