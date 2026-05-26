function buildAnalysisQuery({ onlyMissing = true, status, requireAnalyzedAt = false } = {}) {
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
  }
  return query;
}

function applyActiveAnalysisUpdate(analysis) {
  return {
    renovationScore: analysis.renovationScore,
    renovationConfidence: analysis.confidence,
    renovationSummary: analysis.summary,
    renovationRooms: analysis.rooms,
    totalEstimatedCostSEK: analysis.totalEstimatedCostSEK,
    investmentPotential: analysis.investmentPotential,
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

async function analyzeBatch({ Model, query, limit, describeListing, buildUpdate }) {
  const { analyzeListingImages } = require("./analyze");
  const listings = await Model.find(query).sort({ lastSeenAt: -1, scrapedAt: -1, updatedAt: -1 }).limit(limit);
  let analyzed = 0;
  let skipped = 0;
  let failed = 0;

  for (const listing of listings) {
    const images = listing.images || [];
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

      await Model.findByIdAndUpdate(listing._id, buildUpdate(analysis));
      analyzed++;
      console.log(`  ✓ Analysed ${listing.streetAddress || listing.hemnetId || listing.id}`);
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
    query: buildAnalysisQuery({ onlyMissing: options.onlyMissing, status: "active", requireAnalyzedAt: true }),
    limit: options.limit,
    describeListing: (listing) => ({
      size: listing.size,
      rooms: listing.rooms,
      askingPrice: listing.askingPrice,
    }),
    buildUpdate: applyActiveAnalysisUpdate,
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
