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

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
