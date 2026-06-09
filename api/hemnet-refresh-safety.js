const LOCATION_IDS = {
  Rissne: 473493,
  Farsta: 925962,
  // 8-area expansion (2026-06). Metro-connected, renovation-stock areas; dropped
  // Sollentuna (pendel-only) and Blackeberg/Hökarängen (already hot / covered by
  // Farsta's node). IDs resolved from hemnet.se location search.
  Kista: 925951,
  Bagarmossen: 473340,
  Skarpnäck: 941046,
  Johanneshov: 473376,
  Bromma: 898740,
  Enskede: 925961,
  Solna: 18028,
  Årsta: 473440,
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

// Decide whether it is safe to reconcile "disappeared" listings after an
// active scrape. Disappearance is inferred by absence — a listing in the DB
// that wasn't seen this run is assumed gone. That inference is only valid when
// the scrape was COMPLETE. If any area failed (e.g. a transient proxy timeout),
// the run never observed that area's listings, so marking them disappeared
// would be a false positive (the 51/101 + 50-disappeared incident). On a
// partial scrape we still upsert what we got, but skip disappearance
// reconciliation and defer it to the next complete run.
function planDisappearanceReconciliation({ scrapedAreas = [], failedAreas = [] } = {}) {
  const partial = failedAreas.length > 0;
  return {
    partial,
    reconcile: !partial,
    reason: partial
      ? `Partial scrape — areas failed: [${failedAreas.join(", ")}], succeeded: [${scrapedAreas.join(", ")}]. Skipping disappearance reconciliation to avoid falsely marking the missing areas' listings as gone.`
      : `Complete scrape — areas: [${scrapedAreas.join(", ")}]. Reconciling disappearances normally.`,
  };
}

// Safety net for the partial-scrape guard. Per-run reconciliation is skipped
// whenever any area fails (common with a flaky proxy), so a genuinely-removed
// listing can sit at status "active" indefinitely. This catches listings we
// haven't seen in a long time regardless of partial scrapes: active, not seen
// this run, and either long-unseen or never stamped. Self-correcting — a real
// listing in a temporarily-failing area is re-marked active by the next
// successful upsert.
function buildStaleListingQuery({ currentIds = [], cutoff } = {}) {
  return {
    status: "active",
    id: { $nin: currentIds },
    $or: [{ lastSeenAt: { $lt: cutoff } }, { lastSeenAt: null }],
  };
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
  planDisappearanceReconciliation,
  buildStaleListingQuery,
  resolveSoldScrapeTargets,
  isHemnetSafetyError,
};
