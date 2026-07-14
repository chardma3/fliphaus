#!/usr/bin/env node
/**
 * Read-only diagnostic: how big is the sold-comparables collection, and how old is
 * the data? Shows the age distribution by month and how many rows are older than a
 * retention window — so you can decide a safe SOLD_RETENTION_MONTHS before running
 * the (destructive) prune, and confirm afterwards that it stayed bounded.
 *
 * No writes. Safe to run anywhere with MONGO_URI.
 *
 *   node scripts/diagnose-sold-collection.js [retentionMonths]   # default 15
 */
require("dotenv").config();
const mongoose = require("mongoose");
const SoldListing = require("../models/sold.model");
const { cutoffDate } = require("../api/prune-sold");

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }
  const retention = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 15;
  await mongoose.connect(process.env.MONGO_URI);

  const total = await SoldListing.countDocuments({});
  const noDate = await SoldListing.countDocuments({ $or: [{ soldDate: null }, { soldDate: { $exists: false } }] });
  const cutoff = cutoffDate(retention);
  const olderThanRetention = await SoldListing.countDocuments({ soldDate: { $ne: null, $lt: cutoff } });

  // Age buckets by whole months.
  const rows = await SoldListing.find({ soldDate: { $ne: null } }, { soldDate: 1 }).lean();
  const now = Date.now();
  const byMonth = new Map();
  for (const r of rows) {
    const months = Math.floor((now - new Date(r.soldDate).getTime()) / (30.44 * 86400000));
    byMonth.set(months, (byMonth.get(months) || 0) + 1);
  }

  console.log(`\n=== Sold-comparables collection ===\n`);
  console.log(`Total rows:            ${total}`);
  console.log(`With a sold date:      ${total - noDate}`);
  console.log(`No sold date (kept):   ${noDate}`);
  console.log(`\nRetention window:      ${retention} months (cutoff ${cutoff.toISOString().slice(0, 10)})`);
  console.log(`Older than window:     ${olderThanRetention}  ← would be deleted by a prune`);
  console.log(`Would remain:          ${total - olderThanRetention}`);

  console.log(`\n=== Age distribution (months old → rows) ===\n`);
  const maxMonth = Math.max(0, ...byMonth.keys());
  for (let m = 0; m <= maxMonth; m++) {
    const n = byMonth.get(m) || 0;
    if (!n) continue;
    const bar = "█".repeat(Math.min(40, Math.round(n / Math.max(1, total / 200))));
    const flag = m >= retention ? "  ⟵ prunable" : "";
    console.log(`${padL(m, 3)}mo  ${padL(n, 6)}  ${pad(bar, 40)}${flag}`);
  }

  if (olderThanRetention === 0) {
    console.log(`\n✅ Nothing older than ${retention} months — collection is already within the window.`);
  } else {
    console.log(`\nRun a dry run first: GET /api/prune-sold?dryRun=true  (or the "Prune old sold comps" workflow).`);
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
