#!/usr/bin/env node
/**
 * One-time normalization of "limbo" listings — rows whose `status` is
 * missing/invalid. These are legacy listings (created ~2026-04-07, scraped
 * 2026-04-12) from before the `status`/`lastSeenAt` fields existed. They are
 * real, fully-scraped, image-analyzed listings that have not appeared in any
 * scrape since, so they are no longer on Hemnet — i.e. disappeared. The normal
 * disappearance reconciliation never caught them because it only touches
 * `status: "active"`, and these have no status field.
 *
 * Marks them `status: "disappeared"` (soldStatusConfidence: "unconfirmed"),
 * backdating lastSeenAt/disappearedAt to their last known scrape date so the
 * timeline stays honest. Keeps the documents (the image analysis is useful
 * history) — nothing is deleted.
 *
 * DRY RUN by default (prints the plan, writes nothing). Pass --apply to write.
 *
 *   node scripts/normalize-limbo-listings.js          # preview
 *   node scripts/normalize-limbo-listings.js --apply  # execute
 */
const mongoose = require("mongoose");
const Listing = require("../api/listing.model");

const VALID_STATUS = ["active", "disappeared", "confirmed_sold", "removed", "unknown", "sold"];

(async () => {
  const apply = process.argv.includes("--apply");
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set in this environment.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const limbo = await Listing.find({ status: { $nin: VALID_STATUS } }).lean();
  console.log(
    `Found ${limbo.length} limbo listing(s). Mode: ${apply ? "APPLY (writing)" : "DRY RUN (no writes)"}\n`
  );

  let updated = 0;
  for (const d of limbo) {
    // Best-known "last present" timestamp: the scrape date (YYYY-MM-DD), or the
    // document's creation time if scrapeDate is missing.
    const lastSeen = d.scrapeDate ? new Date(`${d.scrapeDate}T00:00:00Z`) : d._id.getTimestamp();
    // Clamp to >= 0: scrapeDate is date-only (midnight UTC) while publishedAt is
    // a full timestamp, so a listing published later in the day on the scrape
    // date yields a small negative; days-on-market can't be negative.
    const dom = d.publishedAt
      ? Math.max(0, Math.floor((lastSeen.getTime() - new Date(d.publishedAt).getTime()) / 86400000))
      : null;

    const update = {
      status: "disappeared",
      disappearedAt: lastSeen,
      lastSeenAt: lastSeen,
      soldStatusConfidence: "unconfirmed",
      ...(dom != null ? { daysOnMarket: dom } : {}),
    };

    console.log(
      `  ${apply ? "→" : "would set"} id=${d.id} "${(d.streetAddress || "").slice(0, 28)}" ` +
        `status=disappeared lastSeen=${lastSeen.toISOString().slice(0, 10)}${dom != null ? ` dom=${dom}` : ""}`
    );

    if (apply) {
      await Listing.updateOne({ _id: d._id }, { $set: update });
      updated++;
    }
  }

  console.log(
    `\n${apply ? `Updated ${updated} listing(s).` : `Dry run — ${limbo.length} listing(s) would be updated. Re-run with --apply to execute.`}`
  );
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
