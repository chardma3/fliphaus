// Renovation score at or above which a listing is a "strong flip" — both
// kitchen and bathroom need work, the real upside. The dashboard shows these;
// everything below is browsable in the Move-in ready view.
const DEAL_MIN_SCORE = 7;
const EXCLUDED_LOCATIONS = /husby|rinkeby|vällingby|akalla/i;

// The active dashboard splits into two views:
//   deals       — strong renovation flips (score >= DEAL_MIN_SCORE), PLUS
//                 not-yet-scored listings (null) so a newly scraped listing
//                 isn't hidden while it waits for the next analysis run.
//   moveinready — everything else that's been scored (1..DEAL_MIN_SCORE-1):
//                 already-renovated 1-3 plus partial-reno 4-6. For browsing what
//                 is available and at what price, off the main deal view.
// Unscored listings appear only in "deals" (as pending), never in moveinready.
function buildActiveFeedFilter({ view = "deals", maxPrice, dealMinScore = DEAL_MIN_SCORE } = {}) {
  const filter = {
    status: "active",
    locationDescription: { $not: EXCLUDED_LOCATIONS },
  };
  if (maxPrice != null) filter.askingPriceNum = { $lte: maxPrice };

  if (view === "moveinready") {
    filter.renovationScore = { $gte: 1, $lte: dealMinScore - 1 };
  } else {
    filter.$or = [
      { renovationScore: { $gte: dealMinScore } },
      { renovationScore: null },
    ];
  }
  return filter;
}

module.exports = { buildActiveFeedFilter, DEAL_MIN_SCORE };
