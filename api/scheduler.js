// Dependency-free nightly scheduler for the always-on Render web service. Once a
// day it runs the scrape (new listings, disappearance reconciliation) then the
// image-analysis refresh — which scores new listings AND runs self-heal, so the
// bot-block tail re-hydrates over successive nights with no external cron, no
// dashboard config and no laptop. See [[fix-dont-count-botblocks]] for why
// self-heal now retries blocked listings indefinitely.
//
// Config (Render env):
//   ENABLE_SCHEDULER=true     turn it on (OFF by default so it never fires in
//                             local dev/tests, and so it runs on ONE instance only
//                             — enable on a single instance if you ever scale out)
//   SCHEDULE_HOUR=3           hour of day to run, in the server's TZ (default 3)
//   SCHEDULE_SCRAPE_DETAILS   "false" to skip detail-page fetches in the scheduled
//                             scrape (analysis re-hydrates galleries itself anyway)
//   TZ=Europe/Stockholm       interpret SCHEDULE_HOUR in this zone

const { DEAL_MIN_SCORE } = require("./listings-query");
const lock = require("./job-lock");

const DEFAULT_HOUR = 3;

function isFlagOn(value) {
  return value === "true" || value === "1";
}

// ms from `now` until the next occurrence of hour:00 in the server's local time.
// Recomputed after each run, so DST shifts are absorbed automatically.
function msUntilNextRun(now, hour) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

function isEnabled(env) {
  return env.ENABLE_SCHEDULER === "true" || env.ENABLE_SCHEDULER === "1";
}

function startScheduler({ scrape, analyze, env = process.env, log = console.log } = {}) {
  if (!isEnabled(env)) {
    log("⏰ Scheduler disabled (set ENABLE_SCHEDULER=true to enable).");
    return null;
  }

  const hour = Number.isFinite(Number(env.SCHEDULE_HOUR)) ? Number(env.SCHEDULE_HOUR) : DEFAULT_HOUR;
  const includeDetails = env.SCHEDULE_SCRAPE_DETAILS !== "false";
  // One-shot prompt rollout: set REANALYZE_DEALS_ONCE=true and the next nightly
  // run re-scores active DEALS that were analysed before the server started (i.e.
  // before this deploy / the new prompts). The cutoff is the start time, so once
  // a deal is re-scored its fresh analyzedAt is past the cutoff and it drops out —
  // no repeat, no future-date footgun. Safe to leave set (it re-runs once per
  // deploy); remove it when you're done rolling out.
  const reanalyzeBefore = isFlagOn(env.REANALYZE_DEALS_ONCE) ? new Date() : null;

  const runJob = async () => {
    // Guard against overlap via the shared job lock: a scrape+analyse runs long, and
    // we never want two heavy Puppeteer jobs (incl. the fast coverage sweep or an
    // HTTP scrape) competing for the browser/proxy on the single instance.
    const outcome = await lock.withLock("scheduled-run", async () => {
      log(`⏰ Scheduled run starting (${new Date().toISOString()})`);
      try {
        await scrape({ includeDetails });
        const analyzeOpts = { dataset: "active" };
        if (reanalyzeBefore) {
          // Re-score deals analysed before the cutoff alongside the usual new-listing
          // + self-heal pass. A wider limit drains the (small) deals set in one run;
          // gallery hydration recycles its tab so the extra volume stays memory-safe.
          analyzeOpts.reanalyzeBefore = reanalyzeBefore;
          analyzeOpts.reanalyzeMinScore = DEAL_MIN_SCORE;
          analyzeOpts.limit = 25;
          log(`⏰ Re-scoring deals analysed before ${reanalyzeBefore.toISOString()} (score >= ${DEAL_MIN_SCORE})`);
        }
        const result = await analyze(analyzeOpts);
        log(`⏰ Scheduled run complete: ${JSON.stringify(result.active || result)}`);
      } catch (err) {
        console.error(`⏰ Scheduled run failed: ${err.message}`);
      }
    });
    if (outcome && outcome.skipped) {
      log(`⏰ Scheduled run skipped — "${outcome.busyWith}" still running.`);
    }
  };

  const scheduleNext = () => {
    const delay = msUntilNextRun(new Date(), hour);
    log(`⏰ Next scheduled run in ${(delay / 3600000).toFixed(1)}h (daily at ${hour}:00 ${env.TZ || "server time"}).`);
    const timer = setTimeout(async () => {
      await runJob();
      scheduleNext();
    }, delay);
    // Don't let the pending timer hold the process open on its own; the web
    // server keeps the event loop alive.
    if (typeof timer.unref === "function") timer.unref();
  };

  scheduleNext();
  return { runJob };
}

// One pass of the fast coverage self-heal sweep. Re-analyses listings still
// missing a DISPLAYED wet room (kitchen or bathroom) so a deal scored blind to
// the bathroom is corrected within minutes, not the next nightly run. If a
// scrape/analysis is already running it DEFERS — the caller's interval retries on
// the next tick, i.e. it reschedules itself rather than colliding with the scan.
async function runCoverageSweepOnce({ analyze, log = console.log, limit = 8 } = {}) {
  if (lock.isBusy()) {
    log(`⏰ Coverage sweep deferred — "${lock.currentJob()}" is running; retrying next tick.`);
    return { deferred: true, busyWith: lock.currentJob() };
  }
  return lock.withLock("coverage-sweep", async () => {
    try {
      const result = await analyze({ dataset: "active", coverageOnly: true, limit });
      const a = (result && result.active) || {};
      if (a.candidates) {
        log(`⏰ Coverage sweep: ${a.analyzed}/${a.candidates} re-analysed, ${a.skipped} skipped.`);
      }
      return { deferred: false, ...a };
    } catch (err) {
      console.error(`⏰ Coverage sweep failed: ${err.message}`);
      return { deferred: false, error: err.message };
    }
  });
}

// Fast coverage self-heal loop. Every COVERAGE_SWEEP_MINUTES (default 5) it runs
// one pass; while a scan is running it defers and the next tick retries (so a
// collision just pushes the work ~5 min later, automatically).
//
// Gated on its OWN flag, ENABLE_COVERAGE_SWEEP — NOT ENABLE_SCHEDULER. The heavy
// nightly scheduler is deliberately off here (scraping + nightly analysis run in
// GitHub Actions, so running it in-process too would double-scrape). But this
// sweep is lightweight (no scrape, just coverage re-hydration) and defers to any
// GitHub-Actions scrape via the shared job lock, so it's safe to run on the
// always-on web service even with ENABLE_SCHEDULER off. Default off so it never
// fires in local dev/tests; single-instance only (set on ONE instance if scaled).
function startCoverageSweep({ analyze, env = process.env, log = console.log } = {}) {
  if (!isFlagOn(env.ENABLE_COVERAGE_SWEEP)) return null;
  const minutes = Number(env.COVERAGE_SWEEP_MINUTES) > 0 ? Number(env.COVERAGE_SWEEP_MINUTES) : 5;
  const limit = Number(env.COVERAGE_SWEEP_LIMIT) > 0 ? Number(env.COVERAGE_SWEEP_LIMIT) : 8;
  const intervalMs = minutes * 60 * 1000;
  log(`⏰ Coverage self-heal sweep every ${minutes}m (limit ${limit}); defers while a scan runs.`);

  const tick = async () => {
    await runCoverageSweepOnce({ analyze, log, limit });
    const next = setTimeout(tick, intervalMs);
    if (typeof next.unref === "function") next.unref();
  };
  const first = setTimeout(tick, intervalMs);
  if (typeof first.unref === "function") first.unref();
  return { runOnce: () => runCoverageSweepOnce({ analyze, log, limit }) };
}

module.exports = { startScheduler, startCoverageSweep, runCoverageSweepOnce, msUntilNextRun };
