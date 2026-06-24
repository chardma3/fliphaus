// Renovation score at or above which a listing is a "strong flip" — both
// kitchen and bathroom need work, the real upside. The dashboard shows these;
// everything below is browsable in the Move-in ready view.
const { PROJECT_ADDRESS } = require("./project-listing");
const { AREA_PRIORITY } = require("./area-priority");

const DEAL_MIN_SCORE = 7;
// Husby/Rinkeby/Vällingby/Akalla: thin-liquidity / weak-exit areas. Rissne and
// Hallonbergen (northern Sundbyberg) added 2026-06-19 — dropped as a scraped
// area for the same reason; excluded here too so they can't leak in via an
// adjacent area's catchment (e.g. Solna).
const EXCLUDED_LOCATIONS = /husby|rinkeby|vällingby|akalla|rissne|hallonbergen/i;

// Days on the market at or beyond which a listing counts as "sitting" — long
// enough that the usual Stockholm visning/bidding cycle should have cleared it,
// so it may be mispriced or have a problem, which is negotiating room.
const SITTING_MIN_DAYS = 14;

// The active dashboard splits into these views:
//   deals       — strong renovation flips (score >= DEAL_MIN_SCORE).
//   moveinready — everything else that's been scored (1..DEAL_MIN_SCORE-1):
//                 already-renovated 1-3 plus partial-reno 4-6, for browsing.
//   newbuild    — new-build / projekt listings (addressed by development name,
//                 no street number). Market data, not flips — no score filter.
//   sitting     — real apartments on the market a while (any score), where a
//                 motivated seller may take an offer below asking.
// Unscored/pending flips appear in NEITHER deals nor moveinready — they show up
// once analysed, so a backlog of freshly-scraped listings can't flood the feed.
// Per-area feed constraints (api/area-priority.js). Two declarative filters are
// consumed here:
//   compsOnly    — scrape the area for sold comps/benchmarks but never surface it
//                  as a buyable listing (same posture as the hardcoded
//                  EXCLUDED_LOCATIONS). Folded into the exclusion regex.
//   maxPriceSEK  — only surface listings at/under this asking price IN THAT AREA.
//                  For prime inner-city (Östermalm/Södermalm) this forces the
//                  unrenovated outliers into view instead of already-done premium
//                  units. Other areas are unaffected.
// excludeNewBuild isn't wired here: the flip views already drop projekt listings
// via PROJECT_ADDRESS, and the build-year proxy lives in the analysis pipeline.
//
// Only areas live in LOCATION_IDS carry status "active"; the many areas that
// predate area-priority.js aren't listed there and fall through to permissive
// defaults, so this can only ADD constraints, never remove an area silently.
function activeAreaConstraints() {
  return AREA_PRIORITY.filter(
    (a) =>
      a.status === "active" &&
      (a.filters.compsOnly || a.filters.maxPriceSEK != null)
  );
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function areaRegex(name) {
  return new RegExp(escapeRegex(name), "i");
}

// Exclusion regex extended with any active compsOnly area names. Returns the
// shared EXCLUDED_LOCATIONS object unchanged when there's nothing to add, so the
// produced filter is byte-identical to the pre-wiring behaviour in that case.
function exclusionRegex(compsOnlyNames) {
  if (!compsOnlyNames.length) return EXCLUDED_LOCATIONS;
  const parts = [EXCLUDED_LOCATIONS.source, ...compsOnlyNames.map(escapeRegex)];
  return new RegExp(parts.join("|"), "i");
}

function buildActiveFeedFilter({
  view = "deals",
  maxPrice,
  dealMinScore = DEAL_MIN_SCORE,
  sittingBefore,
  areaConstraints = activeAreaConstraints(),
} = {}) {
  const compsOnlyNames = areaConstraints
    .filter((a) => a.filters.compsOnly)
    .map((a) => a.name);
  const capped = areaConstraints.filter((a) => a.filters.maxPriceSEK != null);

  const filter = {
    status: "active",
    locationDescription: { $not: exclusionRegex(compsOnlyNames) },
  };
  if (maxPrice != null) filter.askingPriceNum = { $lte: maxPrice };

  // Each capped area adds a "NOT (in this area AND over its cap)" clause, so a
  // listing outside the capped areas is never affected and an over-cap listing
  // inside one is dropped from every view.
  if (capped.length) {
    filter.$nor = capped.map((a) => ({
      locationDescription: areaRegex(a.name),
      askingPriceNum: { $gt: a.filters.maxPriceSEK },
    }));
  }

  if (view === "newbuild") {
    // Only new-build/projekt listings; shown regardless of renovation score.
    filter.streetAddress = PROJECT_ADDRESS;
    return filter;
  }

  // Flips never include new-build/projekt listings.
  filter.streetAddress = { $not: PROJECT_ADDRESS };

  if (view === "sitting") {
    // The signal here is time on market, not condition — so any renovation
    // score (incl. unscored). Bound by publishedAt so only listings up long
    // enough to be worth an offer appear.
    if (sittingBefore) filter.publishedAt = { $lte: sittingBefore, $ne: null };
    return filter;
  }

  filter.renovationScore = view === "moveinready"
    ? { $gte: 1, $lte: dealMinScore - 1 }
    : { $gte: dealMinScore };
  return filter;
}

module.exports = { buildActiveFeedFilter, activeAreaConstraints, DEAL_MIN_SCORE, SITTING_MIN_DAYS };
