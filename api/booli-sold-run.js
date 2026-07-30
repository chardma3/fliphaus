// One Booli sold-comp run: browser → harvest → dedup-aware ingest → summary.
//
// Extracted from scripts/booli-sold-ingest.js so the SAME code can run either from
// a shell OR as a stage of the scheduled cron run. That second path is what makes
// this usable in practice: Render's interactive shell drops its connection on long
// jobs, so a run you can't watch has to be one whose result is recorded rather than
// printed. The cron path logs a ScrapeRun row, which the dashboard health endpoint
// then exposes — no terminal required.
//
// Models and the browser factory are injected so this stays testable.
const { BOOLI_AREA_IDS, collectBooliSold } = require("./booli");
const { openBooliSession, fetchNextDataWith, resolveAreaId, installResourceBlocking } = require("./booli-transport");
const { ingestBooliSold } = require("./sold-ingest");

// Dedup depends on stored fingerprintKeys. Without them every Booli record looks
// new and duplicates a sale we already hold, double-weighting it in the kr/m²
// percentile the resale estimates rest on — so this is a hard stop, not a warning.
async function assertMigrated(SoldListing) {
  const total = await SoldListing.countDocuments({});
  const keyed = await SoldListing.countDocuments({ fingerprintKey: { $ne: null } });
  if (total > 0 && keyed === 0) {
    const err = new Error(
      "No sold record has a fingerprintKey — dedup would be blind and duplicate everything. Run: node scripts/migrate-sold-sources.js --commit"
    );
    err.code = "BOOLI_NOT_MIGRATED";
    throw err;
  }
  return { total, keyed };
}

async function runBooliSoldIngest({
  SoldListing,
  launchBrowser,
  authenticatePage = async () => {},
  area = "Årsta",
  municipality = "Stockholm",
  maxPages = 5,
  commit = false,
  log = console,
} = {}) {
  const store = await assertMigrated(SoldListing);
  log.log(`Sold store: ${store.total} records, ${store.keyed} fingerprinted.`);

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await authenticatePage(page);
    if (page.setViewport) await page.setViewport({ width: 1280, height: 800 });
    // Images/media/fonts/CSS are the bulk of a Booli page, are never read, and are
    // billed by the gigabyte on the residential proxy.
    await installResourceBlocking(page);

    await openBooliSession(page);

    // An unresolved area is FATAL, never "no data": Booli silently serves areaId
    // 77104 = "Sverige" (2.9M sold rows) for anything it can't resolve.
    const resolved = await resolveAreaId(page, area, { municipality });
    const areaId = resolved ? resolved.areaId : BOOLI_AREA_IDS[area] || null;
    if (!areaId) {
      const err = new Error(`Could not resolve a Booli areaId for "${area}" — refusing to harvest.`);
      err.code = "BOOLI_AREA_UNRESOLVED";
      throw err;
    }
    log.log(`Area: ${area} → Booli areaId ${areaId}`);

    const { sold, totalCount } = await collectBooliSold({
      fetchNextData: fetchNextDataWith(page),
      areaId,
      area,
      maxPages,
    });
    log.log(`Harvested ${sold.length} sold apartments (Booli holds ${totalCount} for this area).`);

    const offArea = sold.filter((s) => s.municipality && s.municipality !== municipality).length;
    if (offArea) {
      log.warn(`⚠ ${offArea} record(s) outside ${municipality} kommun — check the areaId before committing.`);
    }

    const summary = await ingestBooliSold({ records: sold, SoldListing, dryRun: !commit });

    return {
      area,
      areaId,
      commit,
      maxPages,
      booliTotalForArea: totalCount,
      harvested: sold.length,
      offArea,
      storeBefore: store,
      ...summary,
      // The headline number: overlap with Hemnet is the evidence that dedup works.
      // Near-zero overlap in an area we already scrape means matching is failing,
      // not that Booli's inventory is unique.
      dedupSuspect: summary.merged === 0 && store.total > 0,
    };
  } finally {
    await browser.close();
  }
}

module.exports = { runBooliSoldIngest, assertMigrated };
