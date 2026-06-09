// Renovation score at or above which a listing is a "strong flip" — both
// kitchen and bathroom need work, the real upside. The dashboard shows these;
// everything below is browsable in the Move-in ready view.
const DEAL_MIN_SCORE = 7;
const EXCLUDED_LOCATIONS = /husby|rinkeby|vällingby|akalla/i;

// The active dashboard splits into two views, both scored-only:
//   deals       — strong renovation flips (score >= DEAL_MIN_SCORE).
//   moveinready — everything else that's been scored (1..DEAL_MIN_SCORE-1):
//                 already-renovated 1-3 plus partial-reno 4-6, for browsing.
// Unscored/pending listings appear in NEITHER view — they show up once analysed,
// so a backlog of freshly-scraped listings can't flood the dashboard.
function buildActiveFeedFilter({ view = "deals", maxPrice, dealMinScore = DEAL_MIN_SCORE } = {}) {
  const filter = {
    status: "active",
    locationDescription: { $not: EXCLUDED_LOCATIONS },
  };
  if (maxPrice != null) filter.askingPriceNum = { $lte: maxPrice };

  filter.renovationScore = view === "moveinready"
    ? { $gte: 1, $lte: dealMinScore - 1 }
    : { $gte: dealMinScore };
  return filter;
}

module.exports = { buildActiveFeedFilter, DEAL_MIN_SCORE };
