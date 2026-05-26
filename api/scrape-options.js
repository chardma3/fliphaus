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

  return {
    dataset,
    limit,
    onlyMissing: isEnabled(query.onlyMissing),
  };
}

module.exports = {
  buildActiveScrapeOptions,
  buildImageAnalysisOptions,
  buildSoldScrapeOptions,
  shouldFetchActiveDetails,
};
