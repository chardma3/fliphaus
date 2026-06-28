// Scoring models a caller may force per request via ?analysisModel=. Allowlisted
// so a query param can never inject an arbitrary model string.
const ALLOWED_ANALYSIS_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

function shouldFetchActiveDetails(options = {}) {
  return options.includeDetails !== false && options.includeDetails !== "false";
}

function buildActiveScrapeOptions(query = {}) {
  return {
    includeDetails: shouldFetchActiveDetails(query),
    // Optional area scoping for staggered scheduled scrapes: ?batch=N scrapes the
    // Nth batch of LOCATION_IDS, ?areas=A,B,C scrapes a named subset. Both null =
    // scrape every area (the manual / backward-compatible default).
    batch: query.batch != null && query.batch !== "" ? query.batch : null,
    areas: query.areas != null && query.areas !== "" ? query.areas : null,
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

  // Optional one-shot re-analysis of already-scored listings analysed before a
  // cutoff (?reanalyzeBefore=<ISO date>), e.g. to roll out a prompt change.
  // ?reanalyzeMinScore=7 scopes it to deals.
  const reanalyzeDate = query.reanalyzeBefore ? new Date(query.reanalyzeBefore) : null;
  const reanalyzeBefore = reanalyzeDate && !Number.isNaN(reanalyzeDate.getTime()) ? reanalyzeDate : null;
  const rawMinScore = Number(query.reanalyzeMinScore);
  const reanalyzeMinScore = Number.isFinite(rawMinScore) ? rawMinScore : null;

  // Optional per-call scoring-model override (?analysisModel=). Null = use the
  // env/default (ANALYSIS_MODEL). The manual "reanalyze" button passes Opus.
  const analysisModel = ALLOWED_ANALYSIS_MODELS.includes(query.analysisModel) ? query.analysisModel : null;

  return {
    dataset,
    limit,
    onlyMissing: isEnabled(query.onlyMissing),
    target,
    reanalyzeBefore,
    reanalyzeMinScore,
    analysisModel,
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
  ALLOWED_ANALYSIS_MODELS,
};
