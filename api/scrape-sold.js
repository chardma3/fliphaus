const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const SoldListing = require("../models/sold.model");
const Listing = require("./listing.model");
const { reconcileSoldListings } = require("./reconcile-sold");
const { analyzeListingImages } = require("./analyze");
const { assertHemnetPageUsable, resolveSoldScrapeTargets, isHemnetSafetyError } = require("./hemnet-refresh-safety");
const { buildPuppeteerLaunchOptions, authenticateProxyPage, logProxyStatus } = require("./puppeteer-options");

puppeteer.use(StealthPlugin());

function buildSoldUrl(locationId, page = 1) {
  const base =
    `https://www.hemnet.se/salda/bostader?` +
    `location_ids[]=${locationId}&` +
    `item_types[]=bostadsratt&` +
    `sold_age=12m`;
  return page > 1 ? `${base}&page=${page}` : base;
}

// Hemnet paginates sold results at ~50 per page. Without walking the pages we
// only ever captured the ~50 most-recent sales per area, so most sold units
// never landed in the DB and reconciliation had nothing to match. Cap the depth
// so the workflow stays within its request budget; override via env if needed.
const SOLD_MAX_PAGES = Math.max(1, Number(process.env.SOLD_SCRAPE_MAX_PAGES) || 20);

function parsePrice(str) {
  if (!str) return 0;
  if (typeof str === "number") return str;
  return parseInt(str.replace(/\D/g, ""), 10) || 0;
}

function parsePriceChange(str) {
  if (!str) return null;
  if (typeof str === "number") return str;
  const match = str.match(/([+-]?\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function conditionLabelFromScore(score) {
  if (score == null) return "unknown";
  if (score <= 3) return "renovated";
  if (score >= 7) return "unrenovated";
  return "partly_renovated";
}

async function scrapeSoldDetail(page, slug) {
  if (!slug) return null;
  try {
    await page.goto(`https://www.hemnet.se/salda/${slug}`, { waitUntil: "networkidle2", timeout: 30000 });
    const pageState = await page.evaluate(() => ({
      hasNextData: Boolean(document.getElementById("__NEXT_DATA__")),
      html: `${document.title || ""}\n${document.body?.innerText || ""}`,
    }));
    assertHemnetPageUsable({
      ...pageState,
      url: `https://www.hemnet.se/salda/${slug}`,
      areaName: slug,
      dataset: "sold detail",
    });
    return await page.evaluate(() => {
      const next = document.getElementById("__NEXT_DATA__");
      if (!next) return null;
      try {
        const apollo = JSON.parse(next.textContent).props.pageProps.__APOLLO_STATE__;
        const values = Object.values(apollo);
        const listing = values.find((v) => v.__typename === "SoldProperty" || v.__typename === "Sale" || v.__typename === "Listing") || {};
        const association = values.find((v) => v.__typename === "HousingCooperative" || v.__typename === "Association");
        const imageUrls = values
          .filter((v) => v.__typename === "Image" || v.filename)
          .map((v) => v.url || v.fullscreenUrl || (v.filename ? `https://bilder.hemnet.se/images/itemgallery_cut/${v.filename}` : null))
          .filter(Boolean);
        const descText = (listing.description || "").toLowerCase();
        const yearMatch = descText.match(/stambyte[^\d]*(19\d{2}|20\d{2})/i);
        let stambyteStatus = null;
        if (/stambyte.*(gjord|klar|genomförd|utförd|20\d{2}|19\d{2})/i.test(descText)) stambyteStatus = "done";
        else if (/stambyte.*(planerad|kommande|snart)/i.test(descText)) stambyteStatus = "planned";

        return {
          images: [...new Set(imageUrls)],
          brfName: association?.name || listing.housingCooperativeName || null,
          buildYear: listing.constructionYear || listing.buildYear || null,
          stambyteYear: yearMatch ? parseInt(yearMatch[1], 10) : null,
          stambyteStatus,
          description: listing.description || null,
        };
      } catch {
        return null;
      }
    });
  } catch (err) {
    console.error(`  ✗ Sold detail failed for ${slug}: ${err.message}`);
    return null;
  }
}

async function scrapeSoldPage(page, areaName, locationId, pageNum) {
  const url = buildSoldUrl(locationId, pageNum);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  const pageState = await page.evaluate(() => ({
    hasNextData: Boolean(document.getElementById("__NEXT_DATA__")),
    html: `${document.title || ""}\n${document.body?.innerText || ""}`,
  }));
  assertHemnetPageUsable({ ...pageState, url, areaName, dataset: "sold listings" });

  return page.evaluate(() => {
    const next = document.getElementById("__NEXT_DATA__");
    if (!next) return [];
    try {
      const apollo = JSON.parse(next.textContent).props.pageProps.__APOLLO_STATE__;
      return Object.values(apollo)
        .filter((v) => v.__typename === "SaleCard")
        .map((v) => {
          const thumbKey = Object.keys(v).find((k) => k.startsWith("thumbnail") && k.includes("ITEMGALLERY"));
          const thumbnail = thumbKey ? v[thumbKey] : null;
          const imgUrl = v.image?.filename
            ? `https://bilder.hemnet.se/images/itemgallery_cut/${v.image.filename}`
            : (typeof thumbnail === "string" ? thumbnail : null);

          return {
            hemnetId: v.id,
            slug: v.slug,
            streetAddress: v.streetAddress,
            locationDescription: v.locationDescription,
            rooms: v.rooms,
            size: v.livingArea,
            askingPrice: v.askingPrice,
            finalPrice: v.finalPrice,
            priceChange: v.priceChange,
            soldAt: v.soldAt,
            fee: v.fee,
            housingForm: v.housingForm?.name || null,
            squareMeterPrice: v.squareMeterPrice,
            image: imgUrl,
          };
        })
        .filter((v) => v.finalPrice);
    } catch {
      return [];
    }
  });
}

async function scrapeSoldArea(page, areaName, locationId, maxPages = SOLD_MAX_PAGES) {
  const collected = [];
  const seen = new Set();

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    // Retry transient page failures (slow/flaky residential proxy, occasional
    // missing __NEXT_DATA__) before giving up — mirrors the active scrape's
    // per-area retry. A page that still fails stops pagination but keeps
    // everything collected so far; partial sold data is fine (unlike the active
    // scrape, sold data never drives "disappeared" marking).
    let pageListings = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        pageListings = await scrapeSoldPage(page, areaName, locationId, pageNum);
        break;
      } catch (err) {
        console.error(`  ✗ ${areaName} sold page ${pageNum} (attempt ${attempt}/2): ${err.message}`);
      }
    }
    if (pageListings === null) break; // page failed after retries
    if (!pageListings.length) break; // past the last page of results

    let added = 0;
    for (const l of pageListings) {
      if (l.hemnetId && !seen.has(l.hemnetId)) {
        seen.add(l.hemnetId);
        collected.push(l);
        added += 1;
      }
    }
    console.log(`  ${areaName} sold page ${pageNum}: +${added} new (total ${collected.length})`);
    // No new ids on a full page means we've looped back to known results — stop.
    if (added === 0) break;
  }

  return collected.map((l) => ({ ...l, area: areaName }));
}

module.exports = async (options = {}) => {
  const targets = resolveSoldScrapeTargets({ area: options.area });
  const detailLimit = Number.isFinite(Number(options.detailLimit)) ? Math.max(0, Number(options.detailLimit)) : 20;
  const includeDetails = options.includeDetails !== false;
  const includeAnalysis = options.includeAnalysis !== false;

  logProxyStatus();
  const browser = await puppeteer.launch(buildPuppeteerLaunchOptions());

  const page = await browser.newPage();
  await authenticateProxyPage(page);
  await page.setViewport({ width: 1280, height: 800 });

  const allSold = [];

  for (const { area, locationId } of targets) {
    try {
      console.log(`Scraping sold in ${area}...`);
      const listings = await scrapeSoldArea(page, area, locationId);
      allSold.push(...listings);
      console.log(`  → ${listings.length} sold listings`);
    } catch (err) {
      if (isHemnetSafetyError(err)) {
        await browser.close();
        throw err;
      }
      console.error(`  ✗ Failed ${area}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (includeDetails && detailLimit > 0) {
    for (const listing of allSold.slice(0, detailLimit)) {
      const detail = await scrapeSoldDetail(page, listing.slug);
      if (detail) Object.assign(listing, detail);
      await new Promise((r) => setTimeout(r, 500));
    }
    if (allSold.length > detailLimit) {
      console.log(`  ⏱ Detail scrape capped at ${detailLimit}/${allSold.length} sold listings for this request`);
    }
  }

  await browser.close();

  let newCount = 0;
  for (const l of allSold) {
    const sizeNum = parseFloat((l.size || "").replace(",", ".").replace(/[^\d.]/g, "")) || 0;
    const askingNum = parsePrice(l.askingPrice);
    const soldPrice = parsePrice(l.finalPrice);
    const feeNum = parsePrice(l.fee);
    const soldPriceSqm = l.squareMeterPrice ? parsePrice(l.squareMeterPrice) : (sizeNum > 0 ? Math.round(soldPrice / sizeNum) : 0);
    const priceChange = parsePriceChange(l.priceChange);
    const soldDate = l.soldAt ? new Date(parseFloat(l.soldAt) * 1000) : new Date();
    const existing = await SoldListing.findOne({ hemnetId: l.hemnetId }).lean();
    const images = l.images?.length ? l.images : (l.image ? [l.image] : []);
    let analysis = null;
    if (existing?.renovationScore != null) {
      analysis = {
        renovationScore: existing.renovationScore,
        confidence: existing.renovationConfidence,
        summary: existing.renovationSummary,
        rooms: existing.renovationRooms,
      };
    } else if (includeAnalysis && images.length) {
      analysis = await analyzeListingImages(images, {
        size: l.size,
        rooms: l.rooms,
        askingPrice: l.askingPrice,
      });
    }

    const update = {
      streetAddress: l.streetAddress,
      locationDescription: l.locationDescription,
      area: l.area,
      rooms: l.rooms,
      size: l.size,
      sizeNum,
      askingPrice: l.askingPrice,
      askingPriceNum: askingNum,
      soldPrice,
      soldPriceSqm,
      priceChange,
      soldDate,
      housingForm: l.housingForm,
      fee: l.fee,
      feeNum,
      buildYear: l.buildYear || null,
      brfName: l.brfName || null,
      stambyteYear: l.stambyteYear || null,
      stambyteStatus: l.stambyteStatus || null,
      renovationScore: analysis?.renovationScore ?? null,
      renovationConfidence: analysis?.confidence ?? null,
      renovationSummary: analysis?.summary ?? null,
      renovationRooms: analysis?.rooms ?? null,
      conditionLabel: existing?.conditionLabel || conditionLabelFromScore(analysis?.renovationScore),
      images,
      link: l.slug ? `https://www.hemnet.se/salda/${l.slug}` : null,
      scrapedAt: new Date(),
    };

    const result = await SoldListing.findOneAndUpdate(
      { hemnetId: l.hemnetId },
      update,
      { upsert: true, new: true, rawResult: true }
    );
    if (result.lastErrorObject?.upserted) newCount++;
  }

  const reconciliation = await reconcileSoldListings({ Listing, SoldListing });

  console.log(`✅ Sold scrape done: ${allSold.length} total, ${newCount} new, ${reconciliation.confirmed} confirmed matches`);
  return {
    total: allSold.length,
    new: newCount,
    areas: targets.map((target) => target.area),
    detailLimit,
    detailsScraped: includeDetails ? Math.min(allSold.length, detailLimit) : 0,
    analysisEnabled: includeAnalysis,
    reconciled: reconciliation,
  };
};
