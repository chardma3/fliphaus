#!/usr/bin/env node
/**
 * One-time migration that makes the SOLD collection multi-source, so Booli sales
 * can land in it without duplicating Hemnet's. Three jobs:
 *
 *  1. INDEX: production carries a non-sparse unique `hemnetId_1`. A Booli-only
 *     sale has no hemnetId, so under that index the FIRST one stores null and the
 *     SECOND one fails with a duplicate-key error. This drops it and rebuilds it
 *     sparse (models/sold.model.js sets autoIndex:false precisely so this happens
 *     here, deliberately, rather than being retried on every boot).
 *  2. FINGERPRINT BACKFILL: api/sold-ingest.js finds duplicates by fetching a
 *     record's fingerprintKey bucket. Existing documents have no key, so WITHOUT
 *     this backfill every Booli record would look new and insert a duplicate —
 *     double-weighting those sales in the kr/m² percentile the resale estimates
 *     rest on. This is the step that makes dedup actually work.
 *  3. PROVENANCE: seeds a "hemnet" sources[] entry on records that predate it.
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

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  console.log(COMMIT ? "MODE: --commit (writing)\n" : "MODE: dry run (no writes) — pass --commit to apply\n");

  // ── 1. index ───────────────────────────────────────────────────────────────
  const collection = SoldListing.collection;
  const before = await collection.indexes();
  console.log("Current indexes:");
  for (const idx of before) {
    console.log(`   ${idx.name}  keys=${JSON.stringify(idx.key)} unique=${!!idx.unique} sparse=${!!idx.sparse}`);
  }

  const hemnetIdx = before.find((i) => i.name === "hemnetId_1");
  const needsDrop = hemnetIdx && hemnetIdx.unique && !hemnetIdx.sparse;
  if (needsDrop) {
    console.log("\n→ hemnetId_1 is unique but NOT sparse — Booli-only sales cannot be stored under it.");
    if (COMMIT) {
      await collection.dropIndex("hemnetId_1");
      console.log("   ✓ dropped hemnetId_1");
    } else {
      console.log("   (dry run) would drop hemnetId_1");
    }
  } else if (hemnetIdx) {
    console.log("\n→ hemnetId_1 already sparse/non-unique — nothing to drop.");
  } else {
    console.log("\n→ no hemnetId_1 index present.");
  }

  if (COMMIT) {
    await SoldListing.syncIndexes();
    const after = await collection.indexes();
    console.log("   ✓ syncIndexes done. Indexes now:");
    for (const idx of after) {
      console.log(`     ${idx.name}  unique=${!!idx.unique} sparse=${!!idx.sparse}`);
    }
  } else {
    console.log("   (dry run) would run syncIndexes() to build sparse hemnetId_1, booliId_1 and fingerprintKey_1");
  }

  // ── 2 + 3. backfill ────────────────────────────────────────────────────────
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
