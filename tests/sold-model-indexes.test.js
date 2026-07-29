const test = require("node:test");
const assert = require("node:assert/strict");

// Requiring the model only registers the schema — no DB connection needed.
const SoldListing = require("../models/sold.model");

// Mongoose reports schema-declared indexes as [keys, options] pairs. Field-level
// `unique: true` shows up here too.
function findIndex(field) {
  return SoldListing.schema.indexes().find(([keys]) => Object.keys(keys)[0] === field);
}

test("booliId is unique via a PARTIAL filter, never sparse", () => {
  // A sparse unique index still indexes documents that STORE `booliId: null`, so
  // building it over the ~9.8k existing Hemnet-only sold records fails with
  //   E11000 duplicate key … index: booliId_1 dup key: { booliId: null }
  // which is exactly how the first production migration died. A partial filter on
  // $type:"string" excludes those documents instead.
  const entry = findIndex("booliId");
  assert.ok(entry, "booliId must have a declared index");
  const [, options] = entry;
  assert.equal(options.unique, true);
  assert.deepEqual(options.partialFilterExpression, { booliId: { $type: "string" } });
  assert.notEqual(options.sparse, true, "sparse would reintroduce the null-collision bug");
});

test("booliId has no null default, so Hemnet-only sales omit the field", () => {
  const path = SoldListing.schema.path("booliId");
  assert.ok(path, "booliId must exist on the schema");
  assert.equal(path.defaultValue, undefined, "a null default is what wrote the colliding nulls");
});

test("hemnetId stays unique but sparse, so Booli-only sales can be stored", () => {
  const path = SoldListing.schema.path("hemnetId");
  assert.equal(path.options.unique, true);
  assert.equal(path.options.sparse, true);
});

test("index management is explicit, not on every boot", () => {
  // Production carried an index whose definition changed; retrying that build on
  // each boot fails with IndexOptionsConflict, and a failed autoIndex build
  // surfaces as an error event on the model.
  assert.equal(SoldListing.schema.options.autoIndex, false);
});

test("fingerprintKey is indexed — the dedup lookup depends on it", () => {
  const path = SoldListing.schema.path("fingerprintKey");
  assert.equal(path.options.index, true);
});
