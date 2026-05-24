const test = require("node:test");
const assert = require("node:assert/strict");

const { buildScrapeHealth } = require("../api/scrape-health");

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

test("homepage displays scrape health so stale listing data is visible", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const indexHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

  assert.match(indexHtml, /id="scrape-health"/);
  assert.match(indexHtml, /fetch\("\/api\/scrape-health"\)/);
  assert.match(indexHtml, /Last updated/i);
});

test("refresh workflow calls active scrape, sold scrape, and sold reconciliation with a secret token", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "refresh-fliphaus.yml"), "utf8");

  assert.match(workflow, /api\/scrape/);
  assert.match(workflow, /api\/scrape-sold/);
  assert.match(workflow, /api\/reconcile-sold/);
  assert.match(workflow, /x-refresh-token/);
  assert.match(workflow, /--fail-with-body/);
});
