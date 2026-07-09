const test = require("node:test");
const assert = require("node:assert/strict");

const { sekToAud, getSekToAud, FALLBACK_SEK_AUD, __resetCache } = require("../api/fx");

test("sekToAud converts and rounds, guarding bad input", () => {
  assert.equal(sekToAud(1000000, 0.145), 145000);
  assert.equal(sekToAud("2000000", 0.145), 290000);
  assert.equal(sekToAud(1000, 0), null);
  assert.equal(sekToAud(null, 0.145), null);
  assert.equal(sekToAud(1000, "x"), null);
});

// Swap global.fetch for a stub around a single call.
async function withFetch(stub, fn) {
  const prev = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = prev; }
}

test("getSekToAud returns the live rate and caches it for a day", async () => {
  __resetCache();
  let calls = 0;
  const stub = async () => { calls++; return { ok: true, json: async () => ({ rates: { AUD: 0.15 } }) }; };
  await withFetch(stub, async () => {
    const first = await getSekToAud(1_000_000); // fixed "now"
    assert.equal(first.rate, 0.15);
    assert.equal(first.source, "live");
    // 12h later: still fresh, served from cache without a second fetch.
    const second = await getSekToAud(1_000_000 + 12 * 3600 * 1000);
    assert.equal(second.source, "cached");
    assert.equal(calls, 1);
    // 25h later: stale, re-fetches.
    await getSekToAud(1_000_000 + 25 * 3600 * 1000);
    assert.equal(calls, 2);
  });
});

test("getSekToAud falls back to the fixed rate when the fetch fails and no cache exists", async () => {
  __resetCache();
  const stub = async () => { throw new Error("network down"); };
  await withFetch(stub, async () => {
    const r = await getSekToAud(2_000_000);
    assert.equal(r.rate, FALLBACK_SEK_AUD);
    assert.equal(r.source, "fallback");
  });
});

test("getSekToAud serves a stale cached rate over the fixed fallback when a later fetch fails", async () => {
  __resetCache();
  const okStub = async () => ({ ok: true, json: async () => ({ rates: { AUD: 0.16 } }) });
  const failStub = async () => { throw new Error("down"); };
  await withFetch(okStub, async () => { await getSekToAud(0); });
  await withFetch(failStub, async () => {
    const r = await getSekToAud(2 * 24 * 3600 * 1000); // 2 days later, stale
    assert.equal(r.rate, 0.16); // kept the last good rate, not the fixed fallback
    assert.equal(r.source, "cached");
  });
});
