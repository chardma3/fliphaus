const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildActiveScrapeOptions,
  buildImageAnalysisOptions,
  buildListingUpsert,
  buildSoldScrapeOptions,
  shouldFetchActiveDetails,
} = require("../api/scrape-options");

test("active scrape fetches listing details by default and scopes to all areas", () => {
  assert.equal(shouldFetchActiveDetails({}), true);
  assert.deepEqual(buildActiveScrapeOptions({}), { includeDetails: true, batch: null, areas: null });
});

test("active scrape can skip listing detail pages for scheduled refreshes", () => {
  assert.equal(shouldFetchActiveDetails({ includeDetails: false }), false);
  assert.deepEqual(buildActiveScrapeOptions({ includeDetails: "false" }), { includeDetails: false, batch: null, areas: null });
});

test("active scrape passes through batch / areas scoping for staggered runs", () => {
  assert.deepEqual(buildActiveScrapeOptions({ batch: "2" }), { includeDetails: true, batch: "2", areas: null });
  assert.deepEqual(buildActiveScrapeOptions({ areas: "Solna,Kista" }), { includeDetails: true, batch: null, areas: "Solna,Kista" });
  // Empty strings are treated as "not provided" so a stray ?batch= scrapes all areas.
  assert.deepEqual(buildActiveScrapeOptions({ batch: "", areas: "" }), { includeDetails: true, batch: null, areas: null });
});

test("scrape upsert seeds images on insert only, never overwriting a curated gallery", () => {
  const fields = { status: "active", askingPriceNum: 2500000 };
  const upsert = buildListingUpsert(fields, ["thumb0", "thumb1"]);
  // Scalar fields go in $set (applied every run); images only via $setOnInsert
  // so an existing doc's analyser-curated gallery survives the scrape.
  assert.deepEqual(upsert.$set, fields);
  assert.deepEqual(upsert.$setOnInsert, { images: ["thumb0", "thumb1"] });
  assert.ok(!("images" in upsert.$set), "images must not be in $set");
});

test("scrape upsert tolerates missing images", () => {
  const upsert = buildListingUpsert({ status: "active" }, undefined);
  assert.deepEqual(upsert.$setOnInsert, { images: [] });
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

test("image analysis refresh defaults to a small post-scrape batch", () => {
  assert.deepEqual(buildImageAnalysisOptions({}), {
    dataset: "all",
    limit: 10,
    onlyMissing: true,
    target: null,
    reanalyzeBefore: null,
    reanalyzeMinScore: null,
  });
});

test("image analysis refresh validates dataset and caps batch size", () => {
  assert.deepEqual(buildImageAnalysisOptions({ dataset: "sold", limit: "99", onlyMissing: "false" }), {
    dataset: "sold",
    limit: 25,
    onlyMissing: false,
    target: null,
    reanalyzeBefore: null,
    reanalyzeMinScore: null,
  });
  assert.deepEqual(buildImageAnalysisOptions({ dataset: "bad", limit: "0" }), {
    dataset: "all",
    limit: 1,
    onlyMissing: true,
    target: null,
    reanalyzeBefore: null,
    reanalyzeMinScore: null,
  });
});

test("image analysis refresh parses a reanalyzeBefore cutoff and optional min score", () => {
  const opts = buildImageAnalysisOptions({ reanalyzeBefore: "2026-06-21T00:00:00.000Z", reanalyzeMinScore: "7" });
  assert.equal(opts.reanalyzeBefore.toISOString(), "2026-06-21T00:00:00.000Z");
  assert.equal(opts.reanalyzeMinScore, 7);
  // Garbage date is ignored.
  assert.equal(buildImageAnalysisOptions({ reanalyzeBefore: "not-a-date" }).reanalyzeBefore, null);
});

test("image analysis refresh accepts a single-listing target by id, slug or listing", () => {
  assert.equal(buildImageAnalysisOptions({ listing: "  abc123 " }).target, "abc123");
  assert.equal(buildImageAnalysisOptions({ id: "999" }).target, "999");
  assert.equal(buildImageAnalysisOptions({ slug: "lagenhet-3rum-farsta" }).target, "lagenhet-3rum-farsta");
  assert.equal(buildImageAnalysisOptions({}).target, null);
});
