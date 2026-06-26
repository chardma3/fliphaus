function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function latestDate(values) {
  return values
    .map(parseDate)
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0] || null;
}

function daysBetween(later, earlier) {
  if (!later || !earlier) return null;
  return Math.floor((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDateOnly(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

// The scrapes that run every 24h, for the dashboard health panel. Times are UTC
// (GitHub Actions' cron timezone) — KEEP IN SYNC with the cron lines in
// .github/workflows/{scrape-batch-1,2,3}.yml and refresh-fliphaus.yml. The
// frontend renders them in Stockholm local time so DST is handled there.
const DAILY_SCRAPES = [
  { job: "Active listings — batch 1 of 3", utc: "11:00", does: "New & changed listings" },
  { job: "Active listings — batch 2 of 3", utc: "11:40", does: "New & changed listings" },
  { job: "Active listings — batch 3 of 3", utc: "12:20", does: "New & changed listings" },
  { job: "Sold prices + photo analysis", utc: "13:00", does: "Slutpriser, scoring, sold reconciliation" },
];

function buildScrapeHealth({ activeListings = [], soldListings = [], now = new Date() } = {}) {
  const activeLastSeen = latestDate(activeListings.map((l) => l.lastSeenAt));
  const activeScrapeDate = latestDate(activeListings.map((l) => l.scrapeDate));
  const activeLatest = activeLastSeen || activeScrapeDate;
  const soldLatest = latestDate(soldListings.map((l) => l.scrapedAt || l.soldDate));
  const activeDays = daysBetween(now, activeLatest);
  const soldDays = daysBetween(now, soldLatest);
  // Has any of today's scheduled scrape run yet? (Calendar day, UTC.)
  const ranToday = formatDateOnly(activeScrapeDate) != null && formatDateOnly(activeScrapeDate) === formatDateOnly(now);

  return {
    schedule: DAILY_SCRAPES,
    active: {
      total: activeListings.length,
      lastSeenAt: activeLastSeen ? activeLastSeen.toISOString() : null,
      lastScrapeDate: formatDateOnly(activeScrapeDate),
      daysSinceLastScrape: activeDays,
      ranToday,
      isStale: activeDays == null || activeDays > 2,
    },
    soldMarketData: {
      total: soldListings.length,
      lastUpdatedAt: soldLatest ? soldLatest.toISOString() : null,
      daysSinceLastUpdate: soldDays,
      isStale: soldDays == null || soldDays > 7,
    },
  };
}

module.exports = { buildScrapeHealth, parseDate, DAILY_SCRAPES };
