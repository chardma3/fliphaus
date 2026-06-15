#!/usr/bin/env node
/**
 * One-shot backfill for listings analysed before the display-set coverage fix.
 *
 * Background: kitchenPictured/bathroomPictured used to be written from the
 * model's view of the transient full gallery, not the ~6 photos we actually
 * persist. So a listing could read "covered" while its stored photos show no
 * bathroom — and because self-heal only re-picks listings whose flags are
 * FALSE, those stuck listings were never re-hydrated. This re-runs the current
 * pipeline (Haiku triage gate -> Sonnet score, hydrating the full gallery) on
 * every active listing analysed before a cutoff, regardless of its flags. The
 * fixed pipeline now derives coverage from the persisted set, so a listing that
 * genuinely lacks a wet-room photo ends up flagged false and self-heals on later
 * runs.
 *
 * Loops in batches until a batch analyses nothing new. Safe to stop/resume: each
 * analysed listing gets a fresh analyzedAt + curated gallery and drops out of
 * the query. No HTTP, so no REFRESH_TOKEN / Cloudflare timeout involved.
 *
 * Needs MONGO_URI + ANTHROPIC_API_KEY + HEMNET_PROXY_* (all set on Render).
 *
 *   node scripts/backfill-stale-coverage.js [cutoffISO] [batchLimit]
 *   # cutoffISO default 2026-06-13 (the day the fix shipped); batchLimit default 25
 */
const mongoose = require("mongoose");
const { analyzeListingImagesRefresh } = require("../api/analyze-refresh");

(async () => {
  const cutoffArg = process.argv[2] || "2026-06-13T00:00:00.000Z";
  const limit = Number(process.argv[3]) || 25;
  const reanalyzeBefore = new Date(cutoffArg);
  if (Number.isNaN(reanalyzeBefore.getTime())) {
    console.error(`Invalid cutoff date: ${cutoffArg}`);
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Re-analysing active listings analysed before ${reanalyzeBefore.toISOString()} (batch ${limit})`);

  let total = 0;
  let batch = 0;
  let r;
  do {
    r = await analyzeListingImagesRefresh({ dataset: "active", limit, reanalyzeBefore });
    total += r.active.analyzed;
    batch += 1;
    console.log(`batch ${batch}: ${JSON.stringify(r.active)}  (cumulative analysed ${total})`);
  } while (r.active.analyzed > 0);

  console.log(`DONE — ${total} listing(s) re-analysed across ${batch} batch(es).`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
