const { PROJECT_ADDRESS } = require("./project-listing");

// Self-heal bounds. A listing whose gallery hydration failed (so its photos are
// missing the kitchen/bathroom) is retried on later runs — but at most
// MAX_HYDRATION_ATTEMPTS times, and no more than once per HYDRATION_RETRY_COOLDOWN.
// The cooldown means a single drain loop still terminates (a just-attempted
// listing is excluded until the cooldown passes), while a flaky hydration heals
// on the next scheduled run and a genuinely un-hydratable / photo-poor listing
// eventually stops. Both env-overridable.
const MAX_HYDRATION_ATTEMPTS = Number(process.env.MAX_HYDRATION_ATTEMPTS) || 4;
const HYDRATION_RETRY_COOLDOWN_MS = Number(process.env.HYDRATION_RETRY_COOLDOWN_MS) || 6 * 60 * 60 * 1000;

function buildAnalysisQuery({ onlyMissing = true, status, requireAnalyzedAt = false, hydrationRetry = null } = {}) {
  // Never spend analysis on new-build/projekt listings — they're not flips and
  // their detail pages can't be hydrated anyway. They surface in the New builds
  // view as raw market data instead.
  const query = { "images.0": { $exists: true }, streetAddress: { $not: PROJECT_ADDRESS } };
  if (status) query.status = status;
  if (onlyMissing) {
    query.$or = [
      { renovationScore: null },
      { renovationScore: { $exists: false } },
    ];
    if (requireAnalyzedAt) {
      query.$or.push({ analyzedAt: null }, { analyzedAt: { $exists: false } });
    }
    if (hydrationRetry) {
      // Self-heal: re-pick already-scored listings whose photos are missing a
      // wet room (kitchen or bathroom) — i.e. hydration failed and they're stuck
      // on Hemnet's thumbnails, which omit the bathroom — so a later run
      // re-fetches the full gallery and re-analyses them. Bounded so it can't
      // loop: at most maxAttempts tries total, and not again until the cooldown
      // has passed (cutoff). Coverage (not image count) is the signal, because a
      // successfully-hydrated listing is deliberately stored as a small curated
      // set, so image count no longer indicates "needs hydration".
      query.$or.push({
        $and: [
          { $or: [{ kitchenPictured: false }, { bathroomPictured: false }] },
          { $or: [{ galleryHydrationAttempts: { $lt: hydrationRetry.maxAttempts } }, { galleryHydrationAttempts: { $exists: false } }] },
          { $or: [{ galleryHydrationAttemptedAt: null }, { galleryHydrationAttemptedAt: { $exists: false } }, { galleryHydrationAttemptedAt: { $lte: hydrationRetry.cutoff } }] },
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
    // Record whether this score came from the cheap triage gate rather than a
    // full analysis, so gated listings are filterable/auditable in the feed.
    triageGated: analysis.triageGated === true,
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
      if (hydrateGalleries) {
        // Persist only the curated set the analyser picked (wet-rooms-first,
        // capped at MAX_DISPLAY_IMAGES) rather than the full hydrated gallery,
        // so the feed shows a consistent ~6 relevant photos incl. kitchen +
        // bathroom instead of anywhere from 5 (thumbnail-only) to 50 (fully
        // hydrated) depending on pipeline luck. Fall back to the richer gallery
        // only if curation produced nothing.
        if (analysis.displayImages && analysis.displayImages.length) {
          update.images = analysis.displayImages;
        } else if (gallery && gallery.length > stored.length) {
          update.images = gallery;
        }
        // Record the attempt (success or failure) and bump the attempt count, so
        // the self-heal re-pick spaces out retries and eventually stops on an
        // un-hydratable listing. Coverage (kitchen/bathroom) — written by
        // buildUpdate above — is what tells a healed listing from a stuck one.
        update.galleryHydrationAttemptedAt = new Date();
        update.galleryHydrationAttempts = (listing.galleryHydrationAttempts || 0) + 1;
      }
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
  const hydrationRetry = {
    maxAttempts: MAX_HYDRATION_ATTEMPTS,
    cutoff: new Date(Date.now() - HYDRATION_RETRY_COOLDOWN_MS),
  };
  return analyzeBatch({
    Model: Listing,
    query: buildAnalysisQuery({ onlyMissing: options.onlyMissing, status: "active", requireAnalyzedAt: true, hydrationRetry }),
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
