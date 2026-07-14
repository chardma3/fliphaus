// Bound the sold-comparables collection so it can't grow without limit. Every
// consumer of sold data uses at most ~12 months of history (the comp estimate,
// the 12-month sold-trends series, the liquidity soldCount12m, and reconcile-sold
// which only matches recent disappearances), so rows older than
// SOLD_RETENTION_MONTHS (default 15 — a safety margin over the 12-month users) are
// safe to drop. These are re-scrapeable market reference rows, NOT our scored
// listings (those live in the Listing collection and are never touched here).
//
// Rows with no soldDate are KEPT (we can't age them). `dryRun` counts what WOULD
// be deleted without deleting, so the size/age can be reviewed before committing.
function retentionMonths(env = process.env) {
  const n = Number(env.SOLD_RETENTION_MONTHS);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

// Approximate a month as 30.44 days — exact enough for a retention cutoff.
function cutoffDate(months, now = Date.now()) {
  return new Date(now - months * 30.44 * 24 * 60 * 60 * 1000);
}

async function pruneOldSold({ SoldListing, months, dryRun = false, now = Date.now() } = {}) {
  const m = months && months > 0 ? months : retentionMonths();
  const cutoff = cutoffDate(m, now);
  const filter = { soldDate: { $ne: null, $lt: cutoff } };

  const matched = await SoldListing.countDocuments(filter);
  let deleted = 0;
  if (!dryRun && matched > 0) {
    const res = await SoldListing.deleteMany(filter);
    deleted = res.deletedCount || 0;
  }
  return { retentionMonths: m, cutoff: cutoff.toISOString(), matched, deleted, dryRun: !!dryRun };
}

module.exports = { pruneOldSold, retentionMonths, cutoffDate };
