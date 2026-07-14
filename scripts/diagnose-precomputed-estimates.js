#!/usr/bin/env node
/**
 * Read-only diagnostic: are the resale estimates actually being PRECOMPUTED and
 * stored on each active listing (so the feed serves them without crunching), or
 * are listings missing a stored value / carrying a stale one?
 *
 * The feed reads `listing.brfIntelligence` (built by api/precompute-estimates.js,
 * run daily after the sold refresh and on reanalyse) and only falls back to a live
 * crunch when it's missing. This reports, globally and per area:
 *   - how many active listings have a stored estimate vs are missing one,
 *   - the OLDEST and NEWEST `brfIntelligenceAt` (so a stalled daily recompute is
 *     obvious — the oldest stamp should be from the last refresh, not days ago).
 *
 * No model calls, no scraping, no writes. Safe to run anywhere with MONGO_URI.
 *
 *   node scripts/diagnose-precomputed-estimates.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Listing = require("../api/listing.model");
const { canonicalArea } = require("../api/brf-intelligence");

function areaKey(value) {
  return canonicalArea(value) || "(unknown)";
}
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const ago = (d) => {
  if (!d) return "—";
  const h = (Date.now() - new Date(d).getTime()) / 3600000;
  return h < 48 ? `${h.toFixed(1)}h ago` : `${(h / 24).toFixed(1)}d ago`;
};

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const listings = await Listing.find(
    { status: "active" },
    { locationDescription: 1, area: 1, brfIntelligenceAt: 1, streetAddress: 1, id: 1 }
  ).lean();

  let stored = 0;
  let missing = 0;
  const stamps = [];
  const areas = {}; // key -> { total, stored, missing }
  const missingSamples = [];

  for (const l of listings) {
    const k = areaKey(l.locationDescription || l.area);
    const a = areas[k] || (areas[k] = { total: 0, stored: 0, missing: 0 });
    a.total++;
    if (l.brfIntelligenceAt) {
      stored++;
      a.stored++;
      stamps.push(new Date(l.brfIntelligenceAt).getTime());
    } else {
      missing++;
      a.missing++;
      if (missingSamples.length < 10) missingSamples.push(l.streetAddress || l.id);
    }
  }

  const total = listings.length;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0) + "%";
  const oldest = stamps.length ? new Date(Math.min(...stamps)) : null;
  const newest = stamps.length ? new Date(Math.max(...stamps)) : null;

  console.log(`\n=== Precomputed estimates — ${total} active listings ===\n`);
  console.log(`Stored (served fast, no crunch): ${stored}  (${pct(stored)})`);
  console.log(`Missing (feed crunches live):    ${missing}  (${pct(missing)})`);
  console.log(`\nOldest recompute: ${oldest ? oldest.toISOString() : "—"}  (${ago(oldest)})`);
  console.log(`Newest recompute: ${newest ? newest.toISOString() : "—"}  (${ago(newest)})`);
  if (oldest && (Date.now() - oldest.getTime()) / 3600000 > 30) {
    console.log(`\n⚠ Oldest stored estimate is >30h old — the daily precompute may not be running. Check the refresh workflow's "Precompute resale estimates" step.`);
  }

  console.log(`\n=== Per area (most missing first) ===\n`);
  console.log(`${pad("area", 18)} ${padL("active", 7)} ${padL("stored", 7)} ${padL("missing", 8)}`);
  const rows = Object.entries(areas).sort((a, b) => b[1].missing - a[1].missing);
  for (const [k, a] of rows) {
    console.log(`${pad(k, 18)} ${padL(a.total, 7)} ${padL(a.stored, 7)} ${padL(a.missing, 8)}`);
  }

  if (missing) {
    console.log(`\n⚠ ${missing} active listing(s) have no stored estimate yet (scored since the last precompute, or precompute never ran). Examples: ${missingSamples.join(", ")}`);
    console.log(`  These self-heal on the next daily run, or trigger it now: GET /api/precompute-estimates`);
  } else {
    console.log(`\n✅ Every active listing has a stored, precomputed estimate.`);
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
