#!/usr/bin/env node
/**
 * Re-hydrate active listings that are missing a kitchen and/or bathroom photo.
 *
 * Diagnosis (scripts/diagnose-images.js): the affected listings are all stuck
 * on their ~5 search-card thumbnails — gallery hydration was attempted once,
 * failed (flaky proxy), got stamped, and the thumbnail re-pick never retried
 * them. The thumbnails usually omit the bathroom, so coverage stays incomplete.
 *
 * This re-fetches each listing's full detail-page gallery and, if it's richer
 * than what's stored, re-runs the analysis on it — which re-scores (with the
 * current kitchen prompt), refreshes the kitchen/bathroom coverage flags, and
 * persists the curated wet-rooms-first photo set. Listings whose gallery still
 * can't be fetched (delisted, or genuinely only 5 photos on Hemnet) are stamped
 * and reported, not retried forever.
 *
 * Needs Puppeteer + HEMNET_PROXY_* (the scraping env) AND ANTHROPIC_API_KEY +
 * MONGO_URI — i.e. run it the same place as scripts/backfill-active.js.
 *
 *   node scripts/rehydrate-missing-wetrooms.js [batchLimit]   # default 8
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Listing = require("../api/listing.model");
const { fetchGalleries } = require("../api/listing-gallery");
const { analyzeListingImages } = require("../api/analyze");
const { applyActiveAnalysisUpdate } = require("../api/analyze-refresh");

(async () => {
  const limit = Number(process.argv[2]) || 8;
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const baseQuery = { status: "active", $or: [{ kitchenPictured: false }, { bathroomPictured: false }] };
  const total = await Listing.countDocuments(baseQuery);
  console.log(`${total} active listing(s) missing a kitchen and/or bathroom photo.`);

  // Exclude listings already processed this run so unfetchable ones don't get
  // re-pulled every batch (the query matches on coverage flags, which a failed
  // re-hydration doesn't change).
  const processed = [];
  let fixed = 0;
  let unfetchable = 0;
  let batch = 0;

  while (true) {
    const query = processed.length ? { ...baseQuery, _id: { $nin: processed } } : baseQuery;
    const listings = await Listing.find(query).limit(limit);
    if (!listings.length) break;
    batch += 1;

    const slugs = listings.map((l) => l.slug).filter(Boolean);
    let galleries = {};
    try {
      galleries = await fetchGalleries(slugs);
      console.log(`batch ${batch}: hydrated ${Object.keys(galleries).length}/${slugs.length} galler(ies)`);
    } catch (err) {
      console.error(`batch ${batch}: gallery hydration failed: ${err.message}`);
    }

    for (const listing of listings) {
      processed.push(listing._id);
      const label = listing.streetAddress || listing.id || listing._id;
      const gallery = galleries[listing.slug] || [];
      const stored = listing.images || [];

      if (gallery.length <= stored.length) {
        // No richer gallery available — stamp the attempt and move on.
        await Listing.findByIdAndUpdate(listing._id, { galleryHydrationAttemptedAt: new Date() });
        unfetchable += 1;
        console.log(`  · ${label}: no richer gallery (${gallery.length} vs ${stored.length} stored) — left as is`);
        continue;
      }

      try {
        const analysis = await analyzeListingImages(gallery, {
          size: listing.size,
          rooms: listing.rooms,
          askingPrice: listing.askingPrice,
        });
        if (!analysis) {
          await Listing.findByIdAndUpdate(listing._id, { galleryHydrationAttemptedAt: new Date() });
          unfetchable += 1;
          console.log(`  · ${label}: analysis returned nothing`);
          continue;
        }
        const update = applyActiveAnalysisUpdate(analysis);
        if (analysis.displayImages && analysis.displayImages.length) update.images = analysis.displayImages;
        update.galleryHydrationAttemptedAt = new Date();
        await Listing.findByIdAndUpdate(listing._id, update);
        fixed += 1;
        console.log(
          `  ✓ ${label}: ${stored.length} -> ${(update.images || []).length} imgs, ` +
            `score=${update.renovationScore} kitchen=${update.kitchenPictured} bathroom=${update.bathroomPictured}`
        );
      } catch (err) {
        await Listing.findByIdAndUpdate(listing._id, { galleryHydrationAttemptedAt: new Date() });
        unfetchable += 1;
        console.error(`  ✗ ${label}: ${err.message}`);
      }
    }
  }

  console.log(`\nDONE — ${fixed} re-hydrated & re-analysed, ${unfetchable} left as is (no richer gallery) across ${batch} batch(es).`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
