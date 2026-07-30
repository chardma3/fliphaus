// One Booli for-sale run: browser → harvest → dedup-aware ingest → summary.
// The listings counterpart to api/booli-sold-run.js, sharing its shape so both can
// run either from a shell or (preferably) as a stage of the scheduled cron — the
// interactive shell drops long connections, so a recorded result beats a printed one.
const { BOOLI_AREA_IDS } = require("./booli");
const { collectBooliListings } = require("./booli-listings");
const { openBooliSession, fetchNextDataWith, resolveAreaId, installResourceBlocking } = require("./booli-transport");
const { ingestBooliListings } = require("./booli-listing-ingest");

async function runBooliListingsIngest({
  Listing,
  launchBrowser,
  authenticatePage = async () => {},
  area = "Årsta",
  municipality = "Stockholm",
  maxPages = 5,
  commit = false,
  log = console,
} = {}) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await authenticatePage(page);
    if (page.setViewport) await page.setViewport({ width: 1280, height: 800 });
    // Photos are fetched later, by the analysis pipeline, from the constructed CDN
    // URLs — the harvest itself only needs HTML.
    await installResourceBlocking(page);

    await openBooliSession(page);

    // An unresolved area is FATAL, never "no data": Booli silently serves areaId
    // 77104 = "Sverige" for anything it can't resolve, which would put listings
    // from the whole country on the dashboard.
    const resolved = await resolveAreaId(page, area, { municipality });
    const areaId = resolved ? resolved.areaId : BOOLI_AREA_IDS[area] || null;
    if (!areaId) {
      const err = new Error(`Could not resolve a Booli areaId for "${area}" — refusing to harvest.`);
      err.code = "BOOLI_AREA_UNRESOLVED";
      throw err;
    }
    log.log(`Area: ${area} → Booli areaId ${areaId}`);

    const harvest = await collectBooliListings({
      fetchNextData: fetchNextDataWith(page),
      areaId,
      area,
      maxPages,
    });
    log.log(
      `Harvested ${harvest.listings.length} for-sale listings (${harvest.upcoming} pre-market, ${harvest.priced} priced; Booli holds ${harvest.totalCount} for this area).`
    );

    const offArea = harvest.listings.filter(
      (l) => l.locationDescription && !String(l.locationDescription).toLowerCase().includes(String(area).toLowerCase())
    ).length;

    const summary = await ingestBooliListings({ records: harvest.listings, Listing, dryRun: !commit });

    return {
      area,
      areaId,
      commit,
      maxPages,
      booliTotalForArea: harvest.totalCount,
      harvested: harvest.listings.length,
      upcoming: harvest.upcoming,
      priced: harvest.priced,
      offArea,
      ...summary,
    };
  } finally {
    await browser.close();
  }
}

module.exports = { runBooliListingsIngest };
