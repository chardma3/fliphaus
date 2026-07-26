// Cross-source ingest helpers — the DB-touching layer on top of the pure matcher
// in api/listing-fingerprint.js. Used when adding a second source (Booli, broker
// sites) so the SAME physical flat merges into the existing canonical listing
// instead of creating a duplicate.
//
// The Listing model is injected (not required) so these stay unit-testable with a
// tiny fake — no database needed.
const { blockingKey, sameListing } = require("./listing-fingerprint");

// One provenance entry for a listing's `sources[]` array.
function sourceEntry(source, sourceId, url, at = new Date()) {
  return { source, sourceId: sourceId != null ? String(sourceId) : null, url: url || null, firstSeen: at };
}

// Find the existing canonical listing that is the SAME flat as `incoming`, so a
// second source can merge into it. Fetches only the incoming record's fingerprint
// bucket (indexed) and confirms each candidate with sameListing(). Returns the
// best-scoring matched doc, or null when there's no confident match.
//
// Returns null when the record can't be bucketed (blockingKey null) — better to
// create a fresh listing than to scan the whole DB and risk a loose merge.
async function findCanonicalMatch(incoming, { Listing }) {
  const key = blockingKey(incoming);
  if (!key) return null;
  const candidates = await Listing.find({ fingerprintKey: key, status: { $ne: "removed" } });
  let best = null;
  for (const candidate of candidates || []) {
    const verdict = sameListing(incoming, candidate);
    if (verdict.same && (!best || verdict.score > best.score)) {
      best = { doc: candidate, score: verdict.score };
    }
  }
  return best ? best.doc : null;
}

module.exports = { sourceEntry, findCanonicalMatch };
