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

function saleMatchesListingArea(sale, listingArea) {
  if (!listingArea) return false;
  // Match on the sold comp's REAL location (locationDescription), not its `area`,
  // which is only the broad search catchment it was scraped under. A Kungsholmen
  // flat caught by the Stora-Essingen search has area="Stora Essingen" but
  // locationDescription="Kungsholmen …" — so it must pair with a Kungsholmen
  // listing, not a Stora-Essingen one. Fall back to `area` only when the real
  // location is missing.
  const saleArea = canonicalArea(sale.locationDescription) || canonicalArea(sale.area);
  return saleArea === listingArea;
}

function buildComparableSet(listing, soldListings = []) {
  const listingBrf = normalizeBrfName(listing.brfName);
  const listingArea = canonicalArea(listing.locationDescription) || canonicalArea(listing.area);

  const validSales = soldListings.filter((sale) => parseNumber(sale.soldPriceSqm) > 0);
  const sameBrf = listingBrf
    ? validSales.filter((sale) => normalizeBrfName(sale.brfName) === listingBrf)
    : [];

  if (sameBrf.length) {
    return { scope: "same_brf", sales: sameBrf };
  }

  const sameArea = validSales.filter((sale) => saleMatchesListingArea(sale, listingArea));
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

function buildBrfIntelligence(listing, soldListings = []) {
  const { scope, sales } = buildComparableSet(listing, soldListings);
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

  // Resale benchmark from ALL real comps in scope (classification-free): the 75th
  // percentile of actual sold kr/m². This is the primary estimate the ROI calc
  // uses, so we no longer need every comp tagged renovated/unrenovated.
  const allSqm = sales.map((sale) => parseNumber(sale.soldPriceSqm)).filter((p) => p > 0);
  const comparableCount = allSqm.length;
  const estimatedRenovatedSqm = percentile(allSqm, RENOVATED_RESALE_PERCENTILE);
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
  const confidence = calculateConfidence(scope, comparableCount);

  const basis = scope === "same_brf"
    ? "same BRF sales"
    : scope === "area"
      ? "area-level sales"
      : "insufficient sold-listing evidence";

  const summary = estimatedRenovatedSqm != null
    ? `${basis}: ${comparableCount} sold comparable${comparableCount === 1 ? "" : "s"} in the last year, renovated-level resale around ${estimatedRenovatedSqm.toLocaleString("sv-SE")} kr/m² (75th percentile of local sales).`
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
  classifySoldCondition,
  normalizeBrfName,
  canonicalArea,
};
