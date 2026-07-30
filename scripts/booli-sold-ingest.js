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
 * The summary is ALSO written to the ScrapeRun log, so it survives a dropped shell
 * connection and shows up on /api/scrape-health — Render's interactive shell
 * disconnects on long jobs, and a run you can't watch is useless unless its result
 * is recorded somewhere. To avoid the shell entirely, set BOOLI_SOLD_INGEST=dry
 * (or =commit) on the cron service and use Trigger Run: scripts/scheduled-scrape.js
 * runs the same code as a managed stage.
 *
 * PREREQUISITE: scripts/migrate-sold-sources.js --commit (fingerprintKey backfill).
 * Needs MONGO_URI. A residential IP clears Booli's Cloudflare with no proxy; on
 * Render it uses HEMNET_PROXY_* like the scrape cron.
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
const { runBooliSoldIngest } = require("../api/booli-sold-run");
const { recordScrapeRun } = require("../api/scrape-run.model");

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
  const startedAt = new Date();
  const label = `Booli sold comps — ${AREA}${COMMIT ? "" : " (dry run)"}`;

  try {
    const summary = await runBooliSoldIngest({
      SoldListing,
      launchBrowser: () => puppeteer.launch(buildPuppeteerLaunchOptions()),
      authenticatePage: authenticateProxyPage,
      area: AREA,
      maxPages: MAX_PAGES,
      commit: COMMIT,
    });

    console.log("\n── INGEST ──");
    console.log(`   considered: ${summary.considered}`);
    console.log(`   ${COMMIT ? "inserted" : "would insert"}: ${summary.inserted}`);
    console.log(`   ${COMMIT ? "merged" : "would merge"} into an existing Hemnet sale: ${summary.merged}`);
    console.log(`   already complete (no change): ${summary.unchanged}`);
    console.log(`   skipped (missing price/size/date/address): ${summary.skipped}`);
    console.log(`\n   samples: ${JSON.stringify(summary.samples, null, 2)}`);
    if (summary.dedupSuspect) {
      console.warn(
        "\n⚠ Zero merges. In an area we already scrape, expect meaningful overlap — " +
          "verify the fingerprint backfill ran and that addresses/sizes line up before committing."
      );
    }
    console.log(COMMIT ? "\n✅ Written." : "\nNo changes written. Re-run with --commit to apply.");

    // Durable copy: readable from /api/scrape-health even if this shell died.
    await recordScrapeRun({
      job: "booli-sold",
      label,
      status: summary.dedupSuspect ? "partial" : "success",
      startedAt,
      result: summary,
    });
  } catch (err) {
    console.error(`Failed${err.code ? ` [${err.code}]` : ""}: ${err.message}`);
    await recordScrapeRun({ job: "booli-sold", label, status: "failed", startedAt, error: err.message });
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
