const test = require("node:test");
const assert = require("node:assert/strict");

const { buildScrapeHealth, DAILY_SCRAPES } = require("../api/scrape-health");

test("scrape health reports stale active listings from scrape dates", () => {
  const now = new Date("2026-05-21T12:00:00Z");
  const health = buildScrapeHealth({
    activeListings: [
      { scrapeDate: "2026-04-17", lastSeenAt: null },
      { scrapeDate: "2026-04-12", lastSeenAt: null },
    ],
    soldListings: [],
    now,
  });

  assert.equal(health.active.total, 2);
  assert.equal(health.active.lastScrapeDate, "2026-04-17");
  assert.equal(health.active.daysSinceLastScrape, 34);
  assert.equal(health.active.isStale, true);
});

test("scrape health exposes the 24h scrape schedule and whether a run happened today", () => {
  // No scrape yet today: latest scrapeDate is yesterday relative to `now`.
  const notYet = buildScrapeHealth({
    activeListings: [{ scrapeDate: "2026-06-23", lastSeenAt: null }],
    soldListings: [],
    now: new Date("2026-06-24T09:00:00Z"),
  });
  assert.equal(notYet.active.ranToday, false);
  // One automated refresh now (the Render cron worker), not the old 3-batch run.
  assert.ok(Array.isArray(notYet.schedule) && notYet.schedule.length >= 1);
  // Each schedule entry has a job label + a UTC HH:MM the frontend localises.
  for (const s of notYet.schedule) {
    assert.ok(s.job, "has a job label");
    assert.match(s.utc, /^\d{2}:\d{2}$/, "has a UTC HH:MM time");
  }
  // Once today's scrape lands, ranToday flips true.
  const ranToday = buildScrapeHealth({
    activeListings: [{ scrapeDate: "2026-06-24", lastSeenAt: null }],
    soldListings: [],
    now: new Date("2026-06-24T13:30:00Z"),
  });
  assert.equal(ranToday.active.ranToday, true);
  assert.deepEqual(ranToday.schedule, DAILY_SCRAPES);
});

test("homepage shows the scrape schedule, today-status, and wetroom re-checks", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const indexHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

  assert.match(indexHtml, /id="scrape-health"/);
  assert.match(indexHtml, /fetch\("\/api\/scrape-health"\)/);
  assert.match(indexHtml, /Last updated/i);
  assert.match(indexHtml, /Automatic refresh \(weekdays/i);
  assert.match(indexHtml, /No scrape has run yet today/i);
  assert.match(indexHtml, /Wetroom re-checks/i);
});

