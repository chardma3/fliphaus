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

function buildAnalysisQuery({ onlyMissing = true, status, requireAnalyzedAt = false, hydrationRetry = null, reanalyzeBefore = null, reanalyzeMinScore = null, target = null, coverageOnly = false } = {}) {
  // Never spend analysis on new-build/projekt listings — they're not flips and
  // their detail pages can't be hydrated anyway. They surface in the New builds
  // view as raw market data instead.
  const query = { "images.0": { $exists: true }, streetAddress: { $not: PROJECT_ADDRESS } };
  if (status) query.status = status;
  if (target) {
    // Targeted re-analysis of a single listing by Hemnet id or URL slug. Force a
    // re-score regardless of onlyMissing/self-heal/coverage state, so a listing
    // that's already scored (e.g. a top deal we want corrected) gets re-run.
    query.$or = [{ id: target }, { slug: target }];
    return query;
  }
  if (coverageOnly) {
    // Fast coverage self-heal: ONLY already-scored listings whose persisted photos
    // miss a wet room (kitchen or bathroom). Bypasses the unscored-listing clauses
    // so the 5-minute sweep re-hydrates exactly these and nothing else. Same
    // attempt + cooldown bounds as nightly self-heal (the sweep just passes a much
    // shorter cooldown so a still-blocked listing is eligible again ~5 min later,
    // not 6 h). A successfully-hydrated listing flips its flag and drops out; a
    // genuinely photo-poor one exhausts MAX_HYDRATION_ATTEMPTS and stops; a bot-
    // blocked one resets to 0 attempts and keeps retrying — exactly the intent.
    if (!hydrationRetry) throw new Error("coverageOnly requires hydrationRetry bounds");
    query.$and = [
      { $or: [{ kitchenPictured: false }, { bathroomPictured: false }] },
      { $or: [{ galleryHydrationAttempts: { $lt: hydrationRetry.maxAttempts } }, { galleryHydrationAttempts: { $exists: false } }] },
      { $or: [{ galleryHydrationAttemptedAt: null }, { galleryHydrationAttemptedAt: { $exists: false } }, { galleryHydrationAttemptedAt: { $lte: hydrationRetry.cutoff } }] },
    ];
    return query;
  }
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
    if (reanalyzeBefore) {
      // One-shot backfill: re-pick already-scored listings analysed before a
      // cutoff (e.g. before the display-set coverage fix shipped), regardless of
      // their kitchenPictured/bathroomPictured flags — those flags were written
      // by the old pipeline against the transient full gallery, so they can
      // wrongly read "covered" while the stored photos lack a wet room, which
      // means self-heal never re-picks them. Re-analysing stamps a fresh
      // analyzedAt so each listing drops out and the drain loop terminates.
      // reanalyzeMinScore scopes it to e.g. deals (renovationScore >= 7) so a
      // prompt change can be rolled out to the listings that matter most without
      // re-spending on the whole dataset.
      const stale = { analyzedAt: { $lt: reanalyzeBefore } };
      query.$or.push(
        reanalyzeMinScore != null
          ? { $and: [stale, { renovationScore: { $gte: reanalyzeMinScore } }] }
          : stale
      );
    }
  }
  return query;
}

// How the gallery-hydration attempt counter moves after one analysis pass. A
// successful fetch counts toward the give-up cap; a bot-blocked fetch (no
// gallery) is transient, so reset to 0 and keep retrying on later runs. Resetting
// (rather than just holding) also self-clears the budget that one-off backfill/
// recurate runs spent on now-blocked listings.
function nextHydrationAttempts(previous, fetchedGallery) {
  return fetchedGallery ? (previous || 0) + 1 : 0;
}

function applyActiveAnalysisUpdate(analysis) {
  // Coverage from the photos we actually persist (displayCoverage) is the source
  // of truth — it's what the feed shows. Fall back to the model's roomCoverage
  // (what it saw across the wider analysis gallery) only when triage produced no
  // classification to measure the display set against. This keeps the flags from
  // claiming a wet room the curated set dropped, so self-heal can re-hydrate it.
  const coverage = analysis.roomCoverage || {};
  const display = analysis.displayCoverage;
  // The cheap triage pass that builds displayCoverage can miss a wet room the
  // stronger scoring model clearly saw (e.g. a bathroom thumbnail tagged "other").
  // When the model analysed the WHOLE gallery (analysedImageCount >= totalImageCount),
  // its roomCoverage is honest against the displayed photos too — so let a confident
  // model "visible" rescue a triage false-negative. Larger galleries (only a subset
  // analysed) still defer to displayCoverage so we never claim a dropped room.
  const fullyAnalysed =
    coverage.totalImageCount != null && coverage.analysedImageCount >= coverage.totalImageCount;
  const rescue = (displayFlag, modelVisible) =>
    display ? displayFlag || (fullyAnalysed && modelVisible === true) : modelVisible === true;
  const kitchenPictured = rescue(display?.kitchenPictured, coverage.kitchenVisible);
  const bathroomPictured = rescue(display?.bathroomPictured, coverage.bathroomVisible);
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
        // Stamp the attempt time (spaces out retries via the cooldown). But only
        // a fetch that actually reached the gallery counts toward the give-up cap:
        // a bot-blocked fetch is transient, so reset the counter and keep retrying
        // on later runs until Hemnet lets the gallery through. The cap then only
        // fires on listings whose gallery genuinely lacks a wet room (it loads,
        // every time, and still has no bathroom). Previously every attempt counted,
        // so a persistently blocked listing exhausted its tries on failures — and
        // one-off backfill/recurate runs spent the budget too — and self-heal gave
        // up. Coverage (kitchen/bathroom), written by buildUpdate, tells a healed
        // listing from a stuck one.
        const fetchedGallery = Array.isArray(gallery) && gallery.length > 0;
        update.galleryHydrationAttemptedAt = new Date();
        update.galleryHydrationAttempts = nextHydrationAttempts(listing.galleryHydrationAttempts, fetchedGallery);
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
  // The fast coverage sweep re-picks still-incomplete listings every few minutes,
  // so it uses a short cooldown (default 4 min, < the 5-min sweep interval) instead
  // of the 6 h nightly cooldown — otherwise a just-attempted listing would be
  // locked out until long after the next sweep.
  const cooldownMs = options.coverageOnly
    ? Number(process.env.COVERAGE_SWEEP_COOLDOWN_MS) || 4 * 60 * 1000
    : HYDRATION_RETRY_COOLDOWN_MS;
  const hydrationRetry = {
    maxAttempts: MAX_HYDRATION_ATTEMPTS,
    cutoff: new Date(Date.now() - cooldownMs),
  };
  return analyzeBatch({
    Model: Listing,
    query: buildAnalysisQuery({ onlyMissing: options.onlyMissing, status: "active", requireAnalyzedAt: true, hydrationRetry, reanalyzeBefore: options.reanalyzeBefore, reanalyzeMinScore: options.reanalyzeMinScore, target: options.target, coverageOnly: options.coverageOnly }),
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
    query: buildAnalysisQuery({ onlyMissing: options.onlyMissing, target: options.target }),
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
  const target = options.target || null;
  // A targeted re-analysis only ever matches the one listing, so cap the batch
  // at 1 regardless of the requested limit.
  const limit = target ? 1 : options.limit || 10;
  const result = { dataset, limit, target, active: null, sold: null };

  if (dataset === "active" || dataset === "all") {
    result.active = await analyzeActiveListings({ limit, onlyMissing: options.onlyMissing, reanalyzeBefore: options.reanalyzeBefore, reanalyzeMinScore: options.reanalyzeMinScore, target, coverageOnly: options.coverageOnly });
  }

  if (dataset === "sold" || dataset === "all") {
    result.sold = await analyzeSoldListings({ limit, onlyMissing: options.onlyMissing, target });
  }

  return result;
}

module.exports = {
  analyzeListingImagesRefresh,
  applyActiveAnalysisUpdate,
  applySoldAnalysisUpdate,
  buildAnalysisQuery,
  conditionLabelFromScore,
  nextHydrationAttempts,
};
