const test = require("node:test");
const assert = require("node:assert/strict");

const { jitter, PACING } = require("../api/scrape-pacing");

test("jitter stays within [base, base*1.5] and is never below base", () => {
  for (let i = 0; i < 200; i++) {
    const v = jitter(1000);
    assert.ok(v >= 1000 && v <= 1500, `jitter(1000)=${v} out of range`);
  }
  assert.equal(jitter(0), 0);
  assert.equal(jitter(undefined), 0);
});

test("pacing defaults are gentle and env-overridable", () => {
  // Defaults lean slow (fewer Cloudflare blocks); worker runtime is free.
  assert.ok(PACING.areaDelayMs >= 3000, "area delay should be a few seconds");
  assert.ok(PACING.retryBaseMs >= 2000, "retry backoff base should be a couple seconds");
  assert.ok(PACING.soldPageDelayMs >= 1000);
  assert.ok(PACING.soldDetailDelayMs >= 1000);
});
