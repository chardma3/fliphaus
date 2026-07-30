#!/usr/bin/env node
/**
 * Harvest Booli sold comps for one area and merge them into the sold store,
 * deduping against Hemnet's sales via api/sold-ingest.js.
 *
 * DRY RUN BY DEFAULT. The sold collection is what every resale estimate (and
 * therefore every profit badge) is computed from, so this reports what it would
 * insert/merge and writes nothing until you pass --commit.
 *
 *   node scripts/booli-sold-ingest.js                        # Årsta, dry run
 *   node scripts/booli-sold-ingest.js --area Årsta --pages 5
 *   node scripts/booli-sold-ingest.js --commit               # actually write
 *
 * PREREQUISITE: run scripts/migrate-sold-sources.js --commit first. Without its
 * fingerprintKey backfill, dedup is blind and every Booli record inserts as new.
 *
 * Needs MONGO_URI. A residential IP clears Booli's Cloudflare with no proxy;
 * on Render it uses HEMNET_PROXY_* like the scrape cron.
 */
const mongoose = require("mongoose");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const SoldListing = require("../models/sold.model");
const {
  buildPuppeteerLaunchOptions,
  authenticateProxyPage,
  logProxyStatus,
} = require("../api/puppeteer-options");
const { BOOLI_AREA_IDS, collectBooliSold } = require("../api/booli");
const { openBooliSession, fetchNextDataWith, resolveAreaId, installResourceBlocking } = require("../api/booli-transport");
const { ingestBooliSold } = require("../api/sold-ingest");

puppeteer.use(StealthPlugin());

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const COMMIT = process.argv.includes("--commit");
const AREA = arg("--area", "Årsta");
const MAX_PAGES = Number(arg("--pages", 5));

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }
  logProxyStatus();
  console.log(COMMIT ? "MODE: --commit (writing)" : "MODE: dry run (no writes) — pass --commit to apply");

  await mongoose.connect(process.env.MONGO_URI);

  // Refuse to run before the migration: without fingerprintKey, dedup silently
  // fails open and duplicates every sale we already hold.
  const total = await SoldListing.countDocuments({});
  const keyed = await SoldListing.countDocuments({ fingerprintKey: { $ne: null } });
  console.log(`\nSold store: ${total} records, ${keyed} fingerprinted.`);
  if (total > 0 && keyed === 0) {
    console.error(
      "✗ No sold record has a fingerprintKey — dedup would be blind and duplicate everything.\n" +
        "  Run: node scripts/migrate-sold-sources.js --commit"
    );
    await mongoose.disconnect();
    process.exit(2);
  }

  const browser = await puppeteer.launch(buildPuppeteerLaunchOptions());
  const page = await browser.newPage();
  await authenticateProxyPage(page);
  await page.setViewport({ width: 1280, height: 800 });
  // Skip images/media/fonts/CSS: we only read the embedded JSON, and those bytes
  // are both the slowest part over the proxy and the expensive part (metered by GB).
  await installResourceBlocking(page);

  try {
    await openBooliSession(page);
    let areaId = BOOLI_AREA_IDS[AREA] || null;
    const resolved = await resolveAreaId(page, AREA, { municipality: "Stockholm" });
    if (resolved) areaId = resolved.areaId;
    if (!areaId) {
      // Never fall through: an unresolved area means Booli serves "Sverige"
      // (areaId 77104) and we'd pollute the comp set with the whole country.
      console.error(`✗ Could not resolve a Booli areaId for "${AREA}" — refusing to harvest.`);
      process.exit(3);
    }
    console.log(`Area: ${AREA} → Booli areaId ${areaId}`);

    const { sold, totalCount } = await collectBooliSold({
      fetchNextData: fetchNextDataWith(page),
      areaId,
      area: AREA,
      maxPages: MAX_PAGES,
    });
    console.log(`Harvested ${sold.length} sold apartments (Booli holds ${totalCount} for this area).`);

    const offArea = sold.filter((s) => s.municipality && s.municipality !== "Stockholm");
    if (offArea.length) {
      console.warn(`⚠ ${offArea.length} record(s) outside Stockholm kommun — check the areaId before committing.`);
    }

    const summary = await ingestBooliSold({ records: sold, SoldListing, dryRun: !COMMIT });
    console.log("\n── INGEST ──");
    console.log(`   considered: ${summary.considered}`);
    console.log(`   would insert: ${summary.inserted}`);
    console.log(`   would merge into an existing Hemnet sale: ${summary.merged}`);
    console.log(`   already complete (no change): ${summary.unchanged}`);
    console.log(`   skipped (missing price/size/date/address): ${summary.skipped}`);
    console.log(`\n   samples: ${JSON.stringify(summary.samples, null, 2)}`);

    // The merge count is the headline number: it's the overlap between Booli and
    // Hemnet, i.e. evidence the dedup is working. Near-zero overlap in an area we
    // already scrape usually means matching is failing, not that Booli is unique.
    if (summary.merged === 0 && total > 0) {
      console.warn(
        "\n⚠ Zero merges. In an area we already scrape, expect meaningful overlap — " +
          "verify the fingerprint backfill ran and that addresses/sizes line up before committing."
      );
    }
    console.log(COMMIT ? "\n✅ Written." : "\nNo changes written. Re-run with --commit to apply.");
  } catch (err) {
    console.error(`Failed${err.code ? ` [${err.code}]` : ""}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
    await mongoose.disconnect();
  }
})();
