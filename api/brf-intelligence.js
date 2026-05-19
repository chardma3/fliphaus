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

function avgiftRisk(debtPerSqm) {
  const debt = parseNumber(debtPerSqm);
  if (debt == null) return "unknown";
  if (debt >= 12000) return "high";
  if (debt >= 6000) return "medium";
  return "low";
}

function saleMatchesListingArea(sale, listingArea) {
  if (!listingArea) return false;
  const saleArea = firstAreaToken(sale.area) || firstAreaToken(sale.locationDescription);
  return saleArea === listingArea;
}

function buildComparableSet(listing, soldListings = []) {
  const listingBrf = normalizeBrfName(listing.brfName);
  const listingArea = firstAreaToken(listing.locationDescription) || firstAreaToken(listing.area);

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

function calculateConfidence(scope, renovatedSales, unrenovatedSales) {
  if (!renovatedSales || !unrenovatedSales) return "low";
  if (scope === "same_brf") {
    if (renovatedSales >= 2 && unrenovatedSales >= 2) return "high";
    return "medium";
  }
  if (renovatedSales >= 1 && unrenovatedSales >= 1) return "medium";
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

  const avgRenovatedSqm = average(renovated);
  const avgUnrenovatedSqm = average(unrenovated);
  const estimatedUpliftPerSqm = avgRenovatedSqm != null && avgUnrenovatedSqm != null
    ? Math.max(0, avgRenovatedSqm - avgUnrenovatedSqm)
    : null;
  const estimatedUpliftTotal = estimatedUpliftPerSqm != null && sizeSqm
    ? Math.round(estimatedUpliftPerSqm * sizeSqm)
    : null;
  const confidence = calculateConfidence(scope, renovated.length, unrenovated.length);

  const basis = scope === "same_brf"
    ? "same BRF sales"
    : scope === "area"
      ? "area-level sales"
      : "insufficient sold-listing evidence";

  const summary = estimatedUpliftPerSqm != null
    ? `${basis}: renovated comparables average ${avgRenovatedSqm.toLocaleString("sv-SE")} kr/m² vs unrenovated ${avgUnrenovatedSqm.toLocaleString("sv-SE")} kr/m², implying about +${estimatedUpliftPerSqm.toLocaleString("sv-SE")} kr/m² before renovation costs.`
    : `${basis}: not enough renovated and unrenovated sold comparables yet.`;

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
      totalComparableSales: sales.length,
      renovatedSales: renovated.length,
      unrenovatedSales: unrenovated.length,
      partlyRenovatedSales: partlyRenovated.length,
      unknownConditionSales: unknown.length,
      avgRenovatedSqm,
      avgUnrenovatedSqm,
      estimatedUpliftPerSqm,
      estimatedUpliftTotal,
      summary,
    },
  };
}

module.exports = {
  buildBrfIntelligence,
  classifySoldCondition,
  normalizeBrfName,
};
