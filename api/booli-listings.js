// Booli's FOR-SALE listings (step d of the multi-source plan) — the feed side, as
// opposed to api/booli.js's sold comps. Pure: URL building, the Apollo-cache walk,
// image-URL construction and field mapping. No I/O, so it's unit-testable.
//
// Verified against live Booli data 2026-07-30 (Årsta, 70 listings). Two findings
// shape this file:
//
//   1. PHOTOS ARE AVAILABLE, but the `Image` entities in __APOLLO_STATE__ carry no
//      url — only id/alt/width/height/primaryLabel. The URL is derivable from the
//      id (booliImageUrl below), confirmed serving 200 image/jpeg. So the search
//      page alone yields photos; no per-listing detail fetch is needed. The catch:
//      only 3–5 images per listing, against the 10 our Hemnet analysis spreads.
//   2. TWO THIRDS HAVE NO ASKING PRICE. 47 of 70 had listPrice null, 46 of those
//      with upcomingSale=true — i.e. "kommande", pre-market listings. They're the
//      most valuable part of this feed (early access before open-market bidding),
//      but profit/ROI maths keys off an asking price, so they must NOT be given
//      one. Booli's own `estimate` rides along as context only.
const { parseNumber } = require("./reconcile-sold");
const { BOOLI_BASE, rawNum, parseDataPoints, displayAttributesOf } = require("./booli");

// Widths Booli's CDN exposes. 1024 is the analysis default: big enough for the
// renovation model to read materials, ~60–105KB rather than the 1440's ~100–195KB
// (the residential proxy is metered by the gigabyte).
const IMAGE_WIDTHS = [60, 420, 768, 1024, 1440];
const DEFAULT_IMAGE_WIDTH = 1024;

function booliImageUrl(imageId, width = DEFAULT_IMAGE_WIDTH) {
  if (imageId == null || imageId === "") return null;
  const w = IMAGE_WIDTHS.includes(Number(width)) ? Number(width) : DEFAULT_IMAGE_WIDTH;
  return `https://bcdn.se/images/cache/${imageId}_${w}x0.jpg`;
}

function buildForSaleSearchUrl({ areaId, objectType = "Lägenhet", page = 1 } = {}) {
  const params = new URLSearchParams({ areaIds: String(areaId) });
  if (objectType) params.set("objectType", objectType);
  if (page && page > 1) params.set("page", String(page));
  return `${BOOLI_BASE}/sok/till-salu?${params.toString()}`;
}

// Booli labels every photo (primaryLabel: "kitchen/dining_room", "bathroom/laundry",
// "wc", "bedroom", "livingroom", "exterior", "balcony/view"…). Our renovation score
// is only trustworthy when the KITCHEN and BATHROOM were actually visible — on the
// Hemnet side that's guesswork plus a whole re-check stage. Here we can order the
// photos deliberately, so a 5-image budget spends itself on the rooms that decide
// the renovation estimate.
const ROOM_PRIORITY = [
  { rank: 0, test: /kitchen/i },
  { rank: 1, test: /bathroom|wc|shower|laundry/i },
  { rank: 2, test: /livingroom|living_room|dining/i },
  { rank: 3, test: /bedroom/i },
];

function roomRank(label) {
  const text = String(label || "");
  for (const entry of ROOM_PRIORITY) {
    if (entry.test.test(text)) return entry.rank;
  }
  return 9; // exterior / balcony / courtyard / view — least useful for renovation
}

// Stable sort by usefulness, preserving Booli's own order within a tier.
function orderImagesByRoom(images = []) {
  return images
    .map((img, index) => ({ img, index, rank: roomRank(img && (img.primaryLabel || img.alt)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.img);
}

// Walk one server-rendered for-sale page: resolve the searchForSale result refs AND
// each listing's image refs against the Apollo cache.
//
// NOTE the key filter: the page carries a SECOND searchForSale keyed with
// forceOnlyNewConstruction:true (a new-builds widget). Harvesting that one would
// quietly return new-construction inventory instead of the real result set.
function harvestForSalePage(nextData) {
  const apollo = nextData?.props?.pageProps?.__APOLLO_STATE__;
  if (!apollo) return { pages: null, totalCount: null, records: [] };
  const root = apollo.ROOT_QUERY || {};
  const key = Object.keys(root).find(
    (k) => k.startsWith("searchForSale") && !k.includes("forceOnlyNewConstruction")
  );
  const result = key ? root[key] : null;
  if (!result) return { pages: null, totalCount: null, records: [] };

  const deref = (ref) => (ref && ref.__ref ? apollo[ref.__ref] : ref);

  const records = (result.result || [])
    .map(deref)
    .filter(Boolean)
    .map((listing) => {
      const imagesKey = Object.keys(listing).find((k) => k.startsWith("images("));
      const refs = (imagesKey && listing[imagesKey]) || [];
      const images = refs.map(deref).filter(Boolean);
      const primary = deref(listing.primaryImage);
      return { ...listing, _images: images, _primaryImage: primary };
    });

  return {
    pages: result.pages != null ? Number(result.pages) : null,
    totalCount: result.totalCount != null ? Number(result.totalCount) : null,
    records,
  };
}

// One Booli for-sale listing -> our Listing shape (api/listing.model.js).
//
// `id` is namespaced "booli-<booliId>" because that field is uniquely indexed and
// holds Hemnet ids; a bare numeric id could collide with a Hemnet listing's.
function normalizeBooliListing(raw, { area = null, imageWidth = DEFAULT_IMAGE_WIDTH } = {}) {
  if (!raw) return null;
  const points = parseDataPoints(displayAttributesOf(raw)?.dataPoints || []);
  const lat = rawNum(raw.latitude);
  const lng = rawNum(raw.longitude);
  const askingPriceNum = rawNum(raw.listPrice);
  const upcoming = Boolean(raw.upcomingSale);

  const ordered = orderImagesByRoom(raw._images || []);
  const images = ordered.map((img) => booliImageUrl(img.id, imageWidth)).filter(Boolean);
  const primaryUrl = raw._primaryImage ? booliImageUrl(raw._primaryImage.id, imageWidth) : null;
  const agency = raw[Object.keys(raw).find((k) => k.startsWith("agency(")) || ""] || null;
  // Keep Booli's own fee string ("4 594 kr/mån") for display — re-rendering the
  // parsed number would drop the thousands separator the cards elsewhere show.
  const feeText =
    (displayAttributesOf(raw)?.dataPoints || [])
      .map((dp) => (dp && dp.value && dp.value.plainText) || "")
      .find((text) => /kr\s*\/\s*m(å|a)n/i.test(text)) || null;

  return {
    id: raw.booliId != null ? `booli-${raw.booliId}` : null,
    source: "booli",
    booliId: raw.booliId != null ? String(raw.booliId) : null,
    streetAddress: raw.streetAddress || null,
    // descriptiveAreaName is the REAL district, the distinction the Hemnet side
    // draws between a coarse catchment and the district a listing sits in.
    locationDescription: raw.descriptiveAreaName || null,
    area,
    housingForm: raw.tenureForm || raw.objectType || null,
    rooms: points.rooms != null ? `${points.rooms} rum` : null,
    size: points.sizeNum != null ? `${points.sizeNum} m²` : null,
    sizeNum: points.sizeNum,
    floor: points.floor != null ? String(points.floor) : null,
    // Kommande listings genuinely have no asking price. Leave it null rather than
    // substituting Booli's estimate — every profit/ROI number downstream keys off
    // this field, and a valuation dressed as an asking price would fake precision.
    askingPrice: raw.listPrice?.formatted || null,
    askingPriceNum,
    squareMeterPrice: raw.listSqmPrice?.formatted || null,
    fee: feeText,
    feeNum: points.feeNum,
    brokerAgencyName: (agency && agency.name) || null,
    nextShowing: raw.nextShowing || null,
    link: raw.url ? `${BOOLI_BASE}${raw.url}` : null,
    images,
    thumbnail: primaryUrl || images[0] || null,
    coordinates: lat != null && lng != null ? { lat, lng } : null,
    publishedAt: raw.published || null,
    daysOnMarket: rawNum(raw.daysActive),
    // Pre-market flag + Booli's own valuation, kept clearly separate from price.
    isUpcoming: upcoming,
    sourceEstimateNum: rawNum(raw.estimate?.price),
    isNewConstruction: Boolean(raw.isNewConstruction),
    biddingOpen: Boolean(rawNum(raw.biddingOpen)),
  };
}

// Page through an area's for-sale listings. `fetchNextData(url)` returns a page's
// parsed __NEXT_DATA__. De-duplicates by id, since a listing can shift pages
// between requests.
async function collectBooliListings({
  fetchNextData,
  areaId,
  area = null,
  objectType = "Lägenhet",
  maxPages = 5,
  imageWidth = DEFAULT_IMAGE_WIDTH,
} = {}) {
  const out = [];
  const seen = new Set();
  let pages = 1;
  let totalCount = null;

  for (let page = 1; page <= Math.min(pages, maxPages); page++) {
    const nextData = await fetchNextData(buildForSaleSearchUrl({ areaId, objectType, page }));
    const harvested = harvestForSalePage(nextData);
    if (harvested.pages != null) pages = harvested.pages;
    if (harvested.totalCount != null && totalCount == null) totalCount = harvested.totalCount;
    if (!harvested.records.length) break;

    for (const raw of harvested.records) {
      const listing = normalizeBooliListing(raw, { area, imageWidth });
      if (!listing || !listing.id) continue;
      if (seen.has(listing.id)) continue;
      seen.add(listing.id);
      out.push(listing);
    }
  }

  return {
    listings: out,
    pages,
    totalCount,
    upcoming: out.filter((l) => l.isUpcoming).length,
    priced: out.filter((l) => l.askingPriceNum != null).length,
  };
}

module.exports = {
  IMAGE_WIDTHS,
  DEFAULT_IMAGE_WIDTH,
  booliImageUrl,
  buildForSaleSearchUrl,
  roomRank,
  orderImagesByRoom,
  harvestForSalePage,
  normalizeBooliListing,
  collectBooliListings,
  parseNumber,
};
