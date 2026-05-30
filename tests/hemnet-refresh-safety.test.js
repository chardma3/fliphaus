const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  assertHemnetPageUsable,
  assertNonEmptyRefreshResult,
  planDisappearanceReconciliation,
  resolveSoldScrapeTargets,
} = require("../api/hemnet-refresh-safety");

test("Hemnet bot protection pages fail clearly instead of looking like zero listings", () => {
  assert.throws(
    () => assertHemnetPageUsable({
      html: "<html><title>Just a moment...</title><body>Security verification</body></html>",
      hasNextData: false,
      url: "https://www.hemnet.se/bostader?location_ids[]=473493",
      areaName: "Rissne",
      dataset: "active listings",
    }),
    /Hemnet bot protection detected.*Rissne.*active listings/i
  );
});

test("Hemnet pages missing NEXT data fail clearly before database updates", () => {
  assert.throws(
    () => assertHemnetPageUsable({
      html: "<html><body>No app data here</body></html>",
      hasNextData: false,
      url: "https://www.hemnet.se/salda/bostader?location_ids[]=925962",
      areaName: "Farsta",
      dataset: "sold listings",
    }),
    /Hemnet page missing __NEXT_DATA__.*Farsta.*sold listings/i
  );
});

test("zero active-listing refresh is unsafe and must not mark existing listings disappeared", () => {
  assert.throws(
    () => assertNonEmptyRefreshResult({ total: 0, dataset: "active listings" }),
    /Refusing to persist zero active listings/i
  );
});

test("a complete scrape reconciles disappearances normally", () => {
  const plan = planDisappearanceReconciliation({
    scrapedAreas: ["Rissne", "Farsta"],
    failedAreas: [],
  });
  assert.equal(plan.partial, false);
  assert.equal(plan.reconcile, true);
});

test("a partial scrape must NOT reconcile disappearances (the 50-disappeared incident)", () => {
  const plan = planDisappearanceReconciliation({
    scrapedAreas: ["Farsta"],
    failedAreas: ["Rissne"],
  });
  assert.equal(plan.partial, true);
  assert.equal(plan.reconcile, false);
  assert.match(plan.reason, /Rissne/);
  assert.match(plan.reason, /Skipping disappearance reconciliation/i);
});

test("a scrape where every area failed is treated as partial (no reconciliation)", () => {
  const plan = planDisappearanceReconciliation({
    scrapedAreas: [],
    failedAreas: ["Rissne", "Farsta"],
  });
  assert.equal(plan.partial, true);
  assert.equal(plan.reconcile, false);
});

test("planDisappearanceReconciliation defaults to a safe (complete) plan with no args", () => {
  const plan = planDisappearanceReconciliation();
  assert.equal(plan.partial, false);
  assert.equal(plan.reconcile, true);
});

test("sold scrape can be split by area for shorter cron requests", () => {
  const targets = resolveSoldScrapeTargets({ area: "Farsta" });
  assert.deepEqual(targets, [{ area: "Farsta", locationId: 925962 }]);

  assert.throws(
    () => resolveSoldScrapeTargets({ area: "Unknown" }),
    /Unknown sold scrape area/i
  );
});

test("refresh workflow keeps active scrape bounded and splits sold scraping into area requests", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "refresh-fliphaus.yml"), "utf8");
  assert.match(workflow, /api\/scrape\?includeDetails=false/);
  assert.match(workflow, /--max-time 300/);
  assert.match(workflow, /--retry 2/);
  assert.match(workflow, /--retry-all-errors/);
  assert.match(workflow, /api\/scrape-sold\?area=Rissne/);
  assert.match(workflow, /api\/scrape-sold\?area=Farsta/);
  assert.match(workflow, /api\/analyze-images\?dataset=all&limit=10/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /detailLimit=5/);
  assert.match(workflow, /includeDetails=false/);
  assert.match(workflow, /includeAnalysis=false/);
});
