#!/usr/bin/env node
/**
 * Read-only database inspection. Reports, per collection: document count,
 * storage size, index size, and index list — plus a Listing status breakdown
 * and a count of likely-stale data. Makes NO writes.
 *
 * Usage (e.g. in the Render Web Shell, where MONGO_URI is set):
 *   node scripts/db-inspect.js
 */
const mongoose = require("mongoose");

function mb(bytes) {
  return `${((bytes || 0) / 1048576).toFixed(2)} MB`;
}

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`Connected to database: ${db.databaseName}\n`);

  const collections = await db.listCollections().toArray();
  let totalDocs = 0;
  let totalData = 0;
  let totalIndex = 0;

  for (const { name } of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    let stats;
    try {
      stats = await db.command({ collStats: name });
    } catch {
      console.log(`${name}: (collStats unavailable)`);
      continue;
    }
    const indexes = await db.collection(name).indexes();
    totalDocs += stats.count || 0;
    totalData += stats.storageSize || 0;
    totalIndex += stats.totalIndexSize || 0;
    console.log(
      `${name.padEnd(18)} ${String(stats.count || 0).padStart(7)} docs   ` +
        `data ${mb(stats.storageSize).padStart(10)}   ` +
        `idx ${mb(stats.totalIndexSize).padStart(10)}   ` +
        `[${indexes.map((i) => i.name).join(", ")}]`
    );
  }

  console.log(
    `\nTOTAL              ${String(totalDocs).padStart(7)} docs   ` +
      `data ${mb(totalData).padStart(10)}   idx ${mb(totalIndex).padStart(10)}`
  );

  // Listing status breakdown — surfaces accumulated disappeared/sold rows.
  const listings = db.collection("listings");
  const byStatus = await listings
    .aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { n: -1 } }])
    .toArray();
  console.log("\nListing status breakdown:");
  for (const s of byStatus) console.log(`  ${String(s._id).padEnd(16)} ${s.n}`);

  // Stale-data signals.
  const missingArea = await listings.countDocuments({ area: { $in: [null, undefined] } });
  const disappearedOld = await listings.countDocuments({
    status: "disappeared",
    disappearedAt: { $lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
  });
  console.log("\nStale-data signals:");
  console.log(`  listings without an 'area' value:        ${missingArea}`);
  console.log(`  'disappeared' listings older than 90d:   ${disappearedOld}`);

  // --- Detail on limbo listings (status outside the schema enum, incl. null/missing) ---
  const VALID_STATUS = ["active", "disappeared", "confirmed_sold", "removed", "unknown", "sold"];
  const limbo = await listings
    .find({ status: { $nin: VALID_STATUS } })
    .project({
      id: 1, streetAddress: 1, status: 1, scrapeDate: 1, lastSeenAt: 1,
      disappearedAt: 1, publishedAt: 1, area: 1, images: 1, analyzedAt: 1,
    })
    .toArray();

  console.log(`\nLimbo listings (status not in schema enum) — ${limbo.length}:`);
  if (limbo.length) {
    const ts = limbo.map((d) => d._id.getTimestamp()).sort((a, b) => a - b);
    const seens = limbo.map((d) => d.lastSeenAt).filter(Boolean).map((x) => new Date(x)).sort((a, b) => a - b);
    const scrapeDates = [...new Set(limbo.map((d) => d.scrapeDate).filter(Boolean))].sort();
    const statuses = [...new Set(limbo.map((d) => JSON.stringify(d.status)))];
    const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "-");

    console.log(`  distinct status values:  ${statuses.join(", ")}`);
    console.log(`  created (_id) range:     ${iso(ts[0])} → ${iso(ts[ts.length - 1])}`);
    console.log(`  scrapeDate values:       ${scrapeDates.length ? scrapeDates.join(", ") : "(none)"}`);
    console.log(`  lastSeenAt range:        ${seens.length ? `${iso(seens[0])} → ${iso(seens[seens.length - 1])}` : "(none have lastSeenAt)"}`);
    console.log(`  have images:             ${limbo.filter((d) => Array.isArray(d.images) && d.images.length).length}/${limbo.length}`);
    console.log(`  have publishedAt:        ${limbo.filter((d) => d.publishedAt).length}/${limbo.length}`);
    console.log(`  have lastSeenAt:         ${limbo.filter((d) => d.lastSeenAt).length}/${limbo.length}`);
    console.log(`  have disappearedAt:      ${limbo.filter((d) => d.disappearedAt).length}/${limbo.length}`);
    console.log(`  have been image-analyzed:${limbo.filter((d) => d.analyzedAt).length}/${limbo.length}`);
    console.log("  sample (up to 10):");
    for (const d of limbo.slice(0, 10)) {
      console.log(
        `    id=${d.id} | "${(d.streetAddress || "").slice(0, 28)}" | ` +
          `scrapeDate=${d.scrapeDate || "-"} | lastSeen=${iso(d.lastSeenAt)} | ` +
          `imgs=${Array.isArray(d.images) ? d.images.length : 0} | created=${iso(d._id.getTimestamp())}`
      );
    }
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
