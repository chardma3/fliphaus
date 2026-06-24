const test = require("node:test");
const assert = require("node:assert/strict");

const { startScheduler, msUntilNextRun } = require("../api/scheduler");

test("msUntilNextRun targets today's hour when it's still ahead", () => {
  const now = new Date("2026-06-17T01:30:00");
  // 03:00 today is 1.5h away.
  assert.equal(msUntilNextRun(now, 3), 1.5 * 3600 * 1000);
});

test("msUntilNextRun rolls to tomorrow once the hour has passed", () => {
  const now = new Date("2026-06-17T05:00:00");
  // 03:00 already passed -> 03:00 tomorrow is 22h away.
  assert.equal(msUntilNextRun(now, 3), 22 * 3600 * 1000);
});

test("msUntilNextRun rolls over correctly at exactly the target hour", () => {
  const now = new Date("2026-06-17T03:00:00");
  // Equal counts as passed -> next is 24h out, never a 0ms busy-loop.
  assert.equal(msUntilNextRun(now, 3), 24 * 3600 * 1000);
});

test("scheduler is off unless ENABLE_SCHEDULER is set", () => {
  let scraped = false;
  const handle = startScheduler({
    scrape: async () => { scraped = true; },
    analyze: async () => ({}),
    env: {},
    log: () => {},
  });
  assert.equal(handle, null);
  assert.equal(scraped, false);
});

test("runJob runs scrape then analyze, and won't overlap itself", async () => {
  const calls = [];
  let releaseScrape;
  const handle = startScheduler({
    scrape: () => new Promise((res) => { calls.push("scrape"); releaseScrape = res; }),
    analyze: async () => { calls.push("analyze"); return { active: { analyzed: 1 } }; },
    env: { ENABLE_SCHEDULER: "true" },
    log: () => {},
  });
  assert.ok(handle, "enabled scheduler returns a handle");

  const first = handle.runJob();          // starts scrape, now in-flight
  await handle.runJob();                   // should skip: previous still running
  assert.deepEqual(calls, ["scrape"], "second call skipped while first in flight");

  releaseScrape();                         // let the first run finish
  await first;
  assert.deepEqual(calls, ["scrape", "analyze"], "analyze runs after scrape");
});

const { runCoverageSweepOnce } = require("../api/scheduler");
const lock = require("../api/job-lock");

test("coverage sweep defers (runs nothing) while a scan holds the lock", async () => {
  lock._reset();
  lock.acquire("http-scrape");
  let analyzeCalled = false;
  const out = await runCoverageSweepOnce({
    analyze: async () => { analyzeCalled = true; return { active: {} }; },
    log: () => {},
  });
  assert.equal(analyzeCalled, false, "did not run analysis while a scan was running");
  assert.equal(out.deferred, true);
  assert.equal(out.busyWith, "http-scrape");
  lock.release("http-scrape");
});

test("coverage sweep runs a coverageOnly active pass when idle, holding the lock", async () => {
  lock._reset();
  let opts = null;
  let heldDuringRun = false;
  const out = await runCoverageSweepOnce({
    analyze: async (o) => {
      opts = o;
      heldDuringRun = lock.currentJob() === "coverage-sweep";
      return { active: { candidates: 2, analyzed: 1, skipped: 1 } };
    },
    log: () => {},
    limit: 8,
  });
  assert.deepEqual(opts, { dataset: "active", coverageOnly: true, limit: 8 });
  assert.equal(heldDuringRun, true, "held the lock so scrapes defer to it");
  assert.equal(out.deferred, false);
  assert.equal(out.analyzed, 1);
  assert.equal(lock.isBusy(), false, "lock released after the pass");
});

test("coverage sweep survives an analysis error and releases the lock", async () => {
  lock._reset();
  const out = await runCoverageSweepOnce({
    analyze: async () => { throw new Error("hydration blew up"); },
    log: () => {},
  });
  assert.equal(out.deferred, false);
  assert.match(out.error, /hydration blew up/);
  assert.equal(lock.isBusy(), false);
});
