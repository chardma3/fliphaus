#!/usr/bin/env node
/**
 * One-time backfill of the multi-source canonical fields on existing listings so
 * they're ready for a second source (Booli) to merge into:
 *   - fingerprintKey: the api/listing-fingerprint.js blockingKey (also refreshed
 *     on every scrape, but this populates it immediately without waiting a day).
 *   - sources[]: seeds a "hemnet" provenance entry on listings that predate the
 *     sources[] field (new inserts already get it in api/scrape.js).
 *
 * Idempotent: only writes when a field is missing/stale, so it's safe to re-run.
 * No HTTP / no proxy — just a DB pass. Needs MONGO_URI (set on Render).
 *
 *   node scripts/backfill-canonical-sources.js
 */
const mongoose = require("mongoose");
const Listing = require("../api/listing.model");
const { blockingKey } = require("../api/listing-fingerprint");
const { sourceEntry } = require("../api/listing-ingest");

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const cursor = Listing.find({}, { id: 1, link: 1, locationDescription: 1, area: 1, size: 1, sizeNum: 1, rooms: 1, sources: 1, fingerprintKey: 1, firstSeenAt: 1 }).cursor();
  let scanned = 0;
  let keyed = 0;
  let sourced = 0;
  for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
    scanned += 1;
    const set = {};
    const nextKey = blockingKey(doc) || null;
    if (doc.fingerprintKey !== nextKey) { set.fingerprintKey = nextKey; keyed += 1; }
    if (!doc.sources || doc.sources.length === 0) {
      set.sources = [sourceEntry("hemnet", doc.id, doc.link, doc.firstSeenAt || new Date())];
      sourced += 1;
    }
    if (Object.keys(set).length) await Listing.updateOne({ _id: doc._id }, { $set: set });
  }

  console.log(`✅ Scanned ${scanned} listings — set fingerprintKey on ${keyed}, seeded hemnet source on ${sourced}.`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error("Backfill failed:", err.message);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
