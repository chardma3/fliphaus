#!/usr/bin/env node
/**
 * Read-only diagnostic: is every listing's profit verdict actually backed by the
 * sold data we collect, or is it falling back to the hardcoded area benchmark?
 *
 * Mirrors the live feed exactly — same buildBrfIntelligence + calcInvestment path
 * as server.js — so the counts match what the dashboard shows. A listing only
 * turns GREEN (renovation-upside) or RED (unprofitable) when its estimate is
 * sold-comparable backed (confident); otherwise it's YELLOW (preliminary, on the
 * area benchmark). This reports how many of each, globally and per area, so we
 * can see exactly where we still lack the sold comps to back a verdict.
 *
 * No model calls, no scraping, no writes. Safe to run anywhere with MONGO_URI.
 *
 *   node scripts/diagnose-estimate-backing.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Listing = require("../api/listing.model");
const SoldListing = require("../models/sold.model");
const { buildBrfIntelligence, canonicalArea } = require("../api/brf-intelligence");
const { calcInvestment } = require("../profitability.js");

// Group by the SAME canonical area the matcher uses, so sub-labels collapse into
// their parent scraped area and the comp counts line up with what backs a verdict.
function areaKey(value) {
  return canonicalArea(value) || "(unknown)";
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  // Active listings that actually get a profit verdict (scored, real addresses).
  // Project/new-build listings (no street number) carry no profit badge, so skip.
  const listings = await Listing.find(
    { status: "active", renovationScore: { $ne: null }, streetAddress: { $not: /^[^0-9]+$/ } },
    { __v: 0 }
  ).lean();
  const soldListings = await SoldListing.find({}, { __v: 0 }).sort({ soldDate: -1 }).lean();

  // Sold comps we hold per area (the raw material for a data-backed verdict).
  const soldByArea = {};
  for (const s of soldListings) {
    if (!(Number(s.soldPriceSqm) > 0)) continue;
    const k = areaKey(s.area || s.locationDescription);
    soldByArea[k] = (soldByArea[k] || 0) + 1;
  }

  const VERDICT = {
    "renovation-upside": "🟢 green",
    "unprofitable": "🔴 red",
    "preliminary-renovation-upside": "🟡 yellow",
    "preliminary-unprofitable": "🟡 yellow",
    "market-gap": "⚪ market-gap",
    "low-upside": "⚪ move-in",
    "insufficient-data": "· pending",
  };

  let backed = 0;
  let benchmark = 0;
  const confCount = { high: 0, medium: 0, low: 0 };
  const verdictCount = {};
  const areas = {}; // key -> { listings, backed, benchmark, soldComps, p75 samples }

  for (const l of listings) {
    l.brfIntelligence = buildBrfIntelligence(l, soldListings);
    const calc = calcInvestment(l);
    const arb = l.brfIntelligence.renovationArbitrage;
    const k = areaKey(l.locationDescription || l.area);

    const a = areas[k] || (areas[k] = { listings: 0, backed: 0, benchmark: 0, p75: arb.estimatedRenovatedSqm || null });
    a.listings++;

    if (calc.estimateSource === "sold-comparables") { backed++; a.backed++; }
    else { benchmark++; a.benchmark++; }

    if (arb.confidence in confCount) confCount[arb.confidence]++;
    verdictCount[calc.classification] = (verdictCount[calc.classification] || 0) + 1;
  }

  const total = listings.length;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0) + "%";

  console.log(`\n=== Estimate backing — ${total} active scored listings ===\n`);
  console.log(`Backed by SOLD COMPARABLES (green/red-eligible): ${backed}  (${pct(backed)})`);
  console.log(`On AREA BENCHMARK (yellow / preliminary):        ${benchmark}  (${pct(benchmark)})`);
  console.log(`\nConfidence: high ${confCount.high} · medium ${confCount.medium} · low ${confCount.low}`);
  console.log(`Verdicts:   ${Object.entries(verdictCount).map(([c, n]) => `${VERDICT[c] || c} ${n}`).join(" · ")}`);

  console.log(`\n=== Per area (sorted: most benchmark-only first) ===\n`);
  console.log(`${pad("area", 18)} ${padL("listings", 9)} ${padL("backed", 7)} ${padL("benchmark", 10)} ${padL("soldComps", 10)} ${padL("p75 kr/m²", 11)}`);
  const rows = Object.entries(areas).sort((a, b) => b[1].benchmark - a[1].benchmark);
  for (const [k, a] of rows) {
    console.log(
      `${pad(k, 18)} ${padL(a.listings, 9)} ${padL(a.backed, 7)} ${padL(a.benchmark, 10)} ` +
      `${padL(soldByArea[k] || 0, 10)} ${padL(a.p75 ? a.p75.toLocaleString("sv-SE") : "—", 11)}`
    );
  }

  const gaps = rows.filter(([, a]) => a.benchmark > 0);
  if (gaps.length) {
    console.log(`\n⚠ ${gaps.length} area(s) still have benchmark-only listings — not yet backed by collected sold data:`);
    for (const [k, a] of gaps) {
      const why = (soldByArea[k] || 0) < 5 ? `only ${soldByArea[k] || 0} sold comps collected` : `${soldByArea[k]} comps but thin same-area matches`;
      console.log(`  ${pad(k, 18)} ${a.benchmark}/${a.listings} on benchmark — ${why}`);
    }
  } else {
    console.log(`\n✅ Every active scored listing is backed by collected sold data.`);
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
