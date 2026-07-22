// A process-wide mutex for the heavy Puppeteer/proxy jobs (active scrape, image
// analysis / self-heal, the fast coverage sweep). The Render web service is a
// SINGLE always-on instance, so an in-memory flag is enough — and it's the only
// thing that can coordinate the in-process scheduler with any manual HTTP
// /api/scrape and /api/analyze-images requests. Two of these jobs running at once
// would put two headless Chromium sessions on the same small instance and OOM it
// (the 2 GB incident), so only one holds the lock at a time.
//
// Priority is by who YIELDS: the coverage sweep checks isBusy() and defers (it's
// frequent and cheap, so it can always wait); scrapes/analysis acquire the lock
// and a caller that can't get it should back off and retry.

let current = null; // name of the running job, or null when idle

function isBusy() {
  return current !== null;
}

function currentJob() {
  return current;
}

// Try to take the lock. Returns true on success, false if another job holds it.
function acquire(name) {
  if (current !== null) return false;
  current = name;
  return true;
}

// Release the lock. No-op unless `name` currently holds it, so a late release
// can't clobber a different job that has since acquired it.
function release(name) {
  if (current === name) current = null;
}

// Run fn() while holding the lock. If the lock is held, returns
// { skipped: true, busyWith } WITHOUT running fn. Always releases on completion
// or error.
async function withLock(name, fn) {
  if (!acquire(name)) return { skipped: true, busyWith: current };
  try {
    return await fn();
  } finally {
    release(name);
  }
}

// Test-only: force the lock back to idle.
function _reset() {
  current = null;
}

module.exports = { isBusy, currentJob, acquire, release, withLock, _reset };
