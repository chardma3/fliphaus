const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildActiveScrapeOptions,
  buildSoldScrapeOptions,
  shouldFetchActiveDetails,
} = require("../api/scrape-options");

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

test("sold scrape defaults to detail pages and image analysis", () => {
  assert.deepEqual(buildSoldScrapeOptions({ area: "Rissne", detailLimit: "20" }), {
    area: "Rissne",
    detailLimit: "20",
    includeDetails: true,
    includeAnalysis: true,
  });
});

test("sold scrape can skip detail pages and image analysis for scheduled refreshes", () => {
  assert.deepEqual(buildSoldScrapeOptions({
    area: "Farsta",
    detailLimit: "5",
    includeDetails: "false",
    includeAnalysis: "false",
  }), {
    area: "Farsta",
    detailLimit: "5",
    includeDetails: false,
    includeAnalysis: false,
  });
});
