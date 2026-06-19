// Per-area sold-price trend, computed from scraped slutpriser (SoldListing).
//
// The comps dataset already powers benchmarks and BRF intelligence; here we use
// its time dimension (soldDate + soldPriceSqm) to answer "which way is an area
// moving?". That's the signal for buy-timing — e.g. Kista is falling on the
// Ericsson HQ move, and we want to SEE when it flattens and turns, not guess.
//
// Pure functions only (no DB), so they're unit-testable and the caller passes
// the sold listings + a reference "now".

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function monthKey(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

// Monthly average kr/m² per area over the trailing `monthsBack` months.
// Returns chronological points (oldest → newest) so the UI can draw a sparkline.
function monthlySqmSeries(listings, { now, monthsBack = 12 } = {}) {
  const cutoff = now.getTime() - monthsBack * 31 * MS_PER_DAY;
  const byMonth = {};
  listings.forEach((l) => {
    if (!l.soldDate || !l.soldPriceSqm) return;
    const d = new Date(l.soldDate);
    if (d.getTime() < cutoff) return;
    const key = monthKey(d);
    (byMonth[key] ||= []).push(l.soldPriceSqm);
  });
  return Object.keys(byMonth)
    .sort()
    .map((month) => ({ month, avgSqm: avg(byMonth[month]), count: byMonth[month].length }));
}

// Direction over the last `windowDays` vs the preceding equal window. Needs a
// minimum number of sales in BOTH windows to call a direction — thin areas
// (Rissne, Kärrtorp) won't have the volume, and a 2-sale swing isn't a trend.
function priceDirection(listings, { now, windowDays = 90, minCount = 4 } = {}) {
  const t = now.getTime();
  const recent = [];
  const prior = [];
  listings.forEach((l) => {
    if (!l.soldDate || !l.soldPriceSqm) return;
    const ageDays = (t - new Date(l.soldDate).getTime()) / MS_PER_DAY;
    if (ageDays < 0) return;
    if (ageDays <= windowDays) recent.push(l.soldPriceSqm);
    else if (ageDays <= windowDays * 2) prior.push(l.soldPriceSqm);
  });

  const recentAvg = avg(recent);
  const priorAvg = avg(prior);
  if (recent.length < minCount || prior.length < minCount || !priorAvg) {
    return { level: "insufficient", pct: null, recentAvgSqm: recentAvg, priorAvgSqm: priorAvg, recentCount: recent.length, priorCount: prior.length };
  }

  const pct = Math.round(((recentAvg - priorAvg) / priorAvg) * 1000) / 10;
  // ±1.5% over a quarter is noise, not a move.
  const level = pct > 1.5 ? "up" : pct < -1.5 ? "down" : "flat";
  return { level, pct, recentAvgSqm: recentAvg, priorAvgSqm: priorAvg, recentCount: recent.length, priorCount: prior.length };
}

// One trend object per area: { area: { series, direction } }.
function buildAreaTrends(soldListings, { now = new Date(), monthsBack = 12, windowDays = 90, minCount = 4 } = {}) {
  const byArea = {};
  soldListings.forEach((l) => {
    const area = l.area || "Unknown";
    (byArea[area] ||= []).push(l);
  });

  const areas = {};
  Object.entries(byArea).forEach(([area, listings]) => {
    areas[area] = {
      series: monthlySqmSeries(listings, { now, monthsBack }),
      direction: priceDirection(listings, { now, windowDays, minCount }),
    };
  });
  return areas;
}

module.exports = { buildAreaTrends, monthlySqmSeries, priceDirection };
