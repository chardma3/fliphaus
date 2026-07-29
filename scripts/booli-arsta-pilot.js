#!/usr/bin/env node
/**
 * Booli ÅRSTA verification harness (read-only, prints only — writes NOTHING).
 *
 * VERIFIED LIVE 2026-07-29. What the first run established, and why this script
 * now looks the way it does:
 *
 *  - `POST /graphql` with our own query is 403 + Cloudflare, even from a cleared
 *    page context. Booli's client only sends *persisted* queries (GET, sha256
 *    hash, `api-client: booli.se`), so composing our own query is not an option.
 *  - The sold search page is server-rendered and embeds the entire result set in
 *    `__NEXT_DATA__` → `__APOLLO_STATE__` as `SoldProperty` entities, with
 *    `objectType` + `page` honoured straight off the URL. That is the transport.
 *  - `?q=Årsta` is NOT resolved server-side: it silently falls back to areaId
 *    77104 = "Sverige" (2.9M sold records, villas in Norrtälje). Årsta,
 *    Stockholms kommun is areaId 874649 (8,336 sold apartments) and must come
 *    from Booli's areaSuggestionSearch — which is why an unresolved name is
 *    treated as fatal here rather than as an empty result.
 *
 * Re-run this whenever Booli redesigns: it re-resolves the areaId, re-harvests
 * page 1, and prints the raw + normalized record so a shape change is obvious.
 *
 * Run locally (a residential IP clears Cloudflare) or on Render (uses
 * HEMNET_PROXY_* like the scrape cron):
 *   node scripts/booli-arsta-pilot.js [areaId]
 *   BOOLI_AREA_ID=874649 node scripts/booli-arsta-pilot.js
 */
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const {
  buildPuppeteerLaunchOptions,
  authenticateProxyPage,
  logProxyStatus,
} = require("../api/puppeteer-options");
const { BOOLI_AREA_IDS, buildSoldSearchUrl, normalizeBooliSold, collectBooliSold } = require("../api/booli");
const { openBooliSession, fetchNextDataWith, resolveAreaId } = require("../api/booli-transport");

puppeteer.use(StealthPlugin());

const AREA = "Årsta";
const MAX_PAGES = Number(process.env.BOOLI_MAX_PAGES || 2);

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

(async () => {
  logProxyStatus();
  const browser = await puppeteer.launch(buildPuppeteerLaunchOptions());
  const page = await browser.newPage();
  await authenticateProxyPage(page);
  await page.setViewport({ width: 1280, height: 800 });

  try {
    console.log("\n▶ Opening a Booli session (clearing Cloudflare)…");
    const session = await openBooliSession(page);
    console.log(`   ✓ title="${session.title}"`);

    let areaId = process.argv[2] || process.env.BOOLI_AREA_ID || null;
    if (areaId) {
      console.log(`\n▶ Using areaId from argument/env: ${areaId}`);
    } else {
      console.log(`\n▶ Resolving "${AREA}" via areaSuggestionSearch…`);
      const picked = await resolveAreaId(page, AREA, { municipality: "Stockholm" });
      if (picked) {
        areaId = picked.areaId;
        console.log(`   ✓ ${picked.name} (${picked.type}) → areaId ${areaId}`);
        if (BOOLI_AREA_IDS[AREA] && BOOLI_AREA_IDS[AREA] !== areaId) {
          console.warn(
            `   ⚠ Booli now returns ${areaId} for ${AREA} but api/booli.js pins ${BOOLI_AREA_IDS[AREA]} — update BOOLI_AREA_IDS.`
          );
        }
      } else {
        areaId = BOOLI_AREA_IDS[AREA] || null;
        console.warn(
          `   ⚠ Suggestion lookup failed (persisted-query hash may have rotated) — falling back to the pinned id ${areaId}.`
        );
      }
    }
    if (!areaId) {
      console.error(`\n✗ No areaId for ${AREA}. Refusing to continue: an unresolved area silently means "Sverige" (77104).`);
      process.exit(3);
    }

    const url = buildSoldSearchUrl({ areaId, page: 1 });
    console.log(`\n▶ Harvesting sold apartments from ${url}`);
    const fetchNextData = fetchNextDataWith(page);
    const { sold, pages, totalCount } = await collectBooliSold({
      fetchNextData,
      areaId,
      area: AREA,
      maxPages: MAX_PAGES,
    });
    console.log(`   pages=${pages}, totalCount=${totalCount}, harvested=${sold.length} (maxPages=${MAX_PAGES})`);

    if (!sold.length) {
      console.error("   ✗ No records harvested — Booli's page shape may have changed (check __APOLLO_STATE__).");
      process.exit(5);
    }

    // Raw first record, so a field rename is visible rather than silent.
    const rawPage = await fetchNextData(url);
    const apollo = rawPage?.props?.pageProps?.__APOLLO_STATE__ || {};
    const firstRef = Object.keys(apollo).find((k) => k.startsWith("SoldProperty:"));
    console.log(`\n── RAW first sold record ──\n${JSON.stringify(apollo[firstRef], null, 2)}`);
    console.log(
      `\n── NORMALIZED ──\n${JSON.stringify(normalizeBooliSold(apollo[firstRef], { area: AREA }), null, 2)}`
    );

    // Sanity checks: wrong-area and wrong-type contamination are the failure modes
    // that would quietly poison the resale estimate, so assert on them explicitly.
    const offType = sold.filter((s) => s.housingForm && s.housingForm !== "Lägenhet");
    const offArea = sold.filter((s) => s.municipality && s.municipality !== "Stockholm");
    const missingPrice = sold.filter((s) => !s.soldPrice);
    const missingSize = sold.filter((s) => !s.sizeNum);
    console.log("\n── SANITY ──");
    console.log(`   non-Lägenhet rows: ${offType.length}`);
    console.log(`   non-Stockholm rows: ${offArea.length}`);
    console.log(`   missing soldPrice: ${missingPrice.length} | missing size: ${missingSize.length}`);
    console.log(`   districts: ${[...new Set(sold.map((s) => s.locationDescription))].join(", ")}`);
    console.log(`   median kr/m²: ${median(sold.map((s) => s.soldPriceSqm))}`);
    console.log(`   median sold price: ${median(sold.map((s) => s.soldPrice))}`);
    console.log(`   sold-date range: ${sold.map((s) => s.soldDate).sort()[0]} … ${sold.map((s) => s.soldDate).sort().slice(-1)[0]}`);

    const clean = !offType.length && !offArea.length && !missingPrice.length && !missingSize.length;
    console.log(
      clean
        ? "\n✅ Harness clean — transport + mapping verified. Next: merge these into the sold store (dedup vs Hemnet via api/listing-fingerprint.js)."
        : "\n⚠ Harness ran but flagged contamination above — fix the filter/mapping before merging into the sold store."
    );
  } catch (err) {
    console.error(`Harness failed${err.code ? ` [${err.code}]` : ""}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
