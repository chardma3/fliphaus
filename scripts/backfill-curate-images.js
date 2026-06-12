#!/usr/bin/env node
/**
 * One-off backfill: trim already-analysed active listings down to the curated
 * display set (kitchen + bathroom first, then an even spread, capped at
 * MAX_DISPLAY_IMAGES).
 *
 * Why: before the curated-images change, the analyser persisted the FULL
 * hydrated Hemnet gallery (20-50 photos), so existing listings show anywhere
 * from 5 to 50 images in the feed. Going forward the pipeline persists only the
 * curated set, but already-scored listings won't be re-picked (their
 * galleryHydrationAttemptedAt is stamped), so this script fixes them in place.
 *
 * Cheap: runs only the Haiku triage pass on each listing's STORED gallery to
 * locate the kitchen/bathroom — no detail-page hydration, no Sonnet scoring.
 * Idempotent and resumable: only targets listings with more than
 * MAX_DISPLAY_IMAGES stored, so each drops out once trimmed.
 *
 * Needs MONGO_URI + ANTHROPIC_API_KEY (set on Render).
 *
 *   node scripts/backfill-curate-images.js [batchLimit] [--dry]
 *     batchLimit  listings per batch (default 25)
 *     --dry       classify + report the new counts but don't write
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Listing = require("../api/listing.model");
const { triageRooms } = require("../api/analyze");
const { selectDisplayImages, MAX_DISPLAY_IMAGES } = require("../api/image-selection");

(async () => {
  const limit = Number(process.argv[2]) || 25;
  const dry = process.argv.includes("--dry");
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  // Listings that still carry more than the curated cap of photos.
  const query = { status: "active", [`images.${MAX_DISPLAY_IMAGES}`]: { $exists: true } };
  const remaining = await mongoose.connection
    .collection("listings")
    .countDocuments(query);
  console.log(`${remaining} active listing(s) carry more than ${MAX_DISPLAY_IMAGES} photos${dry ? " (dry run)" : ""}.`);

  let trimmed = 0;
  let failed = 0;
  let batch = 0;

  while (true) {
    const listings = await Listing.find(query).limit(limit);
    if (!listings.length) break;
    batch += 1;
    let batchWrites = 0;

    for (const listing of listings) {
      const images = listing.images || [];
      const label = listing.streetAddress || listing.id || listing._id;
      try {
        const classified = await triageRooms(images);
        const curated = selectDisplayImages(images, classified);
        if (!curated.length || curated.length >= images.length) {
          // Nothing to gain (classifier empty or no reduction) — skip so the
          // query doesn't loop on it forever.
          console.log(`  · Skipped ${label} (${images.length} imgs, no reduction)`);
          continue;
        }
        if (dry) {
          console.log(`  ~ ${label}: ${images.length} -> ${curated.length} imgs (dry)`);
          continue;
        }
        await Listing.findByIdAndUpdate(listing._id, { images: curated });
        trimmed += 1;
        batchWrites += 1;
        console.log(`  ✓ ${label}: ${images.length} -> ${curated.length} imgs`);
      } catch (err) {
        failed += 1;
        console.error(`  ✗ ${label}: ${err.message}`);
      }
    }

    // In a dry run nothing is written, so the query never shrinks — stop after
    // one pass. Likewise, if a real batch wrote nothing (every listing skipped
    // or errored), the query won't shrink either, so stop to avoid looping on
    // the same un-trimmable listings forever.
    if (dry || batchWrites === 0) break;
  }

  console.log(`DONE — ${trimmed} trimmed, ${failed} failed across ${batch} batch(es).`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
