const test = require("node:test");
const assert = require("node:assert/strict");

const { buildActiveScrapeOptions, shouldFetchActiveDetails } = require("../api/scrape-options");

test("active scrape fetches listing details by default", () => {
  assert.equal(shouldFetchActiveDetails({}), true);
  assert.deepEqual(buildActiveScrapeOptions({}), { includeDetails: true });
});

test("active scrape can skip listing detail pages for scheduled refreshes", () => {
  assert.equal(shouldFetchActiveDetails({ includeDetails: false }), false);
  assert.deepEqual(buildActiveScrapeOptions({ includeDetails: "false" }), { includeDetails: false });
});

test("active scrape treats any query value except literal false as detail-enabled", () => {
  assert.equal(shouldFetchActiveDetails({ includeDetails: "true" }), true);
  assert.equal(shouldFetchActiveDetails({ includeDetails: "0" }), true);
});
