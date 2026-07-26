// Booli as a second data source, focused (for now) on SOLD comps — the data that
// sharpens FlipHaus's renovated-resale estimate, the core of the ROI model.
//
// Booli's GraphQL (https://www.booli.se/graphql) sits behind the same Cloudflare
// bot-protection as Hemnet, so the actual POST must run through our residential
// proxy + browser context (see scripts/booli-arsta-pilot.js). To keep this module
// pure + unit-testable, the transport is INJECTED: callers pass a `post(query,
// variables)` that returns the GraphQL `data` object. This file owns the query,
// the field mapping, and pagination — the parts we can test without the network.
//
// Query shape confirmed from a working community client (searchSold with areaId /
// page / objectType filter / soldDate sort; numeric values wrapped as { raw }).
// The exact `result { … }` selection still needs one live run to confirm every
// field name — hence the defensive rawNum() below.
const { parseNumber } = require("./reconcile-sold");

const BOOLI_GRAPHQL = "https://www.booli.se/graphql";

// Booli wraps numbers as { raw, formatted }. Accept that, a plain number, or a
// formatted string ("72 m²", "3 450 000 kr").
function rawNum(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object") return rawNum(value.raw);
  return parseNumber(value);
}

const SOLD_QUERY = `query SearchSold($areaId: ID!, $page: Int!, $objectType: String!) {
  searchSold(input: { areaId: $areaId, page: $page, filters: [{ key: "objectType", value: $objectType }], sort: "soldDate" }) {
    pages
    result {
      booliId
      streetAddress
      soldPrice { raw }
      soldPriceSqm: soldSqmPrice { raw }
      soldDate
      livingArea { raw }
      rooms { raw }
      latitude
      longitude
      location { region { name } namedAreas }
      url
    }
  }
}`;

// One Booli sold record -> the shape our SoldListing store + fingerprint matcher
// use (mirrors api/scrape-sold.js fields). Numbers via rawNum so a { raw } wrap,
// a bare number, or a formatted string all work.
function normalizeBooliSold(r) {
  const lat = rawNum(r.latitude);
  const lng = rawNum(r.longitude);
  const rooms = rawNum(r.rooms);
  return {
    source: "booli",
    booliId: r.booliId != null ? String(r.booliId) : null,
    streetAddress: r.streetAddress || null,
    soldPrice: rawNum(r.soldPrice),
    soldPriceSqm: rawNum(r.soldPriceSqm),
    soldDate: r.soldDate || null,
    sizeNum: rawNum(r.livingArea),
    rooms: rooms != null ? `${rooms} rum` : null,
    coordinates: lat != null && lng != null ? { lat, lng } : null,
    locationDescription:
      (Array.isArray(r.location?.namedAreas) && r.location.namedAreas[0]) ||
      r.location?.region?.name ||
      null,
    url: r.url || null,
  };
}

// Page through searchSold for one area, normalizing as we go. `post(query, vars)`
// must return the GraphQL `data` object (or null). Bounded by maxPages so cost /
// runtime stay predictable. Stops early when a page is empty.
async function collectBooliSold({ post, areaId, objectType = "Lägenhet", maxPages = 5 }) {
  const out = [];
  let pages = 1;
  for (let page = 1; page <= Math.min(pages, maxPages); page++) {
    const data = await post(SOLD_QUERY, { areaId: String(areaId), page, objectType });
    const sold = data && data.searchSold;
    if (!sold) break;
    pages = sold.pages || pages;
    const result = sold.result || [];
    for (const r of result) out.push(normalizeBooliSold(r));
    if (!result.length) break;
  }
  return out;
}

module.exports = { BOOLI_GRAPHQL, SOLD_QUERY, rawNum, normalizeBooliSold, collectBooliSold };
