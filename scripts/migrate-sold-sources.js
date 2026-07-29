#!/usr/bin/env node
/**
 * One-time migration that makes the SOLD collection multi-source, so Booli sales
 * can land in it without duplicating Hemnet's. Two jobs, in this order:
 *
 *  1. FINGERPRINT BACKFILL (first, because it's the job that matters and it is
 *     always safe). api/sold-ingest.js finds duplicates by fetching a record's
 *     fingerprintKey bucket. Existing documents have no key, so WITHOUT this every
 *     Booli record would look new and insert a duplicate — double-weighting those
 *     sales in the kr/m² percentile the resale estimates rest on. Also seeds a
 *     "hemnet" sources[] entry on records that predate provenance.
 *  2. INDEXES. `hemnetId` must be SPARSE (a Booli-only sale has no Hemnet id, so
 *     under a plain unique index the second one collides on null). `booliId` must
 *     be a PARTIAL unique index, NOT sparse: a sparse index still indexes documents
 *     that store `booliId: null`, so building it over the existing Hemnet-only
 *     records fails with `E11000 dup key { booliId: null }` — exactly how the first
 *     production attempt failed. models/sold.model.js sets autoIndex:false so index
 *     changes happen here, deliberately, instead of being retried on every boot.
 *
 * The backfill runs FIRST on purpose: when indexes came first, an index error
 * aborted the whole script and left the backfill undone, so the run was a total
 * no-op and the ingest still refused to start.
 *
 * Idempotent and DRY-RUN BY DEFAULT (this collection feeds every resale estimate):
 *   node scripts/migrate-sold-sources.js            # report only
 *   node scripts/migrate-sold-sources.js --commit   # actually write
 *
 * Needs MONGO_URI (set on Render).
 */
const mongoose = require("mongoose");
const SoldListing = require("../models/sold.model");
const { blockingKey } = require("../api/listing-fingerprint");
const { soldSourceEntry } = require("../api/sold-ingest");

const COMMIT = process.argv.includes("--commit");

function describeIndex(idx) {
  return (
    `${idx.name}  keys=${JSON.stringify(idx.key)} unique=${!!idx.unique} sparse=${!!idx.sparse}` +
    `${idx.partialFilterExpression ? ` partial=${JSON.stringify(idx.partialFilterExpression)}` : ""}`
  );
}

// ── 1. fingerprintKey + hemnet provenance ────────────────────────────────────
async function backfill() {
  const cursor = SoldListing.find(
    {},
    {
      hemnetId: 1,
      link: 1,
      locationDescription: 1,
      area: 1,
      size: 1,
      sizeNum: 1,
      rooms: 1,
      streetAddress: 1,
      soldDate: 1,
      sources: 1,
      fingerprintKey: 1,
    }
  ).cursor();

  let scanned = 0;
  let keyed = 0;
  let unkeyable = 0;
  let sourced = 0;
  for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
    scanned += 1;
    const set = {};
    const nextKey = blockingKey(doc) || null;
    if (doc.fingerprintKey !== nextKey) {
      set.fingerprintKey = nextKey;
      if (nextKey) keyed += 1;
    }
    if (!nextKey) unkeyable += 1;
    if (!doc.sources || doc.sources.length === 0) {
      set.sources = [soldSourceEntry("hemnet", doc.hemnetId, doc.link, doc.soldDate || new Date())];
      sourced += 1;
    }
    if (Object.keys(set).length && COMMIT) {
      await SoldListing.updateOne({ _id: doc._id }, { $set: set });
    }
  }

  console.log(
    `\n${COMMIT ? "✅" : "📋"} Scanned ${scanned} sold records — fingerprintKey on ${keyed}, seeded hemnet source on ${sourced}.`
  );
  if (unkeyable) {
    // Unkeyable records can't be deduped against, so a Booli record for the same
    // sale would insert alongside them. Worth knowing the size of that blind spot.
    console.log(
      `⚠ ${unkeyable} record(s) could not be fingerprinted (missing area or size) — Booli dedup can't see those.`
    );
  }
  return { scanned, keyed, sourced, unkeyable };
}

// ── 2. indexes ───────────────────────────────────────────────────────────────
async function manageIndexes() {
  const collection = SoldListing.collection;
  const before = await collection.indexes();
  console.log("\nCurrent indexes:");
  for (const idx of before) console.log(`   ${describeIndex(idx)}`);

  // (a) hemnetId: unique-but-not-sparse cannot hold Booli-only sales.
  const hemnetIdx = before.find((i) => i.name === "hemnetId_1");
  if (hemnetIdx && hemnetIdx.unique && !hemnetIdx.sparse) {
    console.log("\n→ hemnetId_1 is unique but NOT sparse — Booli-only sales cannot be stored under it.");
    if (COMMIT) {
      await collection.dropIndex("hemnetId_1");
      console.log("   ✓ dropped hemnetId_1");
    } else {
      console.log("   (dry run) would drop hemnetId_1");
    }
  } else if (hemnetIdx) {
    console.log("\n→ hemnetId_1 already sparse/unique-safe — nothing to drop.");
  } else {
    console.log("\n→ no hemnetId_1 index present.");
  }

  // (b) booliId: must be PARTIAL, not sparse — sparse still indexes stored nulls,
  // so that variant can't be built over the existing Hemnet-only records.
  const booliIdx = before.find((i) => i.name === "booliId_1");
  if (booliIdx && !booliIdx.partialFilterExpression) {
    console.log("→ booliId_1 exists WITHOUT a partial filter — that variant collides on stored `booliId: null`.");
    if (COMMIT) {
      await collection.dropIndex("booliId_1");
      console.log("   ✓ dropped booliId_1 (rebuilt below as partial)");
    } else {
      console.log("   (dry run) would drop booliId_1 and rebuild it as partial");
    }
  }

  if (!COMMIT) {
    console.log(
      "   (dry run) would run syncIndexes() to build sparse hemnetId_1, PARTIAL booliId_1 and fingerprintKey_1"
    );
    return;
  }

  try {
    await SoldListing.syncIndexes();
    console.log("   ✓ syncIndexes done. Indexes now:");
    for (const idx of await collection.indexes()) console.log(`     ${describeIndex(idx)}`);
  } catch (err) {
    // Report loudly but keep the backfill's success visible — that ordering is what
    // made the first production attempt a total no-op.
    console.error(`   ✗ syncIndexes failed: ${err.message}`);
    console.error("     The fingerprint backfill above IS applied; only the indexes are incomplete.");
    throw err;
  }
}

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  console.log(COMMIT ? "MODE: --commit (writing)\n" : "MODE: dry run (no writes) — pass --commit to apply\n");

  await backfill();
  await manageIndexes();

  if (!COMMIT) console.log("\nNo changes written. Re-run with --commit to apply.");
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error("Migration failed:", err.message);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
