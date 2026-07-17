const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  LOCATION_IDS,
  ACTIVE_SCRAPE_BATCHES,
  getAreaBatch,
  resolveActiveScrapeTargets,
  assertHemnetPageUsable,
  assertNonEmptyRefreshResult,
  planDisappearanceReconciliation,
  buildStaleListingQuery,
  buildAreaDisappearanceQuery,
  resolveSoldScrapeTargets,
} = require("../api/hemnet-refresh-safety");

test("getAreaBatch splits LOCATION_IDS into contiguous, complete, non-overlapping batches", () => {
  const all = Object.keys(LOCATION_IDS);
  const batches = [];
  for (let n = 1; n <= ACTIVE_SCRAPE_BATCHES; n++) batches.push(getAreaBatch(n));
  // Union of all batches == every area, with nothing duplicated or dropped.
  assert.deepEqual(batches.flat().sort(), [...all].sort());
  assert.equal(new Set(batches.flat()).size, all.length);
  // Each batch is small enough to keep one /api/scrape request under the timeout.
  const maxSize = Math.ceil(all.length / ACTIVE_SCRAPE_BATCHES);
  for (const b of batches) assert.ok(b.length <= maxSize, `batch size ${b.length} <= ${maxSize}`);
});

test("getAreaBatch rejects out-of-range batch numbers", () => {
  assert.throws(() => getAreaBatch(0), /Invalid scrape batch/);
  assert.throws(() => getAreaBatch(ACTIVE_SCRAPE_BATCHES + 1), /Invalid scrape batch/);
});

test("resolveActiveScrapeTargets: default = all areas, with location ids", () => {
  const all = resolveActiveScrapeTargets({});
  assert.equal(all.length, Object.keys(LOCATION_IDS).length);
  assert.equal(all[0].locationId, LOCATION_IDS[all[0].area]);
});

test("resolveActiveScrapeTargets honours batch and a named (case-insensitive) subset", () => {
  assert.deepEqual(resolveActiveScrapeTargets({ batch: 1 }).map((t) => t.area), getAreaBatch(1));
  const named = resolveActiveScrapeTargets({ areas: "solna, Kista" });
  assert.deepEqual(named.map((t) => t.area), ["Solna", "Kista"]);
});

test("resolveActiveScrapeTargets throws on an unknown area name", () => {
  assert.throws(() => resolveActiveScrapeTargets({ areas: "Atlantis" }), /Unknown scrape area/);
});

test("area disappearance query is scoped to scraped areas, unseen ids, and a grace cutoff", () => {
  const cutoff = new Date("2026-06-22T17:00:00.000Z");
  assert.deepEqual(
    buildAreaDisappearanceQuery({ scrapedAreas: ["Solna", "Kista"], currentIds: ["a"], cutoff }),
    {
      status: "active",
      area: { $in: ["Solna", "Kista"] },
      id: { $nin: ["a"] },
      $or: [{ lastSeenAt: { $lt: cutoff } }, { lastSeenAt: null }],
    }
  );
});

test("stale-listing query targets only long-unseen active listings not seen this run", () => {
  const cutoff = new Date("2026-05-25T00:00:00.000Z");
  assert.deepEqual(buildStaleListingQuery({ currentIds: ["a", "b"], cutoff }), {
    status: "active",
    id: { $nin: ["a", "b"] },
    $or: [{ lastSeenAt: { $lt: cutoff } }, { lastSeenAt: null }],
  });
});

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

const workflowDir = path.join(__dirname, "..", ".github", "workflows");
const readWorkflow = (name) => fs.readFileSync(path.join(workflowDir, name), "utf8");

test("sold-refresh workflow fires a single quick background trigger, not area-by-area curl-waiting", () => {
  const workflow = readWorkflow("refresh-fliphaus.yml");
  // One fire-and-forget POST; the scrape/analyse/reconcile/precompute chain runs
  // in the background on Render (see /api/refresh-sold-all).
  assert.match(workflow, /api\/refresh-sold-all/);
  assert.match(workflow, /-X POST/);
  assert.match(workflow, /continue-on-error: true/);
  // The trigger must return fast — no 600s per-area ceilings any more.
  assert.doesNotMatch(workflow, /--max-time 600/);
  // Rissne (northern Sundbyberg) was dropped 2026-06-19 — must not be scraped.
  assert.doesNotMatch(workflow, /area=Rissne/);
  // The active listing scrape moved to the staggered scrape-batch-* workflows.
  assert.doesNotMatch(workflow, /api\/scrape\?/);
});

test("each staggered batch workflow scrapes exactly one bounded batch at its own cron", () => {
  const crons = [];
  for (let n = 1; n <= 3; n++) {
    const wf = readWorkflow(`scrape-batch-${n}.yml`);
    assert.match(wf, new RegExp(`api/scrape\\?includeDetails=false&batch=${n}`));
    assert.match(wf, /--max-time 300/);
    assert.match(wf, /--retry 2/);
    assert.match(wf, /workflow_dispatch:/); // manually triggerable for verification
    const m = wf.match(/cron:\s*"([^"]+)"/);
    assert.ok(m, `batch ${n} has a cron`);
    crons.push(m[1]);
  }
  // Distinct fire times so two batches never hit the single instance at once.
  assert.equal(new Set(crons).size, 3);
});
