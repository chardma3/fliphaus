#!/usr/bin/env node
/**
 * Backfill active listings through the current analysis pipeline (cheap Haiku
 * triage gate -> Sonnet score), hydrating + persisting each listing's full
 * detail-page gallery. Loops in batches until a batch analyses nothing new.
 *
 * Uses the onlyMissing re-pick (requireFullGallery), so it targets listings
 * still on the ~5 search-card thumbnail gallery and is safe to stop/resume:
 * each analysed listing gets analyzedAt + its full gallery persisted and drops
 * out of the query. No HTTP, so no REFRESH_TOKEN / Cloudflare timeout involved.
 *
 * Needs MONGO_URI + ANTHROPIC_API_KEY + HEMNET_PROXY_* (all set on Render).
 *
 *   node scripts/backfill-active.js [batchLimit]   # default 25
 */
const mongoose = require("mongoose");
const { analyzeListingImagesRefresh } = require("../api/analyze-refresh");

(async () => {
  const limit = Number(process.argv[2]) || 25;
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  let total = 0;
  let batch = 0;
  let r;
  do {
    r = await analyzeListingImagesRefresh({ dataset: "active", limit });
    total += r.active.analyzed;
    batch += 1;
    console.log(`batch ${batch}: ${JSON.stringify(r.active)}  (cumulative analysed ${total})`);
  } while (r.active.analyzed > 0);

  console.log(`DONE — ${total} listing(s) analysed across ${batch} batch(es).`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
