const LOCATION_IDS = {
  Rissne: 473493,
  Farsta: 925962,
};

function includesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function assertHemnetPageUsable({ html = "", hasNextData = false, url = "", areaName = "unknown area", dataset = "Hemnet data" } = {}) {
  const body = String(html || "").toLowerCase();
  const botProtectionPatterns = [
    /security verification/i,
    /just a moment/i,
    /checking your browser/i,
    /verify you are human/i,
    /cloudflare/i,
    /cf-browser-verification/i,
    /cf-challenge/i,
  ];

  if (includesAny(body, botProtectionPatterns)) {
    throw new Error(`Hemnet bot protection detected for ${areaName} ${dataset}; refusing to treat this as an empty scrape (${url})`);
  }

  if (!hasNextData) {
    throw new Error(`Hemnet page missing __NEXT_DATA__ for ${areaName} ${dataset}; scraper cannot safely parse (${url})`);
  }
}

function assertNonEmptyRefreshResult({ total, dataset = "active listings" } = {}) {
  if (dataset === "active listings" && Number(total) === 0) {
    throw new Error("Refusing to persist zero active listings because that would mark existing listings as disappeared after a blocked or broken Hemnet scrape");
  }
}

function resolveSoldScrapeTargets({ area } = {}) {
  if (!area) {
    return Object.entries(LOCATION_IDS).map(([areaName, locationId]) => ({ area: areaName, locationId }));
  }

  const normalized = String(area).trim().toLowerCase();
  const match = Object.entries(LOCATION_IDS).find(([areaName]) => areaName.toLowerCase() === normalized);
  if (!match) {
    throw new Error(`Unknown sold scrape area "${area}". Expected one of: ${Object.keys(LOCATION_IDS).join(", ")}`);
  }
  return [{ area: match[0], locationId: match[1] }];
}

function isHemnetSafetyError(error) {
  return /Hemnet bot protection|missing __NEXT_DATA__|Refusing to persist zero active listings/.test(error?.message || "");
}

module.exports = {
  LOCATION_IDS,
  assertHemnetPageUsable,
  assertNonEmptyRefreshResult,
  resolveSoldScrapeTargets,
  isHemnetSafetyError,
};
