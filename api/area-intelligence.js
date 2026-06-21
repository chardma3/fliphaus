// Deep per-area intelligence from our own scraped slutpriser (SoldListing).
// Answers the "is this area's discount a trap or an opportunity" question from
// OUR data — the asset we're building — for any area, not just Kista:
//   1. Renovation spread — renovated vs unrenovated kr/m². Is a renovation
//      premium actually realisable at exit (the thing that makes a flip work)?
//   2. Liquidity — avg days on market + sold-vs-asking %. Will it actually sell?
//   3. New-build sell-through — how recent/new-build units sell vs existing
//      stock (price premium + speed). A proxy for "is there demand for QUALITY
//      here?" — if new/quality stock moves fast at a premium, latent demand
//      exists even in a discounted area.
// Pure + unit-tested; the route feeds it area-filtered sold listings.

// A sale where construction year is within ~3y of the sale = treat as new build.
// (We don't store an explicit new-production flag on sold records, so build year
// vs sold year is the honest proxy. The small negative window tolerates a sale
// that closed just before formal completion year.)
const NEW_BUILD_MAX_AGE_YEARS = 3;

function round(n) {
  return n == null ? null : Math.round(n);
}

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

function avg(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function soldYear(listing) {
  const d = listing.soldDate ? new Date(listing.soldDate) : null;
  return d && !Number.isNaN(d.getTime()) ? d.getFullYear() : null;
}

function isNewBuild(listing) {
  const sy = soldYear(listing);
  if (!listing.buildYear || !sy) return false;
  const age = sy - listing.buildYear;
  return age <= NEW_BUILD_MAX_AGE_YEARS && age >= -2;
}

// Summary stats for one slice of sold listings.
function segment(listings) {
  return {
    n: listings.length,
    avgSqm: round(avg(listings.map((l) => l.soldPriceSqm))),
    medianSqm: round(median(listings.map((l) => l.soldPriceSqm))),
    avgDaysOnMarket: round(avg(listings.map((l) => l.daysOnMarket))),
    avgPriceChange: round1(avg(listings.map((l) => l.priceChange))),
  };
}

function buildAreaIntelligence(soldListings = []) {
  const usable = soldListings.filter((l) => Number.isFinite(l.soldPriceSqm) && l.soldPriceSqm > 0);
  const years = usable.map(soldYear).filter(Boolean);

  const byCond = { renovated: [], partly_renovated: [], unrenovated: [], unknown: [] };
  usable.forEach((l) => {
    const c = ["renovated", "partly_renovated", "unrenovated"].includes(l.conditionLabel) ? l.conditionLabel : "unknown";
    byCond[c].push(l);
  });

  const reno = segment(byCond.renovated);
  const unreno = segment(byCond.unrenovated);
  const spreadPerSqm = reno.avgSqm != null && unreno.avgSqm != null ? reno.avgSqm - unreno.avgSqm : null;
  const renovationSpread = {
    perSqm: spreadPerSqm,
    pctUplift: spreadPerSqm != null && unreno.avgSqm ? round1((spreadPerSqm / unreno.avgSqm) * 100) : null,
    // Need a few comps on each side before the spread means anything.
    confident: byCond.renovated.length >= 3 && byCond.unrenovated.length >= 3,
  };

  const newBuilds = usable.filter(isNewBuild);
  const existing = usable.filter((l) => !isNewBuild(l));
  const nb = segment(newBuilds);
  const ex = segment(existing);
  const newBuild = {
    new: nb,
    existing: ex,
    premiumPerSqm: nb.avgSqm != null && ex.avgSqm != null ? nb.avgSqm - ex.avgSqm : null,
    // Positive = new builds sell FASTER than existing stock (a demand signal).
    fasterSaleDays: nb.avgDaysOnMarket != null && ex.avgDaysOnMarket != null ? ex.avgDaysOnMarket - nb.avgDaysOnMarket : null,
    confident: newBuilds.length >= 3 && existing.length >= 3,
  };

  return {
    sampleSize: usable.length,
    soldYearRange: years.length ? { from: Math.min(...years), to: Math.max(...years) } : null,
    overall: segment(usable),
    byCondition: {
      renovated: reno,
      partly_renovated: segment(byCond.partly_renovated),
      unrenovated: unreno,
      unknownCount: byCond.unknown.length,
    },
    renovationSpread,
    newBuild,
    // Honesty about how much of the area's sold data is enriched enough to trust:
    // conditionLabel + buildYear come from the (slow, limited) sold-analysis pass.
    coverage: {
      withConditionLabel: usable.length - byCond.unknown.length,
      withoutConditionLabel: byCond.unknown.length,
      withDaysOnMarket: usable.filter((l) => Number.isFinite(l.daysOnMarket)).length,
      withBuildYear: usable.filter((l) => Number.isFinite(l.buildYear)).length,
    },
  };
}

// One intelligence object per area: { area: {...} }.
function buildAllAreaIntelligence(soldListings = []) {
  const byArea = {};
  soldListings.forEach((l) => {
    (byArea[l.area || "Unknown"] ||= []).push(l);
  });
  const out = {};
  Object.entries(byArea).forEach(([area, list]) => {
    out[area] = buildAreaIntelligence(list);
  });
  return out;
}

module.exports = { buildAreaIntelligence, buildAllAreaIntelligence, isNewBuild, NEW_BUILD_MAX_AGE_YEARS };
