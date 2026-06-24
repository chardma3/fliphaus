// Area expansion backlog + sourcing priority.
//
// Tiers rank a candidate area by FIT WITH THE RENOVATION-ARBITRAGE THESIS: buy an
// original / unrenovated unit at a discount, renovate, and exit fast into a liquid
// bostadsrätt (BR) resale market. The thing that makes a flip work is a reliable
// unrenovated -> renovated price spread (see api/area-intelligence.js renovationSpread)
// in a market deep enough to sell into. Tiers:
//
//   A — strong fit. Old funkis/sekelskifte stock with original interiors, deep
//       liquid resale, clear and reliable reno spread. Add first.
//   B — selective / monitor. Decent markets, but filter hard (new-build dilution,
//       thin BR flow, or a structural catalyst worth watching rather than buying yet).
//   C — skip. Thesis doesn't hold: campus/student housing (no BR market), mostly
//       new-build (nothing to arbitrage), or villa-dominated (thin BR flow).
//
// This file is the BACKLOG, not the live scrape. An area goes live only when its
// Hemnet locationId is resolved (browser — scripts/find-location-ids.js is stale)
// and copied into LOCATION_IDS in api/hemnet-refresh-safety.js. Until then
// locationId is null and status is "pending". Filters below are declarative intent
// for the feed/analysis layer. The listings query consumes maxPriceSEK + compsOnly
// for ACTIVE areas (see activeAreaConstraints in api/listings-query.js); they stay
// dormant until an area carrying one is flipped live in LOCATION_IDS. excludeNewBuild
// is not wired into the feed yet (flip views already drop projekt listings).
//
// Filter semantics:
//   maxPriceSEK    — only surface listings at/under this total asking price. For
//                    prime inner-city this is the whole point: it forces the
//                    UNRENOVATED OUTLIERS into view instead of already-done premium
//                    units we'd just be overpaying for. null = no cap.
//   excludeNewBuild— drop units built within NEW_BUILD_MAX_AGE_YEARS (api/area-
//                    intelligence.js isNewBuild proxy). For areas diluted by new
//                    production (Nacka, Ropsten, Ulriksdal) where there's no
//                    original stock to arbitrage.
//   compsOnly      — scrape sold comps + benchmarks but DON'T surface as deals in
//                    the Deals feed (same posture as Rissne/Kista today). For
//                    monitor-but-don't-buy areas.
//   catalyst       — structural signal to watch (up or down), free text. Not a
//                    filter; a monitoring note surfaced on /areas.

const AREA_PRIORITY = [
  // ---------------------------------------------------------------------------
  // TIER A — reno-arbitrage core. Add first.
  // ---------------------------------------------------------------------------
  {
    name: "Gärdet",
    tier: "A",
    phase: 1,
    status: "active", // promoted 2026-06-22 — live id 925958 in LOCATION_IDS
    locationId: null,
    transit: "red line (Ropsten branch) / Östermalm",
    filters: { maxPriceSEK: null, excludeNewBuild: false, compsOnly: false, catalyst: null },
    note:
      "1930s–40s funkis with tons of ORIGINAL kitchens/baths and fierce resale " +
      "liquidity — almost the platonic reno-arbitrage area. Östermalm-quality " +
      "signal at lower capital and competition than the prime cores. Note: Gärdet " +
      "sits inside the Östermalm district node; Phase 1 uses the narrow Gärdet ID, " +
      "Phase 2 broadens to the full Östermalm node (don't run both — double-scrape).",
  },
  {
    name: "Essingeöarna",
    tier: "A",
    phase: 1,
    status: "active", // promoted 2026-06-22 — Hemnet IDs the two islands separately,
    locationId: null, // so LOCATION_IDS carries "Lilla Essingen" 473386 + "Stora Essingen" 473422
    transit: "Kungsholmen-adjacent islands (Stora/Lilla Essingen)",
    filters: { maxPriceSEK: null, excludeNewBuild: false, compsOnly: false, catalyst: null },
    note:
      "40s–60s folkhem stock, family demand, deep market. Same profile as Gärdet, " +
      "slightly cheaper entry. Sits inside the Kungsholmen district hierarchy. " +
      "Live as two separate LOCATION_IDS entries (Lilla + Stora Essingen).",
  },
  {
    name: "Östermalm",
    tier: "A",
    phase: 2,
    status: "pending",
    locationId: null,
    transit: "red line — Stadion, Karlaplan, Tekniska högskolan all subsumed here",
    filters: { maxPriceSEK: 6_000_000, excludeNewBuild: false, compsOnly: false, catalyst: null },
    note:
      "Prime sekelskifte — the BIGGEST absolute reno spread in the city, but " +
      "highest capital/deal and heaviest pro-flipper competition. District node " +
      "subsumes Stadion + Karlaplan + Tekniska högskolan — add those as ONE " +
      "Östermalm ID, not separately. The maxPriceSEK cap is essential: it surfaces " +
      "the unrenovated outlier (the flat untouched since 1985) instead of " +
      "already-done premium units. Gate on Phase 1 proving the cap works.",
  },
  {
    name: "Södermalm",
    tier: "A",
    phase: 2,
    status: "pending",
    locationId: null,
    transit: "red/green lines — Slussen, Medborgarplatsen, Mariatorget",
    filters: { maxPriceSEK: 6_000_000, excludeNewBuild: false, compsOnly: false, catalyst: null },
    note:
      "The other half of the inner-city gap. Cleanest possible test of our core " +
      "signal — pure reno arbitrage, low area risk, excellent exit liquidity — but " +
      "capital-intensive and crowded. Same maxPriceSEK cap rationale as Östermalm.",
  },

  // ---------------------------------------------------------------------------
  // TIER B — selective / monitor. Filter hard.
  // ---------------------------------------------------------------------------
  {
    name: "Nacka",
    tier: "B",
    phase: 3,
    status: "pending",
    locationId: null,
    transit: "blue line extension (~2030) + Saltsjöbanan",
    filters: {
      maxPriceSEK: null,
      excludeNewBuild: true,
      compsOnly: false,
      catalyst: "Blue-line metro extension opening ~2030 — structural UP catalyst (mirror of the Kista risk). Buy the older Finntorp/Järla stock, not new-build Nacka strand/Sickla.",
    },
    note:
      "Worth tracking for the metro catalyst, but most of Nacka strand/Sickla is " +
      "new-build with zero reno upside — excludeNewBuild is mandatory here.",
  },
  {
    name: "Älvsjö",
    tier: "B",
    phase: 3,
    status: "pending",
    locationId: null,
    transit: "pendeltåg (south)",
    filters: { maxPriceSEK: null, excludeNewBuild: false, compsOnly: false, catalyst: null },
    note:
      "Decent southern pendel market, mixed stock, reasonable liquidity. Consistent " +
      "with the existing 'southern / deeper market' preference.",
  },
  {
    name: "Bergshamra",
    tier: "B",
    phase: 3,
    status: "pending",
    locationId: null,
    transit: "red line (Mörby branch), Solna border",
    filters: { maxPriceSEK: null, excludeNewBuild: false, compsOnly: false, catalyst: null },
    note:
      "60s stock on the Solna border; Solna (18028) is already a deep market for us, " +
      "so this is a cheap adjacency add.",
  },
  {
    name: "Stuvsta",
    tier: "B",
    phase: 3,
    status: "pending",
    locationId: null,
    transit: "pendeltåg (Huddinge)",
    filters: { maxPriceSEK: null, excludeNewBuild: false, compsOnly: true, catalyst: null },
    note:
      "Affordable but villa-dominated → thin BR flow. Lowest priority in Tier B; " +
      "start compsOnly and only promote if BR sold-volume proves out.",
  },

  // ---------------------------------------------------------------------------
  // TIER C — skip. Thesis doesn't hold.
  // ---------------------------------------------------------------------------
  {
    name: "Universitetet",
    tier: "C",
    phase: null,
    status: "skip",
    locationId: null,
    transit: "red line",
    filters: { maxPriceSEK: null, excludeNewBuild: false, compsOnly: false, catalyst: null },
    note: "Frescati/Lappkärrsberget is campus + student housing. Almost no BR resale market.",
  },
  {
    name: "Ulriksdal",
    tier: "C",
    phase: null,
    status: "skip",
    locationId: null,
    transit: "pendeltåg (Solna, Järvastaden)",
    filters: { maxPriceSEK: null, excludeNewBuild: true, compsOnly: false, catalyst: null },
    note: "Järvastaden is mostly new-build. No original stock to arbitrage.",
  },
  {
    name: "Ropsten",
    tier: "C",
    phase: null,
    status: "skip",
    locationId: null,
    transit: "red line terminus",
    filters: { maxPriceSEK: null, excludeNewBuild: true, compsOnly: false, catalyst: null },
    note: "Gateway to Norra Djurgårdsstaden/Hjorthagen = new-build. Same problem.",
  },
  {
    name: "Danderyds sjukhus",
    tier: "C",
    phase: null,
    status: "skip",
    locationId: null,
    transit: "red line (Mörby branch), Danderyd",
    filters: { maxPriceSEK: null, excludeNewBuild: false, compsOnly: false, catalyst: null },
    note: "Danderyd is wealthy but villa-dominated; thin BR flow and you'd buy INTO premium, not capture a spread.",
  },
  {
    name: "Mörby centrum",
    tier: "C",
    phase: null,
    status: "skip",
    locationId: null,
    transit: "red line terminus, Danderyd",
    filters: { maxPriceSEK: null, excludeNewBuild: false, compsOnly: false, catalyst: null },
    note: "Same as Danderyds sjukhus — villa-heavy, thin BR flow. Skip unless 60s–70s flat pockets surface.",
  },
];

const TIER_RANK = { A: 0, B: 1, C: 2 };

// Backlog ordered for rollout: tier first, then phase. Skips sink to the bottom.
function rolloutOrder() {
  return [...AREA_PRIORITY].sort((a, b) => {
    if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
    return (a.phase ?? Infinity) - (b.phase ?? Infinity);
  });
}

// Candidates to activate in a given rollout phase (1, 2, 3). Excludes skips and
// anything already promoted into LOCATION_IDS.
function pendingForPhase(phase) {
  return AREA_PRIORITY.filter((a) => a.status === "pending" && a.phase === phase);
}

function getArea(name) {
  const n = String(name).trim().toLowerCase();
  return AREA_PRIORITY.find((a) => a.name.toLowerCase() === n) || null;
}

// Per-area filter intent for a name (active or backlog). Active areas with no
// entry here get a permissive default (surface everything, no cap).
const DEFAULT_FILTERS = { maxPriceSEK: null, excludeNewBuild: false, compsOnly: false, catalyst: null };
function getAreaFilters(name) {
  const area = getArea(name);
  return area ? area.filters : DEFAULT_FILTERS;
}

module.exports = {
  AREA_PRIORITY,
  rolloutOrder,
  pendingForPhase,
  getArea,
  getAreaFilters,
  DEFAULT_FILTERS,
};
