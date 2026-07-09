// SEK → AUD conversion for the friends dashboard. The friends view shows Swedish
// asking prices in Australian dollars for family back home, so it needs a roughly
// current rate — not a trading-grade one. We fetch once a day from a free, no-key
// FX API (Frankfurter, ECB reference rates), cache the result in-process, and fall
// back to a fixed rate if the fetch fails so the page never shows a broken figure.

// Fixed fallback (≈ mid-2025 level). Only used if every fetch fails AND we have no
// previously-cached rate. Update occasionally so a total-outage fallback isn't wild.
const FALLBACK_SEK_AUD = 0.145;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FX_URL = "https://api.frankfurter.app/latest?from=SEK&to=AUD";

// In-process cache. Survives across requests but resets on restart, at which point
// the first request re-fetches. { rate, asOf(ISO), source } or null until first load.
let cache = null;

// Pure conversion — kept separate from the fetch so it's trivially testable.
function sekToAud(sek, rate) {
  if (sek == null || sek === "") return null; // Number(null)===0 would silently convert to A$0
  const amount = Number(sek);
  const r = Number(rate);
  if (!Number.isFinite(amount) || !Number.isFinite(r) || r <= 0) return null;
  return Math.round(amount * r);
}

function isFresh(entry, now) {
  return entry && now - new Date(entry.asOf).getTime() < ONE_DAY_MS;
}

// Returns { rate, asOf, source } where source is "live" | "cached" | "fallback".
// Never throws — a failed fetch degrades to the last cached rate, then the fixed
// fallback. `now` is injectable for tests; defaults to the current time.
async function getSekToAud(now = Date.now()) {
  if (isFresh(cache, now)) return { ...cache, source: "cached" };

  try {
    const res = await fetch(FX_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.AUD;
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("no AUD rate in response");
    cache = { rate, asOf: new Date(now).toISOString(), source: "live" };
    return { ...cache };
  } catch (err) {
    console.error(`FX fetch failed (${err.message}); using ${cache ? "stale cache" : "fixed fallback"}`);
    if (cache) return { ...cache, source: "cached" };
    return { rate: FALLBACK_SEK_AUD, asOf: new Date(now).toISOString(), source: "fallback" };
  }
}

// Test-only: reset the module cache between cases.
function __resetCache() {
  cache = null;
}

module.exports = { getSekToAud, sekToAud, FALLBACK_SEK_AUD, __resetCache };
