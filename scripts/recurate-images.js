#!/usr/bin/env node
/**
 * Cheap photo re-curation — restores a wet-rooms-first gallery WITHOUT re-scoring.
 *
 * Background: the scrape used to overwrite each listing's curated gallery with
 * the ~5 search-card thumbnails (which omit the bathroom) on every run, while
 * leaving kitchenPictured/bathroomPictured true (fixed in the scrape upsert). To
 * repair the listings already clobbered, we only need to re-pick the photos — the
 * renovation SCORE is already on the doc and hasn't changed. So this skips the
 * expensive Sonnet scoring entirely: it re-hydrates the full gallery, runs the
 * cheap Haiku triage to classify rooms, re-curates the display set wet-rooms-first
 * and rewrites the coverage flags honestly (from the photos actually kept). A
 * listing left without a wet-room photo ends up flagged false, so the normal
 * self-heal re-hydrates it on a later analysis run.
 *
 * Targets only already-scored active listings whose stored set is still small
 * (<= 5 photos = thumbnail-clobbered), skipping new-build/projekt listings (their
 * detail pages can't be hydrated). Each processed listing gets a fresh
 * galleryHydrationAttemptedAt so it drops out of the query — the drain loop
 * terminates whether or not hydration succeeded.
 *
 * Cost: Haiku triage only (a small fraction of a full backfill); time is mostly
 * Puppeteer hydration. Needs MONGO_URI + ANTHROPIC_API_KEY + HEMNET_PROXY_*.
 *
 *   node scripts/recurate-images.js [maxImages] [batchLimit]
 *   # maxImages default 5 (only re-curate listings stuck at <= this many photos)
 *   # batchLimit default 25
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Listing = require("../api/listing.model");
const { PROJECT_ADDRESS } = require("../api/project-listing");
const { fetchGalleries } = require("../api/listing-gallery");
const { triageRooms, selectDisplayImages } = require("../api/analyze");
const { coverageFromDisplaySet } = require("../api/image-selection");

async function recurateBatch(maxImages, limit, runStart) {
  const query = {
    status: "active",
    renovationScore: { $ne: null },
    streetAddress: { $not: PROJECT_ADDRESS },
    $expr: { $lte: [{ $size: { $ifNull: ["$images", []] } }, maxImages] },
    $or: [
      { galleryHydrationAttemptedAt: null },
      { galleryHydrationAttemptedAt: { $exists: false } },
      { galleryHydrationAttemptedAt: { $lt: runStart } },
    ],
  };

  const listings = await Listing.find(query).sort({ lastSeenAt: -1 }).limit(limit);
  if (!listings.length) return { candidates: 0, recurated: 0, noGallery: 0, triageFailed: 0 };

  // One browser for the whole batch (the slow part), like the analyser does.
  const galleries = await fetchGalleries(listings.map((l) => l.slug).filter(Boolean));

  let recurated = 0;
  let noGallery = 0;
  let triageFailed = 0;

  for (const listing of listings) {
    const stored = listing.images || [];
    const gallery = galleries[listing.slug] || [];
    // Prefer the richer of {hydrated gallery, stored} — same rule the analyser uses.
    const images = gallery.length > stored.length ? gallery : stored;

    // Always record the attempt so the listing drops out of the query and the
    // drain loop terminates, even when hydration or triage fails this run.
    const update = {
      galleryHydrationAttemptedAt: new Date(),
      galleryHydrationAttempts: (listing.galleryHydrationAttempts || 0) + 1,
    };

    if (!images.length) {
      noGallery++;
    } else {
      let classified = null;
      try {
        classified = await triageRooms(images);
      } catch (err) {
        console.error(`  ✗ Triage failed for ${listing.streetAddress}: ${err.message}`);
      }

      // Only rewrite photos/flags when triage gave us room info — otherwise we'd
      // risk an arbitrary spread and can't honestly set coverage, so leave the
      // listing as-is to be retried (it stays small -> eligible next run).
      if (classified && classified.length) {
        const displayImages = selectDisplayImages(images, classified);
        const coverage = coverageFromDisplaySet(images, displayImages, classified);
        if (displayImages.length) update.images = displayImages;
        if (coverage) {
          update.kitchenPictured = coverage.kitchenPictured;
          update.bathroomPictured = coverage.bathroomPictured;
          update.imageCoverageComplete = coverage.kitchenPictured && coverage.bathroomPictured;
        }
        recurated++;
        console.log(
          `  ✓ ${listing.streetAddress} (${images.length} imgs -> ${(update.images || stored).length} kept` +
            `, k:${update.kitchenPictured} b:${update.bathroomPictured})`
        );
      } else {
        triageFailed++;
      }
    }

    await Listing.findByIdAndUpdate(listing._id, update);
  }

  return { candidates: listings.length, recurated, noGallery, triageFailed };
}

(async () => {
  const maxImages = Number(process.argv[2]) || 5;
  const limit = Number(process.argv[3]) || 25;
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  // Stamp the run start once; processed listings get a later
  // galleryHydrationAttemptedAt and so drop out of subsequent batches.
  const runStart = new Date();
  console.log(`Re-curating scored active listings with <= ${maxImages} photos (batch ${limit}, no re-scoring)`);

  let totals = { recurated: 0, noGallery: 0, triageFailed: 0 };
  let batch = 0;
  let r;
  do {
    r = await recurateBatch(maxImages, limit, runStart);
    totals.recurated += r.recurated;
    totals.noGallery += r.noGallery;
    totals.triageFailed += r.triageFailed;
    batch += 1;
    console.log(`batch ${batch}: ${JSON.stringify(r)}  (cumulative re-curated ${totals.recurated})`);
  } while (r.candidates > 0);

  console.log(
    `DONE — ${totals.recurated} re-curated, ${totals.noGallery} had no hydratable gallery, ` +
      `${totals.triageFailed} triage-failed, across ${batch} batch(es).`
  );
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
