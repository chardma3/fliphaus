// Browser transport for Booli — the only network-facing half of the Booli
// integration (api/booli.js stays pure so it can be unit-tested).
//
// Why a browser at all: Booli is behind the same Cloudflare protection as Hemnet,
// and its GraphQL rejects ad-hoc queries (403 "Just a moment…") because its own
// client only sends *persisted* queries by hash. Two consequences shape this file:
//
//   1. Sold comps come from the server-rendered search page's `__NEXT_DATA__`
//      (fetchNextDataWith), not from a GraphQL call we compose ourselves.
//   2. Area lookup DOES work over GraphQL, because we replay Booli's own
//      persisted-query hash as a GET — but it must be fetched from inside the
//      page so it reuses the Cloudflare-cleared same-origin session.
//
// `page` is injected (a Puppeteer page from the scraper's proxied browser), so
// these helpers are exercisable with a fake page in tests.
const { BOOLI_BASE, buildAreaSuggestUrl, pickAreaSuggestion } = require("./booli");

const CHALLENGE_RE = /just a moment|attention required|cf-browser-verification|enable javascript/i;

function looksChallenged(text) {
  return CHALLENGE_RE.test(text || "");
}

// Land on Booli once so Cloudflare issues its clearance cookie for this session.
// Throws a named error on a challenge page — a silent fallthrough would otherwise
// look identical to "this area has no sold listings".
async function openBooliSession(page, { timeout = 45000 } = {}) {
  await page.goto(BOOLI_BASE, { waitUntil: "networkidle2", timeout });
  const title = await page.title();
  const body = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || "");
  if (looksChallenged(`${title}\n${body}`)) {
    const err = new Error(
      "Booli served a Cloudflare challenge — this exit IP is blocked. Retry for a fresh proxy IP (check HEMNET_PROXY_*)."
    );
    err.code = "BOOLI_CHALLENGED";
    throw err;
  }
  return { title };
}

// Read the parsed __NEXT_DATA__ out of a server-rendered Booli page.
function fetchNextDataWith(page, { timeout = 45000 } = {}) {
  return async function fetchNextData(url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    return page.evaluate(() => {
      const el = document.getElementById("__NEXT_DATA__");
      if (!el) return null;
      try {
        return JSON.parse(el.textContent);
      } catch {
        return null;
      }
    });
  };
}

// Resolve a district name to Booli's areaId via its own persisted area-suggestion
// query, fetched from the page context. Guards against Booli's worst failure mode:
// an unresolved name silently means areaId 77104 ("Sverige", 2.9M sold records),
// so returning null here must be treated as fatal by callers, never as "no data".
async function resolveAreaId(page, name, { municipality = "Stockholm" } = {}) {
  const url = buildAreaSuggestUrl(name);
  // Apollo Server's CSRF guard rejects a bare GET with 400 ("blocked as a
  // potential Cross-Site Request Forgery") unless it carries a content-type or an
  // x-apollo-operation-name header. Booli's own client sends the former; we send
  // both so a change to either side keeps working.
  const response = await page.evaluate(async (u, operationName) => {
    const res = await fetch(u, {
      headers: {
        accept: "application/graphql-response+json,application/json;q=0.9",
        "content-type": "application/json",
        "x-apollo-operation-name": operationName,
        "api-client": "booli.se",
      },
    });
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      return { status: res.status, json: null, textSample: text.slice(0, 200) };
    }
  }, url, "areaSuggestionSearch");

  if (!response || !response.json) return null;
  return pickAreaSuggestion(response.json, { name, municipality });
}

module.exports = {
  looksChallenged,
  openBooliSession,
  fetchNextDataWith,
  resolveAreaId,
};
