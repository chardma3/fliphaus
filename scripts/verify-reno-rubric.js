#!/usr/bin/env node
/**
 * Re-analyses a few already-scored active listings on the (new) renovation
 * rubric and prints old -> new score, WITHOUT writing to the DB. Picks the
 * current highest-scored listings — the ones most likely to move into 9-10 if
 * the anchored scale is working.
 *
 * Also prints kitchen/bathroom coverage and image count per listing, which
 * doubles as a diagnostic for the "are we even capturing kitchen/bathroom
 * photos?" question.
 *
 * Needs ANTHROPIC_API_KEY + MONGO_URI (both set on Render). Costs a handful of
 * Claude calls. No DB writes.
 *
 *   node scripts/verify-reno-rubric.js [count]   # default 5
 */
const mongoose = require("mongoose");
const Listing = require("../api/listing.model");
const { analyzeListingImages } = require("../api/analyze");
const { fetchGalleries } = require("../api/listing-gallery");

(async () => {
  const count = Number(process.argv[2]) || 5;
  if (!process.env.MONGO_URI) { console.error("MONGO_URI not set."); process.exit(1); }

  await mongoose.connect(process.env.MONGO_URI);
  const listings = await Listing.find({
    status: "active",
    renovationScore: { $ne: null },
    images: { $exists: true, $not: { $size: 0 } },
  })
    .sort({ renovationScore: -1 })
    .limit(count)
    .lean();

  console.log(`Re-analysing ${listings.length} listing(s) on the FULL detail gallery — NO DB writes.\n`);

  // Hydrate the full detail-page gallery (same path the analysis now uses), so
  // we see the score with real kitchen/bathroom coverage rather than the ~5
  // stored thumbnails.
  const galleries = await fetchGalleries(listings.map((l) => l.slug).filter(Boolean));

  for (const l of listings) {
    const before = l.renovationScore;
    const stored = (l.images || []).length;
    const gallery = galleries[l.slug] || [];
    const images = gallery.length > stored ? gallery : (l.images || []);
    try {
      const r = await analyzeListingImages(images, {
        size: l.size, rooms: l.rooms, askingPrice: l.askingPrice,
      });
      const after = r?.renovationScore ?? "(none)";
      const cov = r?.roomCoverage || {};
      console.log(
        `${(l.streetAddress || l.id).padEnd(28)} score ${before} -> ${after}  ` +
          `| stored=${stored} gallery=${gallery.length} kitchen=${cov.kitchenVisible ?? "?"} bathroom=${cov.bathroomVisible ?? "?"}`
      );
      if (r?.summary) console.log(`    ${r.summary}`);
    } catch (err) {
      console.log(`${(l.streetAddress || l.id).padEnd(28)} ERROR: ${err.message}`);
    }
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
