// Ingest Booli FOR-SALE listings into the Listing collection, deduping against
// Hemnet's. The DB-facing counterpart to the pure api/booli-listings.js.
//
// Identity is simpler than for sold comps — an active listing is a flat currently
// on the market, so there's no sale-event to disambiguate — but it inherits ONE rule
// from api/sold-ingest.js that a live run proved necessary: never merge two records
// from the SAME source. Harvesting Årsta into an empty store produced 6 merges,
// i.e. Booli listings collapsing into each other, because a building can hold two
// same-size same-room flats at one address that no attribute can separate. Within a
// source, different ids mean different listings by definition — and here a wrong
// merge doesn't just skew a statistic, it makes a card vanish from the dashboard.
//
// The Listing model is injected so this is unit-testable with a small fake.
const { blockingKey, sameListing } = require("./listing-fingerprint");
const { sourceEntry } = require("./listing-ingest");
const { isDifferentRecordFromSameSource } = require("./sold-ingest");

// Fields a Booli listing may FILL IN on an existing Hemnet listing, never
// overwrite. Hemnet is the richer scrape (10 photos, description, BRF, stambyte)
// and its listing is the one Claire has been working with, so its values win.
// Deliberately absent: askingPrice/askingPriceNum, images, thumbnail, description,
// and everything the analysis pipeline owns (renovationScore, conditionLabel,
// brfIntelligence…).
const FILLABLE_FIELDS = ["floor", "fee", "feeNum", "brokerAgencyName", "nextShowing", "coordinates", "housingForm"];

function isBlank(value) {
  if (value == null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object" && "lat" in value) return value.lat == null;
  return false;
}

// A listing must have enough to be shown AND matched. Anything else is dropped
// rather than stored as a half-card.
function isUsableListing(listing) {
  if (!listing || !listing.id) return false;
  if (!listing.streetAddress) return false;
  if (!(Number(listing.sizeNum) > 0)) return false;
  return true;
}

// Merge a Booli listing into the Hemnet listing for the same flat: fill blanks,
// record provenance, and add the pre-market context Hemnet has no equivalent for.
// Returns null when there's nothing to add.
function buildListingMergeUpdate(existing, incoming, { now = new Date() } = {}) {
  const set = {};

  for (const field of FILLABLE_FIELDS) {
    if (isBlank(existing[field]) && !isBlank(incoming[field])) set[field] = incoming[field];
  }
  if (isBlank(existing.booliId) && incoming.booliId) set.booliId = incoming.booliId;
  // Booli's valuation is genuinely new information even when Hemnet has the listing
  // — it's a second opinion to sanity-check our own resale estimate against.
  if (existing.sourceEstimateNum == null && incoming.sourceEstimateNum != null) {
    set.sourceEstimateNum = incoming.sourceEstimateNum;
  }
  if (isBlank(existing.fingerprintKey)) {
    const key = blockingKey(existing.streetAddress ? existing : incoming);
    if (key) set.fingerprintKey = key;
  }

  const sources = Array.isArray(existing.sources) ? existing.sources : [];
  const known = sources.some(
    (s) => s.source === "booli" && (!incoming.booliId || String(s.sourceId) === String(incoming.booliId))
  );
  const push = known ? null : sourceEntry("booli", incoming.booliId, incoming.link, now);

  if (!Object.keys(set).length && !push) return null;
  return { set, push };
}

// Fields refreshed on EVERY upsert of a Booli-only listing (price can change, a
// kommande listing gains a price when it goes live, photos get added).
// `sizeNum` is dropped: the Listing schema stores `size` as a string.
function buildListingSet(incoming, { now = new Date() } = {}) {
  const { sizeNum, ...rest } = incoming;
  return {
    ...rest,
    status: "active",
    lastSeenAt: now,
    fingerprintKey: blockingKey(incoming),
  };
}

// Fields written ONLY when the document is first created. Kept strictly disjoint
// from buildListingSet: naming a path in both $set and $setOnInsert makes Mongo
// reject the whole write ("would create a conflict at ...").
function buildListingInsertOnly(incoming, { now = new Date(), scrapeDate = null } = {}) {
  return {
    firstSeenAt: now,
    scrapeDate: scrapeDate || now.toLocaleDateString("sv-SE"),
    sources: [sourceEntry("booli", incoming.booliId, incoming.link, now)],
  };
}

// Find the stored listing that `incoming` is a second source FOR, skipping any
// candidate that is a different record from the same source (see the note at the
// top). Mirrors findCanonicalMatch, plus that guard.
async function findMatchingListing(incoming, { Listing }) {
  const key = blockingKey(incoming);
  if (!key) return null;
  const candidates = (await Listing.find({ fingerprintKey: key, status: { $ne: "removed" } })) || [];
  let best = null;
  for (const candidate of candidates) {
    if (isDifferentRecordFromSameSource(incoming, candidate)) continue;
    const verdict = sameListing(incoming, candidate);
    if (verdict.same && (!best || verdict.score > best.score)) best = { doc: candidate, score: verdict.score };
  }
  return best ? best.doc : null;
}

// Upsert a harvested batch. dryRun reports what it would do and writes nothing —
// the default, because this collection IS the dashboard.
async function ingestBooliListings({
  records = [],
  Listing,
  dryRun = true,
  now = new Date(),
  scrapeDate = null,
} = {}) {
  const summary = {
    considered: records.length,
    inserted: 0,
    merged: 0,
    unchanged: 0,
    skipped: 0,
    insertedUpcoming: 0,
    insertedPriced: 0,
    samples: [],
  };

  for (const record of records) {
    if (!isUsableListing(record)) {
      summary.skipped++;
      continue;
    }

    const existing = await findMatchingListing(record, { Listing });

    if (!existing) {
      summary.inserted++;
      if (record.isUpcoming) summary.insertedUpcoming++;
      if (record.askingPriceNum != null) summary.insertedPriced++;
      if (summary.samples.length < 5) {
        summary.samples.push({
          action: "insert",
          address: record.streetAddress,
          upcoming: Boolean(record.isUpcoming),
          askingPriceNum: record.askingPriceNum,
        });
      }
      if (!dryRun) {
        // Upsert on the namespaced id so a re-run refreshes rather than duplicates.
        await Listing.updateOne(
          { id: record.id },
          {
            $set: buildListingSet(record, { now }),
            $setOnInsert: buildListingInsertOnly(record, { now, scrapeDate }),
          },
          { upsert: true }
        );
      }
      continue;
    }

    const update = buildListingMergeUpdate(existing, record, { now });
    if (!update) {
      summary.unchanged++;
      continue;
    }
    summary.merged++;
    if (summary.samples.length < 5) {
      summary.samples.push({
        action: "merge",
        address: record.streetAddress,
        into: existing.id || String(existing._id),
        filled: Object.keys(update.set),
      });
    }
    if (!dryRun) {
      const mongoUpdate = {};
      if (Object.keys(update.set).length) mongoUpdate.$set = update.set;
      if (update.push) mongoUpdate.$push = { sources: update.push };
      await Listing.updateOne({ _id: existing._id }, mongoUpdate);
    }
  }

  return summary;
}

module.exports = {
  FILLABLE_FIELDS,
  findMatchingListing,
  isUsableListing,
  buildListingMergeUpdate,
  buildListingSet,
  buildListingInsertOnly,
  ingestBooliListings,
};
