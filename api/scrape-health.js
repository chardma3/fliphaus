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

// The single automated refresh, for the dashboard health panel. It runs on the
// standalone Render Cron Job (render.yaml `schedule` → scripts/scheduled-scrape.js),
// NOT in-process and NOT GitHub Actions (both retired). One run does the whole
// sequence — active scrape, sold prices, scoring, gallery self-heal, precompute.
// The time is UTC (Render cron's timezone) — KEEP IN SYNC with render.yaml's
// `schedule`. The frontend renders it in Stockholm local time so DST is handled there.
const DAILY_SCRAPES = [
  { job: "Daily refresh (weekdays)", utc: "11:00", does: "New & changed listings, sold prices, scoring, resale estimates" },
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
