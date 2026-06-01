#!/usr/bin/env node
/**
 * Read-only diagnosis of why specific listings aren't being confirmed sold.
 *
 * For each target address it prints:
 *   - the Listing (status, size, rooms, area) — or "NOT FOUND"
 *   - whether any sold record shares the street name (coverage check)
 *   - the top sold candidates from the real matcher with score + reasons
 *   - the verdict vs the reconcile threshold (80)
 *
 * Pass addresses as args to override the defaults:
 *   node scripts/diagnose-sold-match.js "Torsbygatan 28" "Hammarögatan 7"
 */
const mongoose = require("mongoose");
const Listing = require("../api/listing.model");
const SoldListing = require("../models/sold.model");
const { scoreSoldMatch, normalizeText } = require("../api/reconcile-sold");

const THRESHOLD = 80;
const DEFAULT_ADDRESSES = [
  "Bagarfruvägen 17",
  "Dalbobranten 33, 5tr",
  "Lysviksgatan 51, 2 tr",
  "Torsbygatan 22, 5 tr",
  "Farstavägen 91, vån 10",
  "Larsbodavägen 50, 1 tr",
  "Bergshöjden 46",
  "Larsbodavägen 76, 3tr",
  "Torsbygatan 28",
  "Hammarögatan 7",
];

// Street name without the house number / floor — for the coverage check.
function streetStem(addr) {
  return normalizeText(addr).replace(/\d.*$/, "").trim();
}

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }
  const addresses = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ADDRESSES;

  await mongoose.connect(uri);
  const allSold = (await SoldListing.find({}).lean()) || [];
  console.log(`Sold comparables in DB: ${allSold.length}\n`);

  for (const target of addresses) {
    const stem = streetStem(target);
    const norm = normalizeText(target);

    // Find the listing by exact-ish normalized address, then loosen to street stem.
    const listings = await Listing.find({}).lean();
    const listing =
      listings.find((l) => normalizeText(l.streetAddress) === norm) ||
      listings.find((l) => normalizeText(l.streetAddress).startsWith(norm)) ||
      listings.find((l) => normalizeText(l.streetAddress).includes(stem) && stem);

    console.log(`──────── ${target}`);
    if (!listing) {
      console.log(`  Listing: NOT FOUND in DB`);
    } else {
      console.log(
        `  Listing: "${listing.streetAddress}" | status=${listing.status} | ` +
          `size=${listing.size || "-"} | rooms=${listing.rooms || "-"} | area=${listing.area || "-"} | brf=${listing.brfName || "-"}`
      );
    }

    // Coverage: any sold record on the same street?
    const sameStreet = allSold.filter((s) => stem && normalizeText(s.streetAddress).includes(stem));
    console.log(`  Sold records on this street: ${sameStreet.length}`);
    for (const s of sameStreet.slice(0, 5)) {
      console.log(`     • "${s.streetAddress}" | size=${s.size || "-"} | rooms=${s.rooms || "-"} | soldDate=${s.soldDate ? new Date(s.soldDate).toISOString().slice(0, 10) : "-"}`);
    }

    // Real matcher: top candidates and whether any clears the threshold.
    if (listing) {
      const scored = allSold
        .map((sold) => ({ sold, ...scoreSoldMatch(listing, sold) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      console.log(`  Top matcher candidates (threshold ${THRESHOLD}):`);
      for (const c of scored) {
        console.log(
          `     score=${String(c.score).padStart(3)} ${c.score >= THRESHOLD ? "✅" : "❌"} ` +
            `"${c.sold.streetAddress}" [${c.reasons.join(", ") || "no signals"}]`
        );
      }
    }
    console.log("");
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
