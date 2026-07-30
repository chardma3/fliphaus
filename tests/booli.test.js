const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BOOLI_AREA_IDS,
  buildAreaSuggestUrl,
  pickAreaSuggestion,
  buildSoldSearchUrl,
  rawNum,
  parseDataPoints,
  normalizeBooliSold,
  harvestSoldPage,
  collectBooliSold,
} = require("../api/booli");

// A REAL Booli SoldProperty entity, captured verbatim from
// booli.se/sok/slutpriser?areaIds=874649&objectType=Lägenhet on 2026-07-29.
// Kept exact (including the Apollo argument-encoded field key) so a change in
// Booli's response shape breaks a test instead of silently yielding null comps.
const realRecord = {
  __typename: "SoldProperty",
  id: "6171318",
  booliId: "6171318",
  amenities: [{ __ref: 'Amenity:{"key":"elevator"}' }, { __ref: 'Amenity:{"key":"balcony"}' }],
  'images({"limit":5})': [],
  'displayAttributes({"queryContext":"SERP_LIST_LISTING"})': {
    __typename: "DisplayAttributes",
    screenReaderLabel: "2 rum lägenhet på Årstavägen 70 Årsta, Stockholms kommun",
    dataPoints: [
      { __typename: "DataPoint", value: { __typename: "DisplayText", plainText: "55 m²" } },
      { __typename: "DataPoint", value: { __typename: "DisplayText", plainText: "2 rum" } },
      { __typename: "DataPoint", value: { __typename: "DisplayText", plainText: "vån 5" } },
      { __typename: "DataPoint", value: { __typename: "DisplayText", plainText: "65 500 kr/m²" } },
    ],
  },
  soldPrice: { __typename: "FormattedValue", formatted: "3 600 000 kr", raw: 3600000, value: "3 600 000", unit: "kr" },
  streetAddress: "Årstavägen 70",
  soldPriceAbsoluteDiff: { __typename: "FormattedValue", formatted: "+205 000 kr" },
  soldPricePercentageDiff: { __typename: "FormattedValue", formatted: "+6%", raw: 6 },
  listPrice: { __typename: "FormattedValue", formatted: "3 395 000 kr" },
  objectType: "Lägenhet",
  descriptiveAreaName: "Årsta",
  location: { __typename: "Location", region: { __typename: "Region", municipalityName: "Stockholm" } },
  soldPriceType: "Slutpris",
  daysActive: 39,
  soldDate: "2026-07-27",
  latitude: 59.29828141,
  longitude: 18.04782648,
  url: "/annons/6171318",
  primaryImage: null,
};

function pageWith(records, { pages = 239, totalCount = 8336 } = {}) {
  const apollo = { ROOT_QUERY: { __typename: "Query" } };
  const refs = records.map((r) => {
    const key = `SoldProperty:${r.booliId}`;
    apollo[key] = r;
    return { __ref: key };
  });
  apollo.ROOT_QUERY[
    'searchSold({"input":{"areaId":"874649","ascending":false,"excludeAncestors":true,"facets":["upcomingSale"],"filters":[{"key":"objectType","value":"Lägenhet"}],"page":1,"sort":""}})'
  ] = { __typename: "SearchSoldResult", pages, totalCount, result: refs };
  return { props: { pageProps: { __APOLLO_STATE__: apollo } } };
}

test("rawNum unwraps { raw }, falls back to formatted, and parses strings", () => {
  assert.equal(rawNum({ raw: 72 }), 72);
  assert.equal(rawNum(72), 72);
  assert.equal(rawNum({ raw: 3450000, formatted: "3 450 000 kr" }), 3450000);
  // listPrice on the search projection has NO raw — the formatted fallback matters
  assert.equal(rawNum({ formatted: "3 395 000 kr" }), 3395000);
  assert.equal(rawNum("72 m²"), 72);
  assert.equal(rawNum(null), null);
  assert.equal(rawNum({ raw: null }), null);
});

test("parseDataPoints reads size, rooms, floor and sqm price from display strings", () => {
  const points = parseDataPoints(
    realRecord['displayAttributes({"queryContext":"SERP_LIST_LISTING"})'].dataPoints
  );
  // feeNum is null on sold rows: they carry kr/m², while for-sale rows carry kr/mån
  assert.deepEqual(points, { sizeNum: 55, rooms: 2, floor: 5, soldPriceSqm: 65500, feeNum: null });
});

test("parseDataPoints never reads plot area as living area", () => {
  // house rows carry "2 051 m² tomt" — mistaking it for boarea would wreck kr/m²
  const points = parseDataPoints([
    { value: { plainText: "2 051 m² tomt" } },
    { value: { plainText: "82 m²" } },
    { value: { plainText: "4 rum" } },
  ]);
  assert.equal(points.sizeNum, 82);
  assert.equal(points.rooms, 4);
});

test("normalizeBooliSold maps a real Booli record to our sold shape", () => {
  const r = normalizeBooliSold(realRecord, { area: "Årsta" });
  assert.equal(r.source, "booli");
  assert.equal(r.booliId, "6171318");
  assert.equal(r.streetAddress, "Årstavägen 70");
  assert.equal(r.soldPrice, 3600000);
  assert.equal(r.soldPriceSqm, 65500);
  assert.equal(r.soldDate, "2026-07-27");
  assert.equal(r.sizeNum, 55);
  assert.equal(r.size, "55 m²");
  assert.equal(r.rooms, "2 rum"); // our rooms-string convention
  assert.equal(r.floor, 5); // scored by the fingerprint matcher
  assert.equal(r.askingPriceNum, 3395000);
  assert.equal(r.priceChange, 6);
  assert.equal(r.daysOnMarket, 39);
  assert.equal(r.housingForm, "Lägenhet");
  assert.equal(r.area, "Årsta");
  assert.equal(r.locationDescription, "Årsta"); // real district, not catchment
  assert.equal(r.municipality, "Stockholm");
  assert.deepEqual(r.coordinates, { lat: 59.29828141, lng: 18.04782648 });
  assert.equal(r.link, "https://www.booli.se/annons/6171318"); // relative url absolutized
});

test("normalizeBooliSold derives kr/m² when the display string is absent", () => {
  const record = {
    ...realRecord,
    'displayAttributes({"queryContext":"SERP_LIST_LISTING"})': {
      dataPoints: [{ value: { plainText: "50 m²" } }],
    },
  };
  assert.equal(normalizeBooliSold(record).soldPriceSqm, 72000); // 3 600 000 / 50
});

test("normalizeBooliSold is null-safe for a sparse record", () => {
  const r = normalizeBooliSold({ booliId: 1, streetAddress: "X" });
  assert.equal(r.booliId, "1");
  assert.equal(r.soldPrice, null);
  assert.equal(r.sizeNum, null);
  assert.equal(r.rooms, null);
  assert.equal(r.floor, null);
  assert.equal(r.soldPriceSqm, null);
  assert.equal(r.coordinates, null);
  assert.equal(r.link, null);
  assert.equal(normalizeBooliSold(null), null);
});

test("buildSoldSearchUrl carries area, object type and page", () => {
  assert.equal(
    buildSoldSearchUrl({ areaId: "874649" }),
    "https://www.booli.se/sok/slutpriser?areaIds=874649&objectType=L%C3%A4genhet"
  );
  assert.match(buildSoldSearchUrl({ areaId: "874649", page: 3 }), /&page=3$/);
  // page 1 is the default — leaving it off keeps the canonical URL
  assert.equal(buildSoldSearchUrl({ areaId: "874649", page: 1 }).includes("page="), false);
});

test("harvestSoldPage resolves Apollo refs and reads pagination meta", () => {
  const out = harvestSoldPage(pageWith([realRecord]));
  assert.equal(out.pages, 239);
  assert.equal(out.totalCount, 8336);
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].streetAddress, "Årstavägen 70");
});

test("harvestSoldPage returns empty on a challenge/redesign page instead of throwing", () => {
  assert.deepEqual(harvestSoldPage(null), { pages: null, totalCount: null, records: [] });
  assert.deepEqual(harvestSoldPage({ props: {} }), { pages: null, totalCount: null, records: [] });
  assert.deepEqual(harvestSoldPage({ props: { pageProps: { __APOLLO_STATE__: { ROOT_QUERY: {} } } } }), {
    pages: null,
    totalCount: null,
    records: [],
  });
});

test("collectBooliSold pages through results and respects maxPages", async () => {
  const urls = [];
  const fetchNextData = async (url) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get("page") || 1);
    return pageWith([{ ...realRecord, booliId: `id-${page}` }], { pages: 3 });
  };
  const out = await collectBooliSold({ fetchNextData, areaId: "874649", area: "Årsta", maxPages: 2 });
  assert.equal(urls.length, 2); // stopped at maxPages, not all 3
  assert.equal(out.sold.length, 2);
  assert.equal(out.pages, 3);
  assert.equal(out.totalCount, 8336);
  assert.equal(out.sold[0].area, "Årsta");
});

test("collectBooliSold stops early on an empty page", async () => {
  const fetchNextData = async (url) => {
    const page = Number(new URL(url).searchParams.get("page") || 1);
    return page === 1 ? pageWith([realRecord], { pages: 5 }) : pageWith([], { pages: 5 });
  };
  const out = await collectBooliSold({ fetchNextData, areaId: "874649", maxPages: 5 });
  assert.equal(out.sold.length, 1);
});

test("collectBooliSold de-duplicates a record that shifts across pages", async () => {
  const fetchNextData = async () => pageWith([realRecord], { pages: 3 });
  const out = await collectBooliSold({ fetchNextData, areaId: "874649", maxPages: 3 });
  assert.equal(out.sold.length, 1);
});

test("pickAreaSuggestion picks the Stockholm district, not a same-named street elsewhere", () => {
  // trimmed from the real areaSuggestionSearch response for "årsta"
  const response = {
    data: {
      areaSuggestionSearch: {
        suggestions: [
          { type: "Street", id: "902555", displayName: "Årsta", parent: "Haninge" },
          { type: "locality", id: "386696", displayName: "Årsta", parent: "Uppsala" },
          { type: "locality", id: "874649", displayName: "Årsta", parent: "Stockholm" },
          { type: "userDefined", id: "936946", displayName: "Årsta Torg", parent: "Stockholm" },
        ],
      },
    },
  };
  const picked = pickAreaSuggestion(response, { name: "Årsta", municipality: "Stockholm" });
  assert.equal(picked.areaId, "874649");
  assert.equal(picked.type, "locality");
  assert.equal(pickAreaSuggestion(response, { name: "Nowhere" }), null);
});

test("verified Årsta areaId is pinned (77104 is Sverige — the silent-fallback trap)", () => {
  assert.equal(BOOLI_AREA_IDS["Årsta"], "874649");
  assert.match(buildAreaSuggestUrl("Årsta"), /operationName=areaSuggestionSearch/);
  assert.match(buildAreaSuggestUrl("Årsta"), /persistedQuery/);
});
