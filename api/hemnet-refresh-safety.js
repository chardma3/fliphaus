// This is the ACTIVATION POINT — the areas we actually scrape. The tiered
// expansion backlog (candidates, filters, rollout phases) lives in
// api/area-priority.js; an area moves here once its Hemnet locationId is resolved.
const LOCATION_IDS = {
  // Rissne (473493, northern Sundbyberg: Rissne + Hallonbergen + Ör) removed
  // 2026-06-19 — rental-heavy 1970s miljonprogram with a thin owner-occupier
  // resale pool, so flips can't reliably exit. See fliphaus-hallonbergen memo.
  Farsta: 925962,
  // 8-area expansion (2026-06). Metro-connected, renovation-stock areas; dropped
  // Sollentuna (pendel-only) and Blackeberg/Hökarängen (already hot / covered by
  // Farsta's node). IDs resolved from hemnet.se location search.
  Kista: 925951,
  Bagarmossen: 473340,
  Skarpnäck: 941046,
  Johanneshov: 473376,
  Bromma: 898740,
  // Inner Bromma green-line stations added 2026-06-19. Pricier/closer-in than
  // outer Bromma so flip margins are tighter, but strong, liquid demand.
  Alvik: 473337,
  "Stora Mossen": 473423,
  Enskede: 925961,
  Solna: 18028,
  Årsta: 473440,
  // Red-line southwest (broad Hägersten district) added 2026-06-19 — one ID that
  // also pulls Hägerstensåsen, Telefonplan, Midsommarkransen, Aspudden, Örnsberg
  // and Västertorp. Gentrifying 1940s-50s folkhem stock with strong demand.
  Hägersten: 925964,
  // Green-line-south expansion (2026-06). All three are renovation-age stock
  // with gentrification momentum and clean reputations (none on the Dec 2025
  // police utsatt-område list). Hökarängen overlaps Farsta's broader node — kept
  // separate for full coverage; overlap is harmless (dedup by Hemnet id).
  // Högdalen has ~1,200 new homes planned (best policy-driven upside of the set).
  // IDs read off public hemnet.se /salda location URLs.
  Hökarängen: 473375,
  Kärrtorp: 473382,
  Högdalen: 473374,
  // Inner-city reno-arbitrage core added 2026-06-22 (Tier A in api/area-priority.js).
  // Gärdet (1930s–40s funkis, deep liquid resale) sits inside the Östermalm node
  // but is added as its own narrow ID. Lilla + Stora Essingen are the two
  // Essingeöarna islands (40s–60s folkhem, Kungsholmen-adjacent) — Hemnet IDs them
  // separately, so both are listed. IDs read off public hemnet.se /bostader URLs.
  "Gärdet": 925958,
  "Lilla Essingen": 473386,
  "Stora Essingen": 473422,
};

// The active areas, as plain names. Single source of truth for the user/feed
// default area selection so it can't drift away from what we actually scrape.
const AREA_NAMES = Object.keys(LOCATION_IDS);

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

// How many staggered batches the active scrape is split into. Each scheduled run
// scrapes one batch (a subset of LOCATION_IDS) so a single /api/scrape request
// stays well under Hemnet's ~100s Cloudflare edge timeout even as areas grow.
const ACTIVE_SCRAPE_BATCHES = 3;

// The area names in batch N (1-based). Contiguous chunks of the LOCATION_IDS
// order, so "batch 1" is a stable, predictable set.
function getAreaBatch(batchNum, count = ACTIVE_SCRAPE_BATCHES) {
  const names = Object.keys(LOCATION_IDS);
  const size = Math.ceil(names.length / count);
  const start = (Number(batchNum) - 1) * size;
  if (!Number.isInteger(Number(batchNum)) || start < 0 || start >= names.length) {
    throw new Error(`Invalid scrape batch "${batchNum}" (expected 1..${count})`);
  }
  return names.slice(start, start + size);
}

// Resolve which areas an active scrape should cover: an explicit ?batch=N, an
// explicit ?areas=A,B,C list, or (default) every area. Returns [{area, locationId}].
function resolveActiveScrapeTargets({ areas, batch } = {}) {
  let names;
  if (batch != null && batch !== "") {
    names = getAreaBatch(batch);
  } else if (areas != null && areas !== "") {
    names = (Array.isArray(areas) ? areas : String(areas).split(","))
      .map((a) => String(a).trim())
      .filter(Boolean);
  } else {
    names = Object.keys(LOCATION_IDS);
  }
  const lookup = new Map(Object.keys(LOCATION_IDS).map((n) => [n.toLowerCase(), n]));
  return names.map((name) => {
    const canonical = lookup.get(String(name).trim().toLowerCase());
    if (!canonical) {
      throw new Error(`Unknown scrape area "${name}". Expected one of: ${Object.keys(LOCATION_IDS).join(", ")}`);
    }
    return { area: canonical, locationId: LOCATION_IDS[canonical] };
  });
}

// Disappearance query scoped to the areas that scraped OK this run. A listing in
// one of those areas that we haven't seen within the grace window is treated as
// gone (withdrawn or sold). Scoping by area means a blocked area never suppresses
// reconciliation for the others — the key fix for daily withdrawal detection when
// scrapes are split into staggered batches. The grace window (default ~20h) spans
// a day's batches, so a listing seen by ANY batch today is safe; only one genuinely
// unseen for a full day is marked disappeared. No false positives from area-overlap
// or batch ordering, and no waiting on the 14-day staleness net.
function buildAreaDisappearanceQuery({ scrapedAreas = [], currentIds = [], cutoff } = {}) {
  return {
    status: "active",
    area: { $in: scrapedAreas },
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
  AREA_NAMES,
  ACTIVE_SCRAPE_BATCHES,
  getAreaBatch,
  resolveActiveScrapeTargets,
  assertHemnetPageUsable,
  assertNonEmptyRefreshResult,
  planDisappearanceReconciliation,
  buildStaleListingQuery,
  buildAreaDisappearanceQuery,
  resolveSoldScrapeTargets,
  isHemnetSafetyError,
};
