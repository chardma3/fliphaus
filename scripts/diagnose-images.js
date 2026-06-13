#!/usr/bin/env node
/**
 * Read-only diagnostic for the listing photo situation. Reports, for active
 * scored listings, how many photos each carries and whether the kitchen and
 * bathroom were actually pictured — so we can tell WHY some listings still show
 * a handful of photos with no wet rooms:
 *   - low image count + no wet rooms  => gallery hydration failed (thumbnail-only)
 *   - high image count + no wet rooms => room classification missed them (model)
 *
 * No model calls, no scraping, no writes. Safe to run anywhere with MONGO_URI.
 *
 *   node scripts/diagnose-images.js [limit]   # sample size for the detail list (default 25)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Listing = require("../api/listing.model");

(async () => {
  const limit = Number(process.argv[2]) || 25;
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const scored = await Listing.find(
    { status: "active", renovationScore: { $ne: null } },
    { id: 1, streetAddress: 1, renovationScore: 1, images: 1, kitchenPictured: 1, bathroomPictured: 1, galleryHydrationAttemptedAt: 1 }
  ).lean();

  const bucket = (n) => (n <= 1 ? "1" : n <= 5 ? "2-5" : n === 6 ? "6" : n <= 12 ? "7-12" : "13+");
  const counts = {};
  let missingWet = 0;
  let missingWetThumbnailOnly = 0;
  let missingWetHydrated = 0;

  for (const l of scored) {
    const n = (l.images || []).length;
    counts[bucket(n)] = (counts[bucket(n)] || 0) + 1;
    const noWet = l.kitchenPictured === false || l.bathroomPictured === false;
    if (noWet) {
      missingWet++;
      if (n <= 6) missingWetThumbnailOnly++;
      else missingWetHydrated++;
    }
  }

  console.log(`\n=== ${scored.length} active scored listings ===`);
  console.log("Photo-count distribution:", counts);
  console.log(`Missing kitchen and/or bathroom: ${missingWet}`);
  console.log(`  ...with <=6 photos (likely hydration failed / thumbnail-only): ${missingWetThumbnailOnly}`);
  console.log(`  ...with >6 photos (likely classification missed the room): ${missingWetHydrated}`);

  const sample = scored
    .filter((l) => l.kitchenPictured === false || l.bathroomPictured === false)
    .slice(0, limit);
  if (sample.length) {
    console.log(`\n--- sample of ${sample.length} listings missing a wet room ---`);
    for (const l of sample) {
      console.log(
        `  ${(l.streetAddress || l.id).padEnd(34)} score=${l.renovationScore} imgs=${(l.images || []).length} ` +
          `kitchen=${l.kitchenPictured} bathroom=${l.bathroomPictured} hydrated=${l.galleryHydrationAttemptedAt ? "yes" : "no"}`
      );
    }
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
