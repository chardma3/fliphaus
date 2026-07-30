const test = require("node:test");
const assert = require("node:assert/strict");

const {
  booliImageUrl,
  buildForSaleSearchUrl,
  roomRank,
  orderImagesByRoom,
  harvestForSalePage,
  normalizeBooliListing,
  collectBooliListings,
} = require("../api/booli-listings");

// Shapes captured verbatim from a live Booli for-sale page (Årsta, 2026-07-30).
const IMAGES = {
  "Image:1": { __typename: "Image", id: "1", alt: "Interiörbild", primaryLabel: "balcony/view" },
  "Image:2": { __typename: "Image", id: "2", alt: "Kök eller matrum", primaryLabel: "kitchen/dining_room" },
  "Image:3": { __typename: "Image", id: "3", alt: "Tvättstuga/badrum", primaryLabel: "bathroom/laundry" },
  "Image:4": { __typename: "Image", id: "4", alt: "Exteriörbild", primaryLabel: "exterior" },
  "Image:5": { __typename: "Image", id: "5", alt: "Sovrum", primaryLabel: "bedroom" },
};

// A KOMMANDE listing: no listPrice, upcomingSale true — 67% of the real feed.
const upcomingRaw = {
  __typename: "Listing",
  id: "5868305",
  booliId: "5868305",
  streetAddress: "Möckelvägen 32",
  descriptiveAreaName: "Årsta",
  tenureForm: "Bostadsrätt",
  objectType: "Lägenhet",
  listPrice: null,
  listSqmPrice: null,
  latitude: 59.297,
  longitude: 18.045,
  daysActive: 0,
  published: "2026-07-30 10:34:28",
  upcomingSale: true,
  biddingOpen: 0,
  isNewConstruction: false,
  estimate: { __typename: "Estimate", price: { raw: 2540000, formatted: "2 540 000 kr" } },
  url: "/bostad/679504",
  primaryImage: { __ref: "Image:1" },
  'images({"limit":5})': [{ __ref: "Image:1" }, { __ref: "Image:2" }, { __ref: "Image:3" }],
  'agency({"queryContext":"SERP_LIST_LISTING"})': { __typename: "Agency", name: "Historiska Hem" },
  'displayAttributes({"queryContext":"SERP_LIST_LISTING"})': {
    dataPoints: [
      { value: { plainText: "44 m²" } },
      { value: { plainText: "2 rum" } },
      { value: { plainText: "vån 3" } },
      { value: { plainText: "4 594 kr/mån" } },
    ],
  },
};

// A normally PRICED listing.
const pricedRaw = {
  ...upcomingRaw,
  booliId: "6208449",
  streetAddress: "Årstavägen 72",
  listPrice: { raw: 4495000, formatted: "4 495 000 kr" },
  listSqmPrice: { formatted: "81 727 kr/m²" },
  upcomingSale: false,
  daysActive: 1,
  estimate: { price: { raw: 4880000 } },
};

function pageWith(records, { pages = 3, totalCount = 91, newConstruction = false } = {}) {
  const apollo = { ROOT_QUERY: { __typename: "Query" }, ...IMAGES };
  const refs = records.map((r) => {
    const key = `Listing:${r.booliId}`;
    apollo[key] = r;
    return { __ref: key };
  });
  apollo.ROOT_QUERY['searchForSale({"input":{"areaId":"874649","page":1}})'] = {
    __typename: "SearchForSaleResult", pages, totalCount, result: refs,
  };
  if (newConstruction) {
    // The decoy the real page carries: a second searchForSale for new builds.
    apollo.ROOT_QUERY['searchForSale({"forceOnlyNewConstruction":true,"input":{"areaId":"874649","page":1}})'] = {
      __typename: "SearchForSaleResult", pages: 1, totalCount: 1, result: [],
    };
  }
  return { props: { pageProps: { __APOLLO_STATE__: apollo } } };
}

test("booliImageUrl builds a CDN url from the image id", () => {
  // The Image entity carries no url — this pattern was verified serving 200 image/jpeg.
  assert.equal(booliImageUrl("49468506"), "https://bcdn.se/images/cache/49468506_1024x0.jpg");
  assert.equal(booliImageUrl("49468506", 1440), "https://bcdn.se/images/cache/49468506_1440x0.jpg");
  assert.equal(booliImageUrl("49468506", 999), "https://bcdn.se/images/cache/49468506_1024x0.jpg"); // unknown width → default
  assert.equal(booliImageUrl(null), null);
});

test("buildForSaleSearchUrl targets till-salu with filter and page", () => {
  assert.equal(
    buildForSaleSearchUrl({ areaId: "874649" }),
    "https://www.booli.se/sok/till-salu?areaIds=874649&objectType=L%C3%A4genhet"
  );
  assert.match(buildForSaleSearchUrl({ areaId: "874649", page: 2 }), /&page=2$/);
});

test("room ranking puts the rooms that drive a renovation estimate first", () => {
  assert.ok(roomRank("kitchen/dining_room") < roomRank("bathroom/laundry"));
  assert.ok(roomRank("bathroom/laundry") < roomRank("livingroom"));
  assert.ok(roomRank("wc") < roomRank("bedroom"));
  assert.ok(roomRank("bedroom") < roomRank("exterior"));
  assert.equal(roomRank(undefined), 9);
});

test("orderImagesByRoom leads with kitchen then bathroom, keeping Booli's order within a tier", () => {
  // With only 3-5 photos per listing, spending them on kitchen+bathroom is what
  // makes the renovation score trustworthy (imageCoverageComplete).
  const ordered = orderImagesByRoom([IMAGES["Image:1"], IMAGES["Image:2"], IMAGES["Image:3"], IMAGES["Image:5"]]);
  assert.deepEqual(ordered.map((i) => i.primaryLabel), [
    "kitchen/dining_room",
    "bathroom/laundry",
    "bedroom",
    "balcony/view",
  ]);
});

test("harvestForSalePage resolves listing AND image refs", () => {
  const out = harvestForSalePage(pageWith([pricedRaw]));
  assert.equal(out.pages, 3);
  assert.equal(out.totalCount, 91);
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0]._images.length, 3);
  assert.equal(out.records[0]._images[1].primaryLabel, "kitchen/dining_room");
  assert.equal(out.records[0]._primaryImage.id, "1");
});

test("harvestForSalePage ignores the new-construction searchForSale decoy", () => {
  // Reading that key instead would silently return new builds, not the real feed.
  const out = harvestForSalePage(pageWith([pricedRaw], { newConstruction: true }));
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].booliId, "6208449");
});

test("harvestForSalePage degrades to empty rather than throwing", () => {
  assert.deepEqual(harvestForSalePage(null), { pages: null, totalCount: null, records: [] });
  assert.deepEqual(harvestForSalePage({ props: { pageProps: { __APOLLO_STATE__: { ROOT_QUERY: {} } } } }), {
    pages: null, totalCount: null, records: [],
  });
});

test("normalizeBooliListing maps a priced listing to our Listing shape", () => {
  const [record] = harvestForSalePage(pageWith([pricedRaw])).records;
  const l = normalizeBooliListing(record, { area: "Årsta" });
  assert.equal(l.id, "booli-6208449"); // namespaced: `id` is unique and holds Hemnet ids
  assert.equal(l.source, "booli");
  assert.equal(l.streetAddress, "Årstavägen 72");
  assert.equal(l.locationDescription, "Årsta");
  assert.equal(l.housingForm, "Bostadsrätt");
  assert.equal(l.rooms, "2 rum");
  assert.equal(l.size, "44 m²");
  assert.equal(l.sizeNum, 44);
  assert.equal(l.floor, "3");
  assert.equal(l.askingPriceNum, 4495000);
  assert.equal(l.feeNum, 4594);
  assert.equal(l.fee, "4 594 kr/mån"); // Booli's own formatting preserved for display
  assert.equal(l.brokerAgencyName, "Historiska Hem");
  assert.equal(l.link, "https://www.booli.se/bostad/679504");
  assert.deepEqual(l.coordinates, { lat: 59.297, lng: 18.045 });
  assert.equal(l.isUpcoming, false);
  assert.equal(l.sourceEstimateNum, 4880000);
  assert.equal(l.images[0], "https://bcdn.se/images/cache/2_1024x0.jpg"); // kitchen first
});

test("a kommande listing keeps a NULL asking price and carries the estimate separately", () => {
  // The critical rule: every profit/ROI number keys off askingPriceNum, so a
  // valuation must never be written into it.
  const [record] = harvestForSalePage(pageWith([upcomingRaw])).records;
  const l = normalizeBooliListing(record, { area: "Årsta" });
  assert.equal(l.isUpcoming, true);
  assert.equal(l.askingPriceNum, null);
  assert.equal(l.askingPrice, null);
  assert.equal(l.squareMeterPrice, null);
  assert.equal(l.sourceEstimateNum, 2540000); // context only
  assert.equal(l.feeNum, 4594); // fee IS known pre-market
});

test("collectBooliListings pages, dedupes, and counts upcoming vs priced", async () => {
  const urls = [];
  const fetchNextData = async (url) => {
    urls.push(url);
    return pageWith([upcomingRaw, pricedRaw], { pages: 4 });
  };
  const out = await collectBooliListings({ fetchNextData, areaId: "874649", area: "Årsta", maxPages: 2 });
  assert.equal(urls.length, 2);
  assert.equal(out.listings.length, 2, "same two listings across both pages collapse to two");
  assert.equal(out.upcoming, 1);
  assert.equal(out.priced, 1);
  assert.equal(out.pages, 4);
});

test("collectBooliListings stops early on an empty page", async () => {
  const fetchNextData = async (url) =>
    /page=2/.test(url) ? pageWith([], { pages: 5 }) : pageWith([pricedRaw], { pages: 5 });
  const out = await collectBooliListings({ fetchNextData, areaId: "874649", maxPages: 5 });
  assert.equal(out.listings.length, 1);
});
