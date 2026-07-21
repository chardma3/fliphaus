function parseNumber(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = parseFloat(String(value).replace(",", ".").replace(/[^\d.\-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBrfName(name) {
  if (!name) return null;
  return String(name)
    .toLowerCase()
    .replace(/\bbostadsrättsföreningen\b/g, "")
    .replace(/\bbostadsrattsforeningen\b/g, "")
    .replace(/\bbostadsrättsförening\b/g, "")
    .replace(/\bbostadsrattsforening\b/g, "")
    .replace(/\bbrf\b/g, "")
    .replace(/\bnr\b/g, "")
    .replace(/[.,:;()]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function firstAreaToken(value) {
  if (!value) return null;
  return String(value).split(",")[0].trim().toLowerCase() || null;
}

const { AREA_NAMES } = require("./hemnet-refresh-safety");
// Canonical scraped-area names, lowercased, longest token-sequence first so a
// multi-word name ("stora essingen") is preferred over a bare token.
const CANONICAL_AREAS = (AREA_NAMES || [])
  .map((name) => name.toLowerCase())
  .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length || b.length - a.length);

// Map a raw area/location string to the scraped area it belongs to, so a
// sub-label ("Södermalm - Sofo", "Gamla Enskede", "Bromma - Traneberg") matches
// the sold comps stored under its parent area ("Södermalm", "Enskede", "Bromma").
// Hemnet uses commas, slashes and dashes between the area and its sub-label, so
// exact first-token equality threw away hundreds of real comps over formatting.
// Whole-token match only (no substrings), falling back to the first token when
// no scraped area is recognised — so unscraped areas honestly stay unmatched.
function canonicalArea(value) {
  if (!value) return null;
  const tokens = String(value).toLowerCase().split(/[^a-zåäöé0-9]+/).filter(Boolean);
  if (!tokens.length) return null;
  const joined = ` ${tokens.join(" ")} `;
  for (const name of CANONICAL_AREAS) {
    if (joined.includes(` ${name} `)) return name;
  }
  return tokens[0];
}

function classifySoldCondition(sold) {
  const label = sold?.conditionLabel || sold?.condition;
  if (label) {
    const normalized = String(label).toLowerCase().replace(/[\s-]+/g, "_");
    if (["renovated", "newly_renovated", "done_up"].includes(normalized)) return "renovated";
    if (["partly_renovated", "partly", "mixed"].includes(normalized)) return "partly_renovated";
    if (["unrenovated", "needs_renovation", "original", "dated"].includes(normalized)) return "unrenovated";
  }

  const score = parseNumber(sold?.renovationScore);
  if (score == null) return "unknown";
  if (score <= 3) return "renovated";
  if (score >= 7) return "unrenovated";
  return "partly_renovated";
}

function average(values) {
  const valid = values.filter((v) => Number.isFinite(v) && v > 0);
  if (!valid.length) return null;
  return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
}

// Linear-interpolated percentile of a value set (p in 0..100). Used to read a
// "renovated resale" level straight off the real local sold-price distribution:
// renovated / well-presented flats cluster at the top, so the 75th percentile of
// actual sales is a data-driven resale estimate that needs NO per-comp condition
// classification. Auto-updates as new comps land.
function percentile(values, p) {
  const valid = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!valid.length) return null;
  if (valid.length === 1) return Math.round(valid[0]);
  const idx = (p / 100) * (valid.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(valid[lo]);
  return Math.round(valid[lo] + (valid[hi] - valid[lo]) * (idx - lo));
}

// The percentile of the local sold-price distribution we treat as the
// renovated-resale benchmark. 75th = "sells near the top of the local range".
const RENOVATED_RESALE_PERCENTILE = 75;

function avgiftRisk(debtPerSqm) {
  const debt = parseNumber(debtPerSqm);
  if (debt == null) return "unknown";
  if (debt >= 12000) return "high";
  if (debt >= 6000) return "medium";
  return "low";
}

// Precompute the per-sale groupings ONCE for a batch of listings. Without this,
// buildComparableSet re-ran normalizeBrfName + canonicalArea (regex-heavy, and
// canonicalArea scans every canonical area name) for every (listing, sale) pair
// — O(listings × sold) expensive string ops, which is what made the feed take
// ~a minute. Here each sale is classified a single time and bucketed by its
// normalized BRF and its canonical area; buildComparableSet then does O(1) Map
// lookups. Keying/eligibility mirror the old filters EXACTLY (soldPriceSqm > 0;
// area from the sale's real locationDescription, falling back to its scraped
// `area`) so the produced comparable sets are byte-identical to the old path.
function buildSoldIndex(soldListings = []) {
  const byBrf = new Map();
  const byArea = new Map();
  for (const sale of soldListings) {
    if (!(parseNumber(sale.soldPriceSqm) > 0)) continue;
    const brfKey = normalizeBrfName(sale.brfName);
    if (brfKey) {
      if (!byBrf.has(brfKey)) byBrf.set(brfKey, []);
      byBrf.get(brfKey).push(sale);
    }
    const areaKey = canonicalArea(sale.locationDescription) || canonicalArea(sale.area);
    if (areaKey) {
      if (!byArea.has(areaKey)) byArea.set(areaKey, []);
      byArea.get(areaKey).push(sale);
    }
  }
  return { byBrf, byArea };
}

function buildComparableSet(listing, soldIndex) {
  const listingBrf = normalizeBrfName(listing.brfName);
  const listingArea = canonicalArea(listing.locationDescription) || canonicalArea(listing.area);

  const sameBrf = listingBrf ? soldIndex.byBrf.get(listingBrf) || [] : [];
  if (sameBrf.length) {
    return { scope: "same_brf", sales: sameBrf };
  }

  const sameArea = listingArea ? soldIndex.byArea.get(listingArea) || [] : [];
  return { scope: sameArea.length ? "area" : "none", sales: sameArea };
}

// Confidence in the resale estimate is about how much real local evidence backs
// the percentile — i.e. how many comparable sales we have — NOT whether each one
// was tagged renovated vs unrenovated. A year of scraped sold data usually yields
// plenty of area comps, so the estimate reads as confident instead of being
// thrown away as "not enough similar sales".
function calculateConfidence(scope, comparableCount) {
  if (scope === "none" || !comparableCount) return "low";
  if (scope === "same_brf") {
    if (comparableCount >= 4) return "high";
    if (comparableCount >= 2) return "medium";
    return "low";
  }
  // area scope
  if (comparableCount >= 12) return "high";
  if (comparableCount >= 5) return "medium";
  return "low";
}

function buildBrfIntelligence(listing, soldListingsOrIndex = []) {
  // Accept either a raw sold array (single-listing callers, tests, scripts) or a
  // prebuilt index (the feed, which builds it once for the whole batch). An array
  // is indexed here so one-off calls stay correct; the feed skips this by passing
  // the shared index, which is the whole point of the optimization.
  const soldIndex = Array.isArray(soldListingsOrIndex)
    ? buildSoldIndex(soldListingsOrIndex)
    : soldListingsOrIndex;
  const { scope, sales } = buildComparableSet(listing, soldIndex);
  const sizeSqm = parseNumber(listing.size) || parseNumber(listing.sizeNum);

  const renovated = [];
  const unrenovated = [];
  const partlyRenovated = [];
  const unknown = [];

  for (const sale of sales) {
    const price = parseNumber(sale.soldPriceSqm);
    if (!price) continue;
    const condition = classifySoldCondition(sale);
    if (condition === "renovated") renovated.push(price);
    else if (condition === "unrenovated") unrenovated.push(price);
    else if (condition === "partly_renovated") partlyRenovated.push(price);
    else unknown.push(price);
  }

  // Resale benchmark from the real local sold kr/m². The 75th percentile assumes a
  // renovated flat sells NEAR THE TOP of the local range — but we can only justify
  // that when we actually have condition-matched renovated comps proving renovated
  // units fetch a premium. With ZERO renovated comps (every sale unknown-condition)
  // the honest estimate is the MEDIAN — the typical local price — not the top
  // quartile, which otherwise inflates the ROI on an unproven premium.
  const allSqm = sales.map((sale) => parseNumber(sale.soldPriceSqm)).filter((p) => p > 0);
  const comparableCount = allSqm.length;
  const resalePercentile = renovated.length > 0 ? RENOVATED_RESALE_PERCENTILE : 50;
  const estimatedRenovatedSqm = percentile(allSqm, resalePercentile);
  const medianSqm = percentile(allSqm, 50);

  // The renovated-vs-unrenovated split is still computed when comps happen to be
  // tagged (e.g. sold units we'd already scored as active listings), to surface a
  // richer per-flat uplift line — but it's no longer required for a confident
  // estimate.
  const avgRenovatedSqm = average(renovated);
  const avgUnrenovatedSqm = average(unrenovated);
  const classifiedUpliftPerSqm = avgRenovatedSqm != null && avgUnrenovatedSqm != null
    ? Math.max(0, avgRenovatedSqm - avgUnrenovatedSqm)
    : null;
  const estimatedUpliftTotal = classifiedUpliftPerSqm != null && sizeSqm
    ? Math.round(classifiedUpliftPerSqm * sizeSqm)
    : null;
  let confidence = calculateConfidence(scope, comparableCount);
  // Volume alone doesn't make a RENOVATED-resale estimate high-confidence. With no
  // condition-matched renovated comps we're using the median (typical local price),
  // which is an honest area estimate but not a proven renovated level — so cap it
  // at "medium" rather than claiming "high" off comp count.
  if (renovated.length === 0 && confidence === "high") confidence = "medium";

  const basis = scope === "same_brf"
    ? "same BRF sales"
    : scope === "area"
      ? "area-level sales"
      : "insufficient sold-listing evidence";

  const percentileLabel = renovated.length > 0 ? "75th percentile" : "median";
  const summary = estimatedRenovatedSqm != null
    ? `${basis}: ${comparableCount} sold comparable${comparableCount === 1 ? "" : "s"} in the last year, resale around ${estimatedRenovatedSqm.toLocaleString("sv-SE")} kr/m² (${percentileLabel} of local sales${renovated.length ? "" : " — no condition-matched renovated comps, so median not top quartile"}).`
    : `${basis}: no sold comparables collected yet.`;

  return {
    brf: {
      name: listing.brfName || null,
      buildYear: parseNumber(listing.buildYear),
      totalApartments: parseNumber(listing.totalApartments),
      debtPerSqm: parseNumber(listing.brfDebtPerSqm),
      avgiftRisk: avgiftRisk(listing.brfDebtPerSqm),
      stambyte: {
        status: listing.stambyteStatus || "unknown",
        year: parseNumber(listing.stambyteYear),
      },
      renovationRules: listing.renovationRules || null,
    },
    renovationArbitrage: {
      scope,
      basis,
      confidence,
      totalComparableSales: comparableCount,
      estimatedRenovatedSqm,
      medianSqm,
      renovatedSales: renovated.length,
      unrenovatedSales: unrenovated.length,
      partlyRenovatedSales: partlyRenovated.length,
      unknownConditionSales: unknown.length,
      avgRenovatedSqm,
      avgUnrenovatedSqm,
      estimatedUpliftPerSqm: classifiedUpliftPerSqm,
      estimatedUpliftTotal,
      summary,
    },
  };
}

module.exports = {
  buildBrfIntelligence,
  buildSoldIndex,
  classifySoldCondition,
  normalizeBrfName,
  canonicalArea,
};
