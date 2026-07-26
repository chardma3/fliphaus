// Source-independent listing identity, for de-duplicating the SAME physical flat
// across sources (Hemnet, Booli, broker sites) and across re-listings.
//
// Today listings are keyed by Hemnet `id`, which can't survive a second source.
// This module answers two questions without touching the DB:
//   blockingKey(listing) — a coarse bucket key to fetch plausible candidates
//                          cheaply before doing the precise comparison.
//   sameListing(a, b)    — is this the same flat? A weighted decision that
//                          reuses the sold-reconciliation matcher's normalization
//                          and adds coordinates + floor for cross-source precision.
//
// Deliberately pure (no I/O) so it's unit-testable and safe to land before any
// Booli wiring. Mirrors scoreSoldMatch in reconcile-sold.js — same address/size/
// rooms/area/BRF signals — plus geo + floor, which matter when two same-size
// units sit in one building.
const { normalizeText, parseNumber, firstAreaToken, tokenOverlap } = require("./reconcile-sold");

// Metres between two {lat,lng} points (haversine). null if either is missing.
function metresApart(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Coarse bucket key: area + rounded size + integer rooms. Two records for the
// same flat always share it (barring a bad size/area parse), so ingest can fetch
// just this bucket's candidates and run sameListing() on those, not the whole DB.
// Returns null when there isn't enough to bucket on (caller falls back to a wider
// scan rather than trusting a weak key).
function blockingKey(listing) {
  const area = firstAreaToken(listing.locationDescription || listing.area);
  const size = parseNumber(listing.sizeNum ?? listing.size);
  if (!area || size == null) return null;
  const rooms = parseNumber(listing.rooms);
  return `${area}|${Math.round(size)}|${rooms != null ? Math.round(rooms) : "?"}`;
}

// Is `a` the same physical flat as `b`? Weighted, with a hard requirement:
// there must be a LOCATION anchor (same/close address OR coordinates within 60m)
// AND no hard size conflict — otherwise two different flats in one building (or
// one street) could merge. Returns { same, score, reasons }.
function sameListing(a, b) {
  let score = 0;
  const reasons = [];

  const addrA = normalizeText(a.streetAddress);
  const addrB = normalizeText(b.streetAddress);
  let addressAnchor = false;
  if (addrA && addrB && addrA === addrB) {
    score += 50; addressAnchor = true; reasons.push("address exact");
  } else if (tokenOverlap(a.streetAddress, b.streetAddress) >= 0.75) {
    score += 30; addressAnchor = true; reasons.push("address close");
  }

  const dist = metresApart(a.coordinates, b.coordinates);
  let geoAnchor = false;
  if (dist != null) {
    if (dist <= 25) { score += 45; geoAnchor = true; reasons.push("coords ≤25m"); }
    else if (dist <= 60) { score += 20; geoAnchor = true; reasons.push("coords ≤60m"); }
    else if (dist >= 250) { score -= 30; reasons.push("coords far apart"); }
  }

  // Size is the strongest disambiguator between units at one address.
  const sizeA = parseNumber(a.sizeNum ?? a.size);
  const sizeB = parseNumber(b.sizeNum ?? b.size);
  let sizeConflict = false;
  if (sizeA != null && sizeB != null) {
    const diff = Math.abs(sizeA - sizeB);
    if (diff <= 2) { score += 25; reasons.push("size ≤2m²"); }
    else if (diff <= 5) { score += 8; reasons.push("size ≤5m²"); }
    else { score -= 40; sizeConflict = true; reasons.push("size conflict"); }
  }

  const roomsA = parseNumber(a.rooms);
  const roomsB = parseNumber(b.rooms);
  if (roomsA != null && roomsB != null) {
    const diff = Math.abs(roomsA - roomsB);
    if (diff === 0) { score += 10; reasons.push("rooms exact"); }
    else if (diff >= 1) { score -= 20; reasons.push("rooms conflict"); }
  }

  const floorA = parseNumber(a.floor);
  const floorB = parseNumber(b.floor);
  if (floorA != null && floorB != null) {
    if (floorA === floorB) { score += 8; reasons.push("floor exact"); }
    else { score -= 12; reasons.push("floor differs"); }
  }

  const areaA = firstAreaToken(a.locationDescription || a.area);
  const areaB = firstAreaToken(b.locationDescription || b.area);
  if (areaA && areaB && areaA === areaB) { score += 5; reasons.push("same area"); }

  if (a.brfName && b.brfName && normalizeText(a.brfName) === normalizeText(b.brfName)) {
    score += 10; reasons.push("same BRF");
  }

  const same = score >= 70 && (addressAnchor || geoAnchor) && !sizeConflict;
  return { same, score, reasons };
}

module.exports = { blockingKey, sameListing, metresApart };
