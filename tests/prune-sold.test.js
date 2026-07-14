const test = require("node:test");
const assert = require("node:assert/strict");

const { pruneOldSold, retentionMonths, cutoffDate } = require("../api/prune-sold");

// Stub SoldListing: countDocuments/deleteMany record the filter they were given.
function makeSold({ matchCount = 0 } = {}) {
  const calls = { countFilter: null, deleteFilter: null, deleted: false };
  return {
    calls,
    async countDocuments(filter) { calls.countFilter = filter; return matchCount; },
    async deleteMany(filter) { calls.deleteFilter = filter; calls.deleted = true; return { deletedCount: matchCount }; },
  };
}

const NOW = new Date("2026-07-14T00:00:00Z").getTime();

test("retentionMonths reads SOLD_RETENTION_MONTHS, defaults to 15", () => {
  assert.equal(retentionMonths({}), 15);
  assert.equal(retentionMonths({ SOLD_RETENTION_MONTHS: "12" }), 12);
  assert.equal(retentionMonths({ SOLD_RETENTION_MONTHS: "0" }), 15); // invalid → default
  assert.equal(retentionMonths({ SOLD_RETENTION_MONTHS: "notnum" }), 15);
});

test("cutoffDate is the given number of months before now", () => {
  const c = cutoffDate(15, NOW);
  const monthsBack = (NOW - c.getTime()) / (30.44 * 86400000);
  assert.ok(Math.abs(monthsBack - 15) < 0.01);
});

test("filter targets only dated rows older than the cutoff (never null-date rows)", async () => {
  const SoldListing = makeSold({ matchCount: 42 });
  const result = await pruneOldSold({ SoldListing, months: 15, dryRun: true, now: NOW });
  assert.deepEqual(SoldListing.calls.countFilter.soldDate.$ne, null); // excludes null soldDate
  assert.ok(SoldListing.calls.countFilter.soldDate.$lt instanceof Date);
  assert.equal(result.matched, 42);
});

test("dryRun counts but deletes nothing", async () => {
  const SoldListing = makeSold({ matchCount: 42 });
  const result = await pruneOldSold({ SoldListing, dryRun: true, now: NOW });
  assert.equal(result.dryRun, true);
  assert.equal(result.matched, 42);
  assert.equal(result.deleted, 0);
  assert.equal(SoldListing.calls.deleted, false, "deleteMany must not be called on a dry run");
});

test("a real run deletes the matched rows", async () => {
  const SoldListing = makeSold({ matchCount: 42 });
  const result = await pruneOldSold({ SoldListing, dryRun: false, now: NOW });
  assert.equal(result.deleted, 42);
  assert.equal(SoldListing.calls.deleted, true);
  assert.deepEqual(SoldListing.calls.deleteFilter, SoldListing.calls.countFilter);
});

test("nothing to delete → no deleteMany call even on a real run", async () => {
  const SoldListing = makeSold({ matchCount: 0 });
  const result = await pruneOldSold({ SoldListing, dryRun: false, now: NOW });
  assert.equal(result.matched, 0);
  assert.equal(result.deleted, 0);
  assert.equal(SoldListing.calls.deleted, false);
});
