// Booli as a second data source, focused (for now) on SOLD comps — the data that
// sharpens FlipHaus's renovated-resale estimate, the core of the ROI model.
//
// TRANSPORT (verified live 2026-07-29, see scripts/booli-arsta-pilot.js):
// Booli's GraphQL does NOT accept ad-hoc queries. Its own client sends GET
// requests carrying an Apollo *persisted-query* sha256 hash plus an
// `api-client: booli.se` header; an arbitrary `POST /graphql` — even from a
// Cloudflare-cleared page context — comes back 403 with the "Just a moment…"
// challenge. What IS reachable is the same thing our Hemnet scraper already
// relies on: the search page is server-rendered and embeds the whole result set
// in `__NEXT_DATA__` → `props.pageProps.__APOLLO_STATE__`, as normalized
// `SoldProperty` entities. Filters and pagination are honoured from the URL
// (`?areaIds=…&objectType=Lägenhet&page=N`), so a plain page fetch per page is
// the entire API surface we need.
//
// To keep this module pure + unit-testable the transport is INJECTED: callers
// pass `fetchNextData(url)` returning the parsed `__NEXT_DATA__` object. This
// file owns URL construction, the Apollo-cache walk, the field mapping and
// pagination — the parts we can test without the network.
const { parseNumber } = require("./reconcile-sold");

const BOOLI_BASE = "https://www.booli.se";
const BOOLI_GRAPHQL = `${BOOLI_BASE}/graphql`;

// Booli resolves place names ONLY through this endpoint — there are no slug URLs
// (`/slutpriser/arsta` 404s) and the search page's `?q=` param is ignored
// server-side, silently falling back to areaId 77104 = "Sverige" (2.9M sold
// records). So an areaId must come from here, or from a hardcoded verified id.
// The hash is Booli's own persisted-query hash for areaSuggestionSearch; if Booli
// redeploys its client the hash rotates and this must be re-captured (the pilot
// script prints the live one).
const AREA_SUGGEST_HASH = "ae60b499ae7d33a7e96f69fcf2c40ca7b88275169aee38e8cc844c76e5544f2a";

// areaIds confirmed against live Booli responses. Årsta is the pilot area
// (8,336 sold apartments = a deep comp set to validate accuracy against Hemnet).
const BOOLI_AREA_IDS = {
  "Årsta": "874649",
};

function buildAreaSuggestUrl(search) {
  const params = new URLSearchParams({
    operationName: "areaSuggestionSearch",
    variables: JSON.stringify({ search: String(search || "").toLowerCase() }),
    extensions: JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: AREA_SUGGEST_HASH },
    }),
  });
  return `${BOOLI_GRAPHQL}?${params.toString()}`;
}

// Pick the areaId for a Stockholm district out of an areaSuggestionSearch
// response. Booli returns same-named areas in several kommuner ("Årsta" exists in
// Stockholm, Uppsala, Tierp, Haninge…), plus street-level hits — so require the
// kommun to match and prefer a district ("locality") over a street ("Street").
function pickAreaSuggestion(response, { name, municipality = "Stockholm" } = {}) {
  const suggestions = response?.data?.areaSuggestionSearch?.suggestions || [];
  const wanted = String(name || "").toLowerCase();
  const inKommun = suggestions.filter(
    (s) =>
      String(s.displayName || s.suggestion || "").toLowerCase() === wanted &&
      String(s.parent || "").toLowerCase() === String(municipality).toLowerCase()
  );
  const byRank = ["locality", "userDefined", "Street"];
  inKommun.sort((a, b) => {
    const ra = byRank.indexOf(a.type);
    const rb = byRank.indexOf(b.type);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
  });
  const best = inKommun[0];
  return best ? { areaId: String(best.id), name: best.displayName, type: best.type } : null;
}

function buildSoldSearchUrl({ areaId, objectType = "Lägenhet", page = 1 } = {}) {
  const params = new URLSearchParams({ areaIds: String(areaId) });
  if (objectType) params.set("objectType", objectType);
  if (page && page > 1) params.set("page", String(page));
  return `${BOOLI_BASE}/sok/slutpriser?${params.toString()}`;
}

// Booli wraps numbers as { raw, formatted, value }. Accept that, a plain number,
// or a formatted string ("72 m²", "3 450 000 kr"). Some fields (listPrice on the
// search projection) ship `formatted` with NO `raw`, hence the fallbacks.
function rawNum(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object") {
    if (value.raw != null) return rawNum(value.raw);
    if (value.formatted != null) return rawNum(value.formatted);
    if (value.value != null) return rawNum(value.value);
    return null;
  }
  return parseNumber(value);
}

// Size / rooms / floor / sqm-price aren't top-level fields on the search
// projection — they arrive as display strings ("55 m²", "2 rum", "vån 5",
// "65 500 kr/m²"). Order matters: match kr/m² before m², and skip "… m² tomt"
// (plot area on houses) so it can never be read as living area.
function parseDataPoints(dataPoints = []) {
  const out = { sizeNum: null, rooms: null, floor: null, soldPriceSqm: null, feeNum: null };
  for (const dp of dataPoints) {
    const text = (dp && dp.value && dp.value.plainText) || "";
    if (!text) continue;
    // For-sale rows carry the monthly BRF fee here ("4 594 kr/mån"); sold rows
    // carry kr/m² instead. Check the fee first — both contain "kr/".
    if (/kr\s*\/\s*m(å|a)n/i.test(text)) {
      if (out.feeNum == null) out.feeNum = parseNumber(text);
    } else if (/kr\s*\/\s*m²/i.test(text)) {
      if (out.soldPriceSqm == null) out.soldPriceSqm = parseNumber(text);
    } else if (/tomt/i.test(text)) {
      continue;
    } else if (/m²/i.test(text)) {
      if (out.sizeNum == null) out.sizeNum = parseNumber(text);
    } else if (/\brum\b/i.test(text)) {
      if (out.rooms == null) out.rooms = parseNumber(text);
    } else if (/^\s*vån/i.test(text)) {
      if (out.floor == null) out.floor = parseNumber(text);
    }
  }
  return out;
}

// The Apollo cache stores field arguments in the key, so the display-attributes
// field arrives as `displayAttributes({"queryContext":"SERP_LIST_LISTING"})`.
// Match by prefix so a change of queryContext doesn't silently drop size/rooms.
function displayAttributesOf(record) {
  if (!record || typeof record !== "object") return null;
  const key = Object.keys(record).find((k) => k.startsWith("displayAttributes"));
  return key ? record[key] : null;
}

// One Booli SoldProperty -> the shape our SoldListing store + fingerprint matcher
// use (mirrors api/scrape-sold.js fields, plus `floor`/`coordinates` which
// api/listing-fingerprint.js scores on).
function normalizeBooliSold(r, { area = null } = {}) {
  if (!r) return null;
  const lat = rawNum(r.latitude);
  const lng = rawNum(r.longitude);
  const points = parseDataPoints(displayAttributesOf(r)?.dataPoints || []);
  const soldPrice = rawNum(r.soldPrice);
  const sizeNum = points.sizeNum;
  const soldPriceSqm =
    points.soldPriceSqm != null
      ? points.soldPriceSqm
      : soldPrice != null && sizeNum > 0
      ? Math.round(soldPrice / sizeNum)
      : null;
  const askingPriceNum = rawNum(r.listPrice);

  return {
    source: "booli",
    booliId: r.booliId != null ? String(r.booliId) : r.id != null ? String(r.id) : null,
    streetAddress: r.streetAddress || null,
    // Booli's descriptiveAreaName is the real district (Årsta, Årstadal…), the
    // same distinction the Hemnet side draws between catchment and district.
    locationDescription: r.descriptiveAreaName || r.location?.region?.municipalityName || null,
    area,
    rooms: points.rooms != null ? `${points.rooms} rum` : null,
    size: sizeNum != null ? `${sizeNum} m²` : null,
    sizeNum,
    floor: points.floor,
    askingPrice: r.listPrice?.formatted || null,
    askingPriceNum,
    soldPrice,
    soldPriceSqm,
    priceChange: rawNum(r.soldPricePercentageDiff),
    soldDate: r.soldDate || null,
    daysOnMarket: rawNum(r.daysActive),
    housingForm: r.objectType || null,
    municipality: r.location?.region?.municipalityName || null,
    coordinates: lat != null && lng != null ? { lat, lng } : null,
    link: r.url ? `${BOOLI_BASE}${r.url}` : null,
  };
}

// Walk one server-rendered sold-search page: resolve the searchSold result refs
// against the Apollo cache and hand back the raw records + pagination meta.
function harvestSoldPage(nextData) {
  const apollo = nextData?.props?.pageProps?.__APOLLO_STATE__;
  if (!apollo) return { pages: null, totalCount: null, records: [] };
  const root = apollo.ROOT_QUERY || {};
  const key = Object.keys(root).find((k) => k.startsWith("searchSold"));
  const result = key ? root[key] : null;
  if (!result) return { pages: null, totalCount: null, records: [] };

  const records = (result.result || [])
    .map((ref) => (ref && ref.__ref ? apollo[ref.__ref] : ref))
    .filter(Boolean);
  return {
    pages: result.pages != null ? Number(result.pages) : null,
    totalCount: result.totalCount != null ? Number(result.totalCount) : null,
    records,
  };
}

// Page through an area's sold apartments, normalizing as we go.
// `fetchNextData(url)` must return the page's parsed `__NEXT_DATA__` (or null).
// Bounded by maxPages so cost/runtime stay predictable; stops on an empty page.
// De-duplicates by booliId, since a sale that shifts pages between requests can
// otherwise be harvested twice.
async function collectBooliSold({
  fetchNextData,
  areaId,
  area = null,
  objectType = "Lägenhet",
  maxPages = 5,
} = {}) {
  const out = [];
  const seen = new Set();
  let pages = 1;
  let totalCount = null;

  for (let page = 1; page <= Math.min(pages, maxPages); page++) {
    const nextData = await fetchNextData(buildSoldSearchUrl({ areaId, objectType, page }));
    const harvested = harvestSoldPage(nextData);
    if (harvested.pages != null) pages = harvested.pages;
    if (harvested.totalCount != null && totalCount == null) totalCount = harvested.totalCount;
    if (!harvested.records.length) break;

    for (const raw of harvested.records) {
      const record = normalizeBooliSold(raw, { area });
      if (!record) continue;
      if (record.booliId) {
        if (seen.has(record.booliId)) continue;
        seen.add(record.booliId);
      }
      out.push(record);
    }
  }

  return { sold: out, pages, totalCount };
}

module.exports = {
  BOOLI_BASE,
  BOOLI_GRAPHQL,
  BOOLI_AREA_IDS,
  AREA_SUGGEST_HASH,
  buildAreaSuggestUrl,
  pickAreaSuggestion,
  buildSoldSearchUrl,
  rawNum,
  parseDataPoints,
  displayAttributesOf,
  normalizeBooliSold,
  harvestSoldPage,
  collectBooliSold,
};
