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

// Navigation budget. Through the residential proxy, Booli is far slower than it is
// from a home connection, so these are generous and env-tunable.
const NAV_TIMEOUT_MS = Math.max(5000, Number(process.env.BOOLI_NAV_TIMEOUT_MS) || 90000);
const NAV_ATTEMPTS = Math.max(1, Number(process.env.BOOLI_NAV_ATTEMPTS) || 3);
// How long to keep waiting for a Cloudflare interstitial to resolve itself.
const CHALLENGE_SETTLE_MS = Math.max(0, Number(process.env.BOOLI_CHALLENGE_SETTLE_MS) || 20000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// We only ever need the HTML (the embedded __NEXT_DATA__) — never the pictures.
// Dropping images/media/fonts/stylesheets is what makes this viable over a metered
// residential proxy: those bytes are the bulk of a Booli page, they're billed by
// the gigabyte, and waiting on them is what blew the old 45s navigation budget.
// Scripts and XHR are deliberately ALLOWED: Cloudflare's challenge needs JS to run.
async function installResourceBlocking(page) {
  if (typeof page.setRequestInterception !== "function") return false;
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = typeof req.resourceType === "function" ? req.resourceType() : "";
    if (["image", "media", "font", "stylesheet"].includes(type)) req.abort().catch(() => {});
    else req.continue().catch(() => {});
  });
  return true;
}

// Navigate with retries. A residential proxy pool is wildly uneven — one slow exit
// shouldn't end a harvest, and the next attempt usually draws a different IP.
async function gotoWithRetry(page, url, { timeout = NAV_TIMEOUT_MS, attempts = NAV_ATTEMPTS } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // domcontentloaded, NOT networkidle2: Booli keeps ad/analytics connections
      // open, so "network is quiet" may never arrive through a slow proxy — the
      // cause of the 45s timeouts. The HTML is all we need, and it's there at DCL.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(1500 * attempt);
    }
  }
  const err = new Error(`Booli navigation failed after ${attempts} attempt(s): ${lastErr && lastErr.message}`);
  err.code = "BOOLI_NAV_FAILED";
  throw err;
}

// Land on Booli once so Cloudflare issues its clearance cookie for this session.
// Throws a named error if the challenge never clears — a silent fallthrough would
// otherwise look identical to "this area has no sold listings".
async function openBooliSession(page, { timeout = NAV_TIMEOUT_MS, settleMs = CHALLENGE_SETTLE_MS } = {}) {
  await gotoWithRetry(page, BOOLI_BASE, { timeout });

  // Because we now stop at domcontentloaded, we can arrive DURING the interstitial.
  // Poll until it resolves itself (it redirects once its JS finishes) rather than
  // declaring a block that isn't one.
  const readState = async () => {
    const title = await page.title();
    const body = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || "");
    return { title, combined: `${title}\n${body}` };
  };

  let state = await readState();
  const deadline = Date.now() + settleMs;
  while (looksChallenged(state.combined) && Date.now() < deadline) {
    await sleep(1000);
    state = await readState();
  }

  if (looksChallenged(state.combined)) {
    const err = new Error(
      "Booli served a Cloudflare challenge that didn't clear — this exit IP is blocked. Retry for a fresh proxy IP (check HEMNET_PROXY_*)."
    );
    err.code = "BOOLI_CHALLENGED";
    throw err;
  }
  return { title: state.title };
}

// Read the parsed __NEXT_DATA__ out of a server-rendered Booli page.
function fetchNextDataWith(page, { timeout = NAV_TIMEOUT_MS, attempts = NAV_ATTEMPTS } = {}) {
  return async function fetchNextData(url) {
    await gotoWithRetry(page, url, { timeout, attempts });
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
  installResourceBlocking,
  gotoWithRetry,
  openBooliSession,
  fetchNextDataWith,
  resolveAreaId,
};
