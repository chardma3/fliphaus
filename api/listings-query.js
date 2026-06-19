// Renovation score at or above which a listing is a "strong flip" — both
// kitchen and bathroom need work, the real upside. The dashboard shows these;
// everything below is browsable in the Move-in ready view.
const { PROJECT_ADDRESS } = require("./project-listing");

const DEAL_MIN_SCORE = 7;
// Husby/Rinkeby/Vällingby/Akalla: thin-liquidity / weak-exit areas. Rissne and
// Hallonbergen (northern Sundbyberg) added 2026-06-19 — dropped as a scraped
// area for the same reason; excluded here too so they can't leak in via an
// adjacent area's catchment (e.g. Solna).
const EXCLUDED_LOCATIONS = /husby|rinkeby|vällingby|akalla|rissne|hallonbergen/i;

// Days on the market at or beyond which a listing counts as "sitting" — long
// enough that the usual Stockholm visning/bidding cycle should have cleared it,
// so it may be mispriced or have a problem, which is negotiating room.
const SITTING_MIN_DAYS = 7;

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
function buildActiveFeedFilter({ view = "deals", maxPrice, dealMinScore = DEAL_MIN_SCORE, sittingBefore } = {}) {
  const filter = {
    status: "active",
    locationDescription: { $not: EXCLUDED_LOCATIONS },
  };
  if (maxPrice != null) filter.askingPriceNum = { $lte: maxPrice };

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

module.exports = { buildActiveFeedFilter, DEAL_MIN_SCORE, SITTING_MIN_DAYS };
