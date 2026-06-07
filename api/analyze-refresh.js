// The active feed scrape stores only ~5 search-card thumbnails; a hydrated
// detail-page gallery is far larger (commonly 20-50 images). A stored count at
// or below this threshold means the listing is still thumbnail-only and hasn't
// had its full gallery hydrated + persisted yet.
const THUMBNAIL_GALLERY_MAX = 8;

function buildAnalysisQuery({ onlyMissing = true, status, requireAnalyzedAt = false, requireFullGallery = false } = {}) {
  const query = { "images.0": { $exists: true } };
  if (status) query.status = status;
  if (onlyMissing) {
    query.$or = [
      { renovationScore: null },
      { renovationScore: { $exists: false } },
    ];
    if (requireAnalyzedAt) {
      query.$or.push({ analyzedAt: null }, { analyzedAt: { $exists: false } });
    }
    if (requireFullGallery) {
      // Re-pick already-scored listings still on the thumbnail-only gallery, so
      // a later run hydrates + persists their full detail-page gallery — but
      // ONLY if we haven't already attempted hydration. Without the attempt
      // guard, a listing whose detail page can't be hydrated (delisted / no
      // __NEXT_DATA__) never grows past the threshold and is re-picked every
      // batch forever, so a drain loop never terminates. galleryHydrationAttemptedAt
      // is stamped on every attempt (success or failure), so each listing is
      // re-analysed at most once by this clause. Successful hydration also lifts
      // the image count past the threshold, dropping it out the other way.
      query.$or.push({
        $and: [
          { [`images.${THUMBNAIL_GALLERY_MAX}`]: { $exists: false } },
          { $or: [{ galleryHydrationAttemptedAt: null }, { galleryHydrationAttemptedAt: { $exists: false } }] },
        ],
      });
    }
  }
  return query;
}

function applyActiveAnalysisUpdate(analysis) {
  const coverage = analysis.roomCoverage || {};
  const kitchenPictured = coverage.kitchenVisible === true;
  const bathroomPictured = coverage.bathroomVisible === true;
  return {
    renovationScore: analysis.renovationScore,
    renovationConfidence: analysis.confidence,
    renovationSummary: analysis.summary,
    renovationRooms: analysis.rooms,
    totalEstimatedCostSEK: analysis.totalEstimatedCostSEK,
    investmentPotential: analysis.investmentPotential,
    kitchenPictured,
    bathroomPictured,
    imageCoverageComplete: kitchenPictured && bathroomPictured,
    analyzedAt: new Date(),
  };
}

function applySoldAnalysisUpdate(analysis) {
  return {
    renovationScore: analysis.renovationScore,
    renovationConfidence: analysis.confidence,
    renovationSummary: analysis.summary,
    renovationRooms: analysis.rooms,
    conditionLabel: conditionLabelFromScore(analysis.renovationScore),
  };
}

function conditionLabelFromScore(score) {
  if (score == null) return "unknown";
  if (score <= 3) return "renovated";
  if (score >= 7) return "unrenovated";
  return "partly_renovated";
}

async function analyzeBatch({ Model, query, limit, describeListing, buildUpdate, hydrateGalleries = false }) {
  const { analyzeListingImages } = require("./analyze");
  const listings = await Model.find(query).sort({ lastSeenAt: -1, scrapedAt: -1, updatedAt: -1 }).limit(limit);
  let analyzed = 0;
  let skipped = 0;
  let failed = 0;

  // The active feed scrape stores only ~5 search-card thumbnails, which often
  // omit the kitchen/bathroom and cap the renovation score. For the listings
  // we're about to analyse, fetch their full detail-page galleries first (one
  // browser for the whole batch) so the analyser can actually see those rooms.
  let galleries = {};
  if (hydrateGalleries) {
    const { fetchGalleries } = require("./listing-gallery");
    const slugs = listings.map((l) => l.slug).filter(Boolean);
    try {
      galleries = await fetchGalleries(slugs);
      const hit = Object.keys(galleries).length;
      console.log(`  🖼  Hydrated full galleries for ${hit}/${slugs.length} listing(s)`);
    } catch (err) {
      console.error(`  ✗ Gallery hydration failed (continuing with stored images): ${err.message}`);
    }
  }

  for (const listing of listings) {
    const gallery = galleries[listing.slug];
    const stored = listing.images || [];
    // Prefer the richer of {hydrated gallery, stored images}.
    const images = gallery && gallery.length > stored.length ? gallery : stored;
    if (!images.length) {
      skipped++;
      continue;
    }

    try {
      const analysis = await analyzeListingImages(images, describeListing(listing));
      if (!analysis) {
        skipped++;
        continue;
      }

      const update = buildUpdate(analysis);
      // Persist the fuller gallery so the feed and future runs benefit and we
      // don't re-fetch it next time.
      if (gallery && gallery.length > stored.length) update.images = gallery;
      // Record that hydration was attempted (success or failure) so the
      // thumbnail-only re-pick won't loop forever on an un-hydratable listing.
      if (hydrateGalleries) update.galleryHydrationAttemptedAt = new Date();
      await Model.findByIdAndUpdate(listing._id, update);
      analyzed++;
      console.log(`  ✓ Analysed ${listing.streetAddress || listing.hemnetId || listing.id} (${images.length} imgs)`);
    } catch (err) {
      failed++;
      console.error(`  ✗ Image analysis failed for ${listing.streetAddress || listing.hemnetId || listing.id}: ${err.message}`);
    }
  }

  return {
    candidates: listings.length,
    analyzed,
    skipped,
    failed,
  };
}

async function analyzeActiveListings(options = {}) {
  const Listing = require("./listing.model");
  return analyzeBatch({
    Model: Listing,
    query: buildAnalysisQuery({ onlyMissing: options.onlyMissing, status: "active", requireAnalyzedAt: true, requireFullGallery: true }),
    limit: options.limit,
    describeListing: (listing) => ({
      size: listing.size,
      rooms: listing.rooms,
      askingPrice: listing.askingPrice,
    }),
    buildUpdate: applyActiveAnalysisUpdate,
    hydrateGalleries: true,
  });
}

async function analyzeSoldListings(options = {}) {
  const SoldListing = require("../models/sold.model");
  return analyzeBatch({
    Model: SoldListing,
    query: buildAnalysisQuery({ onlyMissing: options.onlyMissing }),
    limit: options.limit,
    describeListing: (listing) => ({
      size: listing.size,
      rooms: listing.rooms,
      askingPrice: listing.askingPrice,
    }),
    buildUpdate: applySoldAnalysisUpdate,
  });
}

async function analyzeListingImagesRefresh(options = {}) {
  const dataset = options.dataset || "all";
  const limit = options.limit || 10;
  const result = { dataset, limit, active: null, sold: null };

  if (dataset === "active" || dataset === "all") {
    result.active = await analyzeActiveListings({ limit, onlyMissing: options.onlyMissing });
  }

  if (dataset === "sold" || dataset === "all") {
    result.sold = await analyzeSoldListings({ limit, onlyMissing: options.onlyMissing });
  }

  return result;
}

module.exports = {
  analyzeListingImagesRefresh,
  applyActiveAnalysisUpdate,
  applySoldAnalysisUpdate,
  buildAnalysisQuery,
  conditionLabelFromScore,
};
