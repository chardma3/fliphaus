#!/usr/bin/env node
/**
 * Booli ÅRSTA verification harness (read-only, prints only — writes NOTHING).
 *
 * Booli's GraphQL is behind the same Cloudflare protection as Hemnet, so this
 * reuses the scraper's proxy + Puppeteer browser: navigate to booli.se to clear
 * the challenge, then POST the searchSold query FROM the page context (a plain
 * axios POST gets challenged; an in-page fetch reuses the cleared same-origin
 * session).
 *
 * Its job is to prove the transport works and DUMP a real sold response, so we
 * can confirm the exact result field names + Årsta's Booli areaId against
 * reality and then finalize api/booli.js. GraphQL field errors are printed
 * verbatim (they tell us precisely which names in SOLD_QUERY to fix).
 *
 * Run on Render (needs HEMNET_PROXY_* — same env as the scrape cron):
 *   node scripts/booli-arsta-pilot.js [areaId]
 *   BOOLI_AREA_ID=76401 node scripts/booli-arsta-pilot.js
 */
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { buildPuppeteerLaunchOptions, authenticateProxyPage, logProxyStatus } = require("../api/puppeteer-options");
const { SOLD_QUERY, normalizeBooliSold } = require("../api/booli");

puppeteer.use(StealthPlugin());

const BOOLI = "https://www.booli.se";

function looksChallenged(text) {
  return /just a moment|attention required|cf-browser-verification|enable javascript/i.test(text || "");
}

// POST a GraphQL query from the page context so it reuses the Cloudflare-cleared
// same-origin session. Returns { status, json, textSample }.
async function gql(page, query, variables) {
  return page.evaluate(
    async (q, v) => {
      const res = await fetch("/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, variables: v }),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* leave null */ }
      return { status: res.status, json, textSample: text.slice(0, 400) };
    },
    query,
    variables
  );
}

(async () => {
  logProxyStatus();
  const browser = await puppeteer.launch(buildPuppeteerLaunchOptions());
  const page = await browser.newPage();
  await authenticateProxyPage(page);
  await page.setViewport({ width: 1280, height: 800 });

  try {
    console.log(`\n▶ Navigating to ${BOOLI} to clear Cloudflare…`);
    await page.goto(BOOLI, { waitUntil: "networkidle2", timeout: 45000 });
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || "");
    console.log(`   title="${title}"`);
    if (looksChallenged(`${title}\n${bodyText}`)) {
      console.error("   ✗ Still on the Cloudflare challenge — this proxy exit was blocked. Re-run for a fresh IP (or check HEMNET_PROXY_*).");
      process.exit(2);
    }
    console.log("   ✓ Real page — Cloudflare cleared.");

    // Resolve Årsta's Booli areaId (explicit arg/env wins; else try the URL of a
    // sold-search and dump __NEXT_DATA__ so we can read the id + page shape).
    let areaId = process.argv[2] || process.env.BOOLI_AREA_ID || null;
    if (!areaId) {
      console.log("\n▶ No areaId given — resolving 'Årsta' from a sold-search page…");
      await page.goto(`${BOOLI}/sok/slutpriser?q=${encodeURIComponent("Årsta")}`, { waitUntil: "networkidle2", timeout: 45000 });
      console.log(`   landed on: ${page.url()}`);
      const m = page.url().match(/areaIds?[=\/](\d+)/i);
      if (m) { areaId = m[1]; console.log(`   ✓ areaId from URL: ${areaId}`); }
      const next = await page.evaluate(() => {
        const el = document.getElementById("__NEXT_DATA__");
        if (!el) return { hasNext: false };
        return { hasNext: true, sample: (el.textContent || "").slice(0, 1800) };
      });
      console.log(`   __NEXT_DATA__ present: ${next.hasNext}`);
      if (next.sample) console.log(`   __NEXT_DATA__ head: ${next.sample}`);
      await page.goto(BOOLI, { waitUntil: "domcontentloaded", timeout: 45000 });
    }
    if (!areaId) {
      console.error("\n✗ Could not resolve an areaId. Once we know Årsta's Booli id, pass it: node scripts/booli-arsta-pilot.js <areaId>");
      process.exit(3);
    }

    console.log(`\n▶ POST searchSold(areaId=${areaId}, page=1, objectType=Lägenhet)…`);
    const resp = await gql(page, SOLD_QUERY, { areaId: String(areaId), page: 1, objectType: "Lägenhet" });
    console.log(`   HTTP ${resp.status}`);
    if (!resp.json) {
      console.error(`   ✗ Non-JSON response (Cloudflare on /graphql?): ${resp.textSample}`);
      process.exit(4);
    }
    if (resp.json.errors) {
      console.error(`   ⚠ GraphQL errors — field names in SOLD_QUERY to fix:\n${JSON.stringify(resp.json.errors, null, 2)}`);
    }
    const sold = resp.json.data && resp.json.data.searchSold;
    if (!sold) {
      console.error(`   ✗ No searchSold in data: ${JSON.stringify(resp.json).slice(0, 800)}`);
      process.exit(5);
    }
    console.log(`   pages=${sold.pages}, page-1 result count=${(sold.result || []).length}`);
    const first = (sold.result || [])[0];
    console.log(`\n── RAW first sold record ──\n${JSON.stringify(first, null, 2)}`);
    console.log(`\n── NORMALIZED (api/booli.normalizeBooliSold) ──\n${JSON.stringify(first ? normalizeBooliSold(first) : null, null, 2)}`);
    console.log("\n✅ Harness done. Paste this output back: if the raw fields look right we wire the sold-comp merge next; if GraphQL listed field errors I'll fix SOLD_QUERY to match.");
  } catch (err) {
    console.error("Harness failed:", err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
