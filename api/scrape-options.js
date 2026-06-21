function shouldFetchActiveDetails(options = {}) {
  return options.includeDetails !== false && options.includeDetails !== "false";
}

function buildActiveScrapeOptions(query = {}) {
  return {
    includeDetails: shouldFetchActiveDetails(query),
  };
}

function isEnabled(value) {
  return value !== false && value !== "false";
}

function buildSoldScrapeOptions(query = {}) {
  return {
    area: query.area,
    detailLimit: query.detailLimit,
    includeDetails: isEnabled(query.includeDetails),
    includeAnalysis: isEnabled(query.includeAnalysis),
  };
}

function buildImageAnalysisOptions(query = {}) {
  const rawLimit = Number(query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 25) : 10;
  const dataset = ["active", "sold", "all"].includes(query.dataset) ? query.dataset : "all";

  // Optional single-listing target: re-analyse just this listing by Hemnet id or
  // URL slug (?listing=, ?id= or ?slug=), forcing a re-score even if it's already
  // analysed. Used to correct a specific listing without a full recency batch.
  const target = String(query.listing || query.id || query.slug || "").trim() || null;

  return {
    dataset,
    limit,
    onlyMissing: isEnabled(query.onlyMissing),
    target,
  };
}

// Image ownership: the analysis pipeline curates and persists a wet-rooms-first
// gallery (kitchen + bathroom). The scrape can only reliably offer the ~5
// search-card thumbnails — detail-page fetches (which carry the full gallery)
// fail intermittently behind Hemnet's bot protection and fall back to those
// thumbnails, which omit the bathroom. So the scrape must SEED images only on
// insert and never overwrite an existing curated gallery; otherwise every run
// resets curated photos back to thumbnails while kitchenPictured/bathroomPictured
// stay true, and self-heal never re-hydrates. The analyser re-fetches the full
// gallery from Hemnet itself, so it doesn't depend on the scrape refreshing them.
function buildListingUpsert(fields, images) {
  return { $set: fields, $setOnInsert: { images: images || [] } };
}

module.exports = {
  buildActiveScrapeOptions,
  buildImageAnalysisOptions,
  buildListingUpsert,
  buildSoldScrapeOptions,
  shouldFetchActiveDetails,
};
