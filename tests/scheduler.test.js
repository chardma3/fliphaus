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
