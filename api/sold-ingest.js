// Cross-source ingest for SOLD comps — the DB-touching layer that lets a second
// source (Booli) merge into the existing sold store instead of duplicating it.
// Mirrors api/listing-ingest.js, with one crucial difference.
//
// WHY SOLD NEEDS ITS OWN MATCHER: sameListing() answers "is this the same flat?".
// For sold comps that is NOT sufficient — the same flat legitimately sells more
// than once, and those are DIFFERENT sales that must both stay in the store (a
// 2023 sale and a 2026 sale of one apartment are two real data points). So sold
// identity is "same flat AND same sale event": sameListing() plus a sold-date
// window, plus a price sanity check.
//
// Getting this wrong is expensive in both directions:
//   - merging two real sales silently DELETES a comp and biases the kr/m²
//     percentile the whole resale estimate rests on;
//   - failing to merge one sale seen on both sources DOUBLE-WEIGHTS it.
//
// The SoldListing model is injected (not required) so this is unit-testable with
// a tiny fake — no database needed.
const { blockingKey, sameListing } = require("./listing-fingerprint");
const { parseNumber } = require("./reconcile-sold");

// A sale reported by two sources can carry slightly different dates (Booli's
// soldDate vs Hemnet's soldAt timestamp, contract vs registration date), so allow
// a window — but far tighter than the ~years between genuine re-sales.
const SALE_DATE_WINDOW_DAYS = 45;
// Two sources reporting the SAME transaction report the same final price to the
// krona — they don't round differently. So the tolerance is deliberately tiny.
// Measured reason: real Årsta data contains pairs like Rämensvägen 45, both 45 m²
// 2-rooms on floor 3, sold 15 days apart for 2 825 000 and 2 880 000 — two
// different flats. A 2% tolerance merged them and silently ate a comp; 0.5%
// keeps them apart while still absorbing a trivial discrepancy.
const SALE_PRICE_TOLERANCE = 0.005; // 0.5%

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysApart(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return null;
  return Math.abs(da.getTime() - db.getTime()) / 86400000;
}

// Is `a` the same SALE as `b` — same flat, same transaction?
// Returns { same, score, reasons, days }.
function sameSale(a, b, { windowDays = SALE_DATE_WINDOW_DAYS, priceTolerance = SALE_PRICE_TOLERANCE } = {}) {
  const flat = sameListing(a, b);
  const reasons = [...flat.reasons];
  const days = daysApart(a.soldDate, b.soldDate);

  if (!flat.same) return { same: false, score: flat.score, reasons, days };

  // A known floor mismatch means a different apartment, full stop. sameListing
  // only penalises it (-12), which a strong address + coords + size match easily
  // outweighs — real Årsta data merged floor 4 and floor 7 at Johanneshovsvägen
  // 106 on that arithmetic. For sold comps the mismatch has to be disqualifying.
  const floorA = parseNumber(a.floor);
  const floorB = parseNumber(b.floor);
  if (floorA != null && floorB != null && floorA !== floorB) {
    reasons.push("floor differs — different apartment");
    return { same: false, score: flat.score, reasons, days };
  }

  // Same flat, but no date on one side: refuse to merge. An undated record could
  // be any of that flat's sales, and a wrong merge destroys a comp.
  if (days == null) {
    reasons.push("sold date missing — not merged");
    return { same: false, score: flat.score, reasons, days };
  }
  if (days > windowDays) {
    reasons.push(`different sale (${Math.round(days)}d apart)`);
    return { same: false, score: flat.score, reasons, days };
  }
  reasons.push(`sold date within ${Math.round(days)}d`);

  const priceA = Number(a.soldPrice);
  const priceB = Number(b.soldPrice);
  if (Number.isFinite(priceA) && Number.isFinite(priceB) && priceA > 0 && priceB > 0) {
    const delta = Math.abs(priceA - priceB) / Math.max(priceA, priceB);
    if (delta > priceTolerance) {
      reasons.push(`sold price differs ${(delta * 100).toFixed(1)}% — not merged`);
      return { same: false, score: flat.score, reasons, days };
    }
    reasons.push("sold price agrees");
  }

  return { same: true, score: flat.score, reasons, days };
}

// Is `candidate` a DIFFERENT record from the same source as `incoming`?
//
// This is the strongest dedup signal available, and it's structural rather than
// heuristic: within one source, two records with different ids are two different
// sales by definition — if they were the same sale, that source would have given
// them one id. Booli's own Årsta data contains distinct flats that agree on every
// attribute we can compare (Skälderviksplan 11: two 54 m² 2-rooms, same floor,
// same building, days apart), so no amount of attribute matching can separate
// them. The source's own id can.
//
// Cross-source merging (a Booli sale onto a Hemnet document) is untouched — that
// is the whole point of the dedup.
function isDifferentRecordFromSameSource(incoming, candidate) {
  const source = incoming.source;
  if (!source) return false;
  const incomingId = incoming.booliId ?? incoming.hemnetId ?? incoming.sourceId;
  if (incomingId == null) return false;

  const ids = (Array.isArray(candidate.sources) ? candidate.sources : [])
    .filter((entry) => entry && entry.source === source && entry.sourceId != null)
    .map((entry) => String(entry.sourceId));
  if (source === "booli" && candidate.booliId != null) ids.push(String(candidate.booliId));
  if (source === "hemnet" && candidate.hemnetId != null) ids.push(String(candidate.hemnetId));

  if (!ids.length) return false; // candidate isn't known to this source — cross-source, fine
  return !ids.includes(String(incomingId));
}

// One provenance entry for a sold record's `sources[]`.
function soldSourceEntry(source, sourceId, url, at = new Date()) {
  return { source, sourceId: sourceId != null ? String(sourceId) : null, url: url || null, firstSeen: at };
}

// Find the stored sale that `incoming` duplicates. Fetches only the incoming
// record's fingerprint bucket (indexed) and confirms with sameSale().
//
// Returns null when the record can't be bucketed — better to insert than to scan
// the whole collection and risk a loose merge. NOTE: existing documents only have
// a fingerprintKey after scripts/migrate-sold-sources.js has run; without that
// backfill every Booli record looks new and inserts a duplicate.
async function findCanonicalSoldMatch(incoming, { SoldListing, windowDays } = {}) {
  const key = blockingKey(incoming);
  if (!key) return null;
  const candidates = (await SoldListing.find({ fingerprintKey: key })) || [];
  let best = null;
  for (const candidate of candidates) {
    if (isDifferentRecordFromSameSource(incoming, candidate)) continue;
    const verdict = sameSale(incoming, candidate, windowDays ? { windowDays } : {});
    if (verdict.same && (!best || verdict.score > best.score)) {
      best = { doc: candidate, score: verdict.score };
    }
  }
  return best ? best.doc : null;
}

// Fields a second source may FILL IN on an existing record, but never overwrite.
// The stored value wins because it's either Hemnet's (our primary, richer scrape)
// or an earlier, already-reconciled value. Analysis fields (renovationScore etc.)
// are deliberately absent — those are ours, and Booli has no equivalent.
const FILLABLE_FIELDS = [
  "streetAddress",
  "locationDescription",
  "area",
  "rooms",
  "size",
  "sizeNum",
  "askingPrice",
  "askingPriceNum",
  "soldPrice",
  "soldPriceSqm",
  "priceChange",
  "soldDate",
  "daysOnMarket",
  "housingForm",
  "brfName",
  "floor",
];

function isBlank(value) {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

// Build the update for merging a Booli record into an existing sold document:
// fill blanks only, record provenance, and never touch what's already there.
// Returns null when there is nothing to add (so the caller can skip the write).
function buildSoldMergeUpdate(existing, incoming, { now = new Date() } = {}) {
  const set = {};

  for (const field of FILLABLE_FIELDS) {
    if (isBlank(existing[field]) && !isBlank(incoming[field])) {
      set[field] = field === "soldDate" ? toDate(incoming[field]) : incoming[field];
    }
  }

  if (isBlank(existing.coordinates?.lat) && incoming.coordinates?.lat != null) {
    set.coordinates = incoming.coordinates;
  }
  if (isBlank(existing.booliId) && incoming.booliId) set.booliId = String(incoming.booliId);
  if (isBlank(existing.fingerprintKey)) {
    const key = blockingKey(existing.streetAddress ? existing : incoming);
    if (key) set.fingerprintKey = key;
  }

  const sources = Array.isArray(existing.sources) ? existing.sources : [];
  const alreadyKnown = sources.some(
    (s) => s.source === "booli" && (!incoming.booliId || String(s.sourceId) === String(incoming.booliId))
  );
  const push = alreadyKnown
    ? null
    : soldSourceEntry("booli", incoming.booliId, incoming.link, now);

  if (!Object.keys(set).length && !push) return null;
  return { set, push };
}

// A Booli record as a NEW sold document. `hemnetId` is deliberately left unset —
// the field is sparse-unique now, so a Booli-only sale simply has no Hemnet id.
function buildSoldInsert(incoming, { now = new Date() } = {}) {
  return {
    booliId: incoming.booliId != null ? String(incoming.booliId) : null,
    streetAddress: incoming.streetAddress || null,
    locationDescription: incoming.locationDescription || null,
    area: incoming.area || null,
    rooms: incoming.rooms || null,
    size: incoming.size || null,
    sizeNum: incoming.sizeNum ?? null,
    askingPrice: incoming.askingPrice || null,
    askingPriceNum: incoming.askingPriceNum ?? null,
    soldPrice: incoming.soldPrice ?? null,
    soldPriceSqm: incoming.soldPriceSqm ?? null,
    priceChange: incoming.priceChange ?? null,
    soldDate: toDate(incoming.soldDate),
    daysOnMarket: incoming.daysOnMarket ?? null,
    housingForm: incoming.housingForm || null,
    floor: incoming.floor ?? null,
    coordinates: incoming.coordinates || { lat: null, lng: null },
    link: incoming.link || null,
    fingerprintKey: blockingKey(incoming),
    sources: [soldSourceEntry("booli", incoming.booliId, incoming.link, now)],
    scrapedAt: now,
  };
}

// A record must carry enough to be a usable comp AND to be matched safely.
// Anything else is dropped rather than stored as a half-record that would dilute
// the comp set.
function isUsableSoldComp(record) {
  if (!record) return false;
  if (!(Number(record.soldPrice) > 0)) return false;
  if (!(Number(record.sizeNum) > 0)) return false;
  if (!toDate(record.soldDate)) return false;
  if (!record.streetAddress) return false;
  return true;
}

// Ingest normalized Booli sold records into the sold store.
// dryRun reports exactly what would happen without writing — the default, because
// this collection feeds every resale estimate in the app.
async function ingestBooliSold({ records = [], SoldListing, dryRun = true, now = new Date() } = {}) {
  const summary = { considered: records.length, inserted: 0, merged: 0, unchanged: 0, skipped: 0, samples: [] };

  for (const record of records) {
    if (!isUsableSoldComp(record)) {
      summary.skipped++;
      continue;
    }

    const existing = await findCanonicalSoldMatch(record, { SoldListing });

    if (!existing) {
      summary.inserted++;
      if (summary.samples.length < 5) {
        summary.samples.push({ action: "insert", address: record.streetAddress, soldDate: record.soldDate });
      }
      if (!dryRun) await SoldListing.create(buildSoldInsert(record, { now }));
      continue;
    }

    const update = buildSoldMergeUpdate(existing, record, { now });
    if (!update) {
      summary.unchanged++;
      continue;
    }
    summary.merged++;
    if (summary.samples.length < 5) {
      summary.samples.push({
        action: "merge",
        address: record.streetAddress,
        into: existing.hemnetId || existing.booliId || String(existing._id),
        filled: Object.keys(update.set),
      });
    }
    if (!dryRun) {
      const mongoUpdate = {};
      if (Object.keys(update.set).length) mongoUpdate.$set = update.set;
      if (update.push) mongoUpdate.$push = { sources: update.push };
      await SoldListing.updateOne({ _id: existing._id }, mongoUpdate);
    }
  }

  return summary;
}

module.exports = {
  SALE_DATE_WINDOW_DAYS,
  SALE_PRICE_TOLERANCE,
  sameSale,
  isDifferentRecordFromSameSource,
  soldSourceEntry,
  findCanonicalSoldMatch,
  buildSoldMergeUpdate,
  buildSoldInsert,
  isUsableSoldComp,
  ingestBooliSold,
  FILLABLE_FIELDS,
};
