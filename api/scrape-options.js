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

module.exports = {
  buildActiveScrapeOptions,
  buildSoldScrapeOptions,
  shouldFetchActiveDetails,
};
