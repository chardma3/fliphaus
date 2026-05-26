function shouldFetchActiveDetails(options = {}) {
  return options.includeDetails !== false && options.includeDetails !== "false";
}

function buildActiveScrapeOptions(query = {}) {
  return {
    includeDetails: shouldFetchActiveDetails(query),
  };
}

module.exports = {
  buildActiveScrapeOptions,
  shouldFetchActiveDetails,
};
