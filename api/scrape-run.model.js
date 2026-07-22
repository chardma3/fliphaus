const mongoose = require("mongoose");

// A log of every scrape/analysis run the server actually performed — one document
// per run, whatever triggered it (the Render cron worker scripts/scheduled-scrape.js,
// the in-process scheduler, or a manual curl on /api/scrape*). This is the source
// of truth for "which scrapes have actually run", as opposed to the static
// DAILY_SCRAPES schedule (api/scrape-health.js) which only lists what is MEANT to
// run. The dashboard health panel renders the most recent of these.
const scrapeRunSchema = new mongoose.Schema({
  // Machine kind: "active-scrape" | "sold-scrape" | "image-analysis".
  job: String,
  // Human-readable label shown in the dashboard (e.g. "Active listings — batch 2 of 3").
  label: String,
  // success = ran clean; partial = some areas failed but others succeeded; failed = threw.
  status: { type: String, enum: ["success", "partial", "failed"], default: "success" },
  startedAt: Date,
  finishedAt: Date,
  durationMs: Number,
  // The endpoint's result object (counts, scraped/failed areas, etc.) or null on failure.
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  // Error message when status === "failed".
  error: { type: String, default: null },
});

// One index does double duty: a TTL that expires runs older than 180 days, and
// the sort key for getRecentScrapeRuns (the limit-20 read scans it descending, so
// no in-memory sort). At ~4 scheduled runs a day the collection stays tiny while
// preserving a long visible history — no separate per-field indexes needed.
scrapeRunSchema.index({ startedAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

const ScrapeRun = mongoose.model("ScrapeRun", scrapeRunSchema);

// Best-effort: log a completed run. NEVER throws — a logging failure must not break
// the scrape itself, so DB errors are swallowed (the run still happened).
async function recordScrapeRun(entry) {
  try {
    const startedAt = entry.startedAt || new Date();
    const finishedAt = entry.finishedAt || new Date();
    await ScrapeRun.create({
      job: entry.job,
      label: entry.label,
      status: entry.status || "success",
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      result: entry.result ?? null,
      error: entry.error ?? null,
    });
  } catch (err) {
    console.error("⚠️  Failed to record scrape run:", err.message);
  }
}

// The most recent runs, newest first, for the dashboard health panel.
async function getRecentScrapeRuns(limit = 20) {
  try {
    return await ScrapeRun.find({}).sort({ startedAt: -1 }).limit(limit).lean();
  } catch (err) {
    console.error("⚠️  Failed to load scrape runs:", err.message);
    return [];
  }
}

module.exports = { ScrapeRun, recordScrapeRun, getRecentScrapeRuns };
