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
  let running = false;

  const runJob = async () => {
    // Guard against overlap: a scrape+analyse can run long, and we never want two
    // in flight competing for the browser/proxy.
    if (running) {
      log("⏰ Previous scheduled run still going; skipping this tick.");
      return;
    }
    running = true;
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
    } finally {
      running = false;
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

module.exports = { startScheduler, msUntilNextRun };
