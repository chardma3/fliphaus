#!/usr/bin/env node
/**
 * Standalone daily scrape — meant to run on a SEPARATE Render instance (a Cron Job
 * or Background Worker), NOT the web service.
 *
 * WHY: the web service is a single instance that both serves the app AND (today)
 * runs the Puppeteer scrape when GitHub Actions hits /api/scrape*. A scrape hogs
 * that one box's CPU/event loop, so logins and pages hang while it runs ("pinning
 * the box"). Running the scrape here — on its own instance, talking to the SAME
 * MongoDB — keeps scraping and the app fully independent: the app stays responsive
 * no matter how long a scrape takes.
 *
 * It calls the scrape functions DIRECTLY (no HTTP), so none of the per-request
 * Cloudflare/Render timeouts apply and the active scrape can run all areas in one
 * pass instead of the 3 staggered batches the web path needed. Each stage records
 * a scrapeRun row in the shared DB, so the web app's /api/scrape-health still shows
 * exactly what ran.
 *
 * Sequence (mirrors the old GitHub workflows, in order):
 *   1. Active listings — all areas (+ disappearance reconciliation)
 *   2. Sold prices (slutpriser) — all areas (+ sold reconciliation, built in)
 *   3. Photo analysis & scoring (new active + sold)
 *   4. Gallery self-heal (active) — bounded rounds; replaces the web-box coverage sweep
 *   5. Precompute resale estimates
 *
 * Each stage is isolated: a failure logs + records "failed" but never aborts the
 * later stages. Needs MONGO_URI + ANTHROPIC_API_KEY + HEMNET_PROXY_* (the same
 * env the web service uses — copy them onto the Cron Job / Worker).
 *
 *   node scripts/scheduled-scrape.js            # full daily run (default)
 *   node scripts/scheduled-scrape.js active     # just the active-listing scrape
 *   node scripts/scheduled-scrape.js sold        # just sold + analyse + precompute
 */
const mongoose = require("mongoose");
const scrape = require("../api/scrape");
const scrapeSold = require("../api/scrape-sold");
const { analyzeListingImagesRefresh } = require("../api/analyze-refresh");
const { precomputeEstimates } = require("../api/precompute-estimates");
const Listing = require("../api/listing.model");
const SoldListing = require("../models/sold.model");
const { recordScrapeRun } = require("../api/scrape-run.model");

// Run fn(), recording a scrapeRun row either way; never throws so the next stage
// still runs. Returns true on success.
async function stage(job, label, fn) {
  const startedAt = new Date();
  try {
    console.log(`\n▶ ${label}…`);
    const result = await fn();
    await recordScrapeRun({ job, label, status: result && result.partial ? "partial" : "success", startedAt, result });
    console.log(`✓ ${label}: ${JSON.stringify(result).slice(0, 200)}`);
    return true;
  } catch (err) {
    console.error(`✗ ${label} failed:`, err.message);
    await recordScrapeRun({ job, label, status: "failed", startedAt, error: err.message });
    return false;
  }
}

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set — cannot run the scheduled scrape.");
    process.exit(1);
  }
  const mode = (process.argv[2] || "all").toLowerCase();
  const doActive = mode === "all" || mode === "active";
  const doSold = mode === "all" || mode === "sold";

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`⏰ Scheduled scrape starting (mode: ${mode}) at ${new Date().toISOString()}`);

  if (doActive) {
    // All areas in one pass — no batch/timeout constraints off the web box.
    await stage("active-scrape", "Active listings — all areas", () => scrape({ includeDetails: false }));
  }

  if (doSold) {
    // scrapeSold reconciles disappeared→sold at the end of its own run.
    await stage("sold-scrape", "Sold prices — all areas", () =>
      scrapeSold({ detailLimit: 5, includeDetails: false, includeAnalysis: false }));
    // Score freshly-scraped listings (active + sold), one pass.
    const analyzeLimit = Number(process.env.SCRAPE_ANALYZE_LIMIT) || 10;
    await stage("image-analysis", "Photo analysis & scoring", () =>
      analyzeListingImagesRefresh({ dataset: "all", limit: analyzeLimit }));

    // Drain the ACTIVE self-heal tail — re-hydrate galleries that got bot-blocked
    // so those listings score properly. This REPLACES the hourly coverage sweep
    // that used to run on the web box (turn ENABLE_COVERAGE_SWEEP off there once
    // this is live, so the web box runs no Chrome at all). Bounded by rounds so
    // cost stays predictable; each round stops early when nothing's left. Tune with
    // SCRAPE_SELFHEAL_ROUNDS (× SCRAPE_ANALYZE_LIMIT listings/day).
    const selfHealRounds = Number(process.env.SCRAPE_SELFHEAL_ROUNDS) || 4;
    await stage("self-heal", "Gallery self-heal (active)", async () => {
      let analyzed = 0;
      let rounds = 0;
      for (let i = 0; i < selfHealRounds; i++) {
        const r = await analyzeListingImagesRefresh({ dataset: "active", limit: analyzeLimit });
        rounds += 1;
        analyzed += r.active?.analyzed || 0;
        if ((r.active?.analyzed || 0) === 0) break; // tail drained for now
      }
      return { rounds, analyzed };
    });
    // Rebuild stored resale estimates from the fresh comps.
    await stage("precompute-estimates", "Precompute resale estimates", () =>
      precomputeEstimates({ Listing, SoldListing }));
  }

  console.log(`\n✅ Scheduled scrape finished at ${new Date().toISOString()}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error("Fatal scheduled-scrape error:", err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
