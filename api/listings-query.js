// Renovation score at or above which a listing is a "strong flip" — both
// kitchen and bathroom need work, the real upside. The dashboard shows these;
// everything below is browsable in the Move-in ready view.
const { PROJECT_ADDRESS } = require("./project-listing");
const { AREA_PRIORITY } = require("./area-priority");

const DEAL_MIN_SCORE = 6;
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
//                 already-renovated 1-3 plus partial-reno 4-5, for browsing.
//   newbuild    — new-build / projekt listings (addressed by development name,
//                 no street number). Market data, not flips — no score filter.
//   sitting     — real apartments on the market a while (any score, incl.
//                 unscored), where a motivated seller may take an offer below
//                 asking. Sitting takes precedence: a listing that's been
//                 sitting shows here only, dropped from deals and move-in ready
//                 (Sitting > Deals > Move-in ready; each surfaces in exactly one).
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
  // Override the listing status the filter targets. Defaults to "active" (the
  // live feed). The disappeared digest passes "disappeared" so it reuses the
  // SAME buyability gates (area exclusions + per-area price caps) — a listing
  // that was never buyable (e.g. an over-cap Östermalm unit) must not surface in
  // Disappeared either, exactly as it never showed in any active section.
  status = "active",
  // When true, restrict the whole feed to listings the admin has explicitly
  // shared with friends (sharedWithFriends: true). The friends dashboard passes
  // this so friends see a curated set, not the entire feed; every view (deals,
  // move-in ready, sitting, new builds) is intersected with the shared set.
  sharedOnly = false,
  areaConstraints = activeAreaConstraints(),
} = {}) {
  const compsOnlyNames = areaConstraints
    .filter((a) => a.filters.compsOnly)
    .map((a) => a.name);
  const capped = areaConstraints.filter((a) => a.filters.maxPriceSEK != null);

  const filter = {
    status,
    locationDescription: { $not: exclusionRegex(compsOnlyNames) },
  };
  // Applied on the base filter so it carries into every view, including the
  // newbuild and sitting branches that return early below.
  if (sharedOnly) filter.sharedWithFriends = true;
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
    // enough to be worth an offer appear. Sitting is the highest-priority
    // surface: a listing that's been on the market past the cutoff shows here
    // and is excluded from Deals and Move-in ready (the exclusion lives in the
    // flip branch below), so the views never overlap.
    if (sittingBefore) filter.publishedAt = { $lte: sittingBefore, $ne: null };
    return filter;
  }

  filter.renovationScore = view === "moveinready"
    ? { $gte: 1, $lte: dealMinScore - 1 }
    : { $gte: dealMinScore };

  // Mutual exclusion with the sitting view, for BOTH flip views (deals and
  // move-in ready): a listing that's been on the market past the cutoff shows
  // under Sitting only, never here too. Sitting wins outright — a strong flip
  // that's been sitting 2+ weeks surfaces in Sitting, not Deals. Priority order
  // across the active feed is Sitting > Deals > Move-in ready; each listing
  // appears in exactly one. A null/absent publishedAt isn't "sitting", so it
  // stays visible here. (newbuild is already disjoint — sitting excludes projekt
  // listings above.) Only applied when the caller supplies the cutoff, so the
  // pure-shape unit tests are unaffected.
  if (sittingBefore) {
    filter.$or = [
      { publishedAt: { $gt: sittingBefore } },
      { publishedAt: null },
    ];
  }

  // NOTE: we deliberately DON'T hide deals whose bathroom wasn't pictured. A
  // score >= DEAL_MIN_SCORE scored blind to the bathroom is provisional, but the
  // dashboard already flags that on the card ("⚠ Bathroom not pictured — score
  // provisional", driven by imageCoverageComplete), and the fast coverage sweep
  // re-hydrates and corrects it within minutes. Excluding them instead made a
  // high-score-but-unverified listing vanish entirely (gated out of Deals, score
  // too high for Move-in ready) — worse than showing it flagged.
  return filter;
}

module.exports = { buildActiveFeedFilter, activeAreaConstraints, DEAL_MIN_SCORE, SITTING_MIN_DAYS };
