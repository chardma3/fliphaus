const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const SoldListing = require("../models/sold.model");

puppeteer.use(StealthPlugin());

const LOCATION_IDS = {
  Rissne: 473493,
  Farsta: 925962,
};

function buildSoldUrl(locationId) {
  return (
    `https://www.hemnet.se/salda/bostader?` +
    `location_ids[]=${locationId}&` +
    `item_types[]=bostadsratt&` +
    `sold_age=6m`
  );
}

async function scrapeSoldArea(page, areaName, locationId) {
  const url = buildSoldUrl(locationId);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  const listings = await page.evaluate(() => {
    const next = document.getElementById("__NEXT_DATA__");
    if (!next) return [];
    try {
      const apollo = JSON.parse(next.textContent).props.pageProps.__APOLLO_STATE__;
      return Object.values(apollo)
        .filter((v) => v.__typename === "SoldPropertyCard" || v.__typename === "SoldProperty")
        .map((v) => {
          const thumbKey = Object.keys(v).find((k) => k.startsWith("thumbnails") || k.startsWith("images"));
          const images = (thumbKey && Array.isArray(v[thumbKey])) ? v[thumbKey].filter(Boolean) : [];

          return {
            hemnetId: v.id || v.slug,
            slug: v.slug,
            streetAddress: v.streetAddress,
            locationDescription: v.locationDescription,
            rooms: v.rooms,
            size: v.livingAndSupplementalAreas || v.livingArea,
            askingPrice: v.askingPrice,
            soldPrice: v.soldPrice?.amount || v.sellingPrice?.amount || v.soldPrice || v.sellingPrice,
            soldPriceFormatted: v.formattedSoldPrice || v.formattedSellingPrice,
            priceChange: v.priceChangePercentage || v.priceDevelopment,
            soldDate: v.soldAt || v.soldDate,
            fee: v.fee,
            housingForm: v.housingForm?.name || null,
            buildYear: v.constructionYear || null,
            squareMeterPrice: v.squareMeterPrice || v.soldSquareMeterPrice,
            images,
          };
        })
        .filter((v) => v.soldPrice);
    } catch {
      return [];
    }
  });

  return listings.map((l) => ({ ...l, area: areaName }));
}

module.exports = async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const allSold = [];

  for (const [area, id] of Object.entries(LOCATION_IDS)) {
    try {
      console.log(`Scraping sold in ${area}...`);
      const listings = await scrapeSoldArea(page, area, id);
      allSold.push(...listings);
      console.log(`  → ${listings.length} sold listings`);
    } catch (err) {
      console.error(`  ✗ Failed ${area}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  await browser.close();

  // Upsert each sold listing
  let newCount = 0;
  for (const l of allSold) {
    const sizeNum = parseFloat((l.size || "").replace(",", ".").replace(/[^\d.]/g, "")) || 0;
    const askingNum = typeof l.askingPrice === "string" ? parseInt(l.askingPrice.replace(/\D/g, ""), 10) || 0 : (l.askingPrice || 0);
    const feeNum = l.fee ? (typeof l.fee === "string" ? parseInt(l.fee.replace(/\D/g, ""), 10) || 0 : l.fee) : 0;
    const soldPrice = typeof l.soldPrice === "string" ? parseInt(l.soldPrice.replace(/\D/g, ""), 10) : l.soldPrice;
    const soldPriceSqm = sizeNum > 0 ? Math.round(soldPrice / sizeNum) : (l.squareMeterPrice || 0);

    const update = {
      streetAddress: l.streetAddress,
      locationDescription: l.locationDescription,
      area: l.area,
      rooms: l.rooms,
      size: l.size,
      sizeNum,
      askingPrice: typeof l.askingPrice === "number" ? l.askingPrice.toLocaleString("sv-SE") + " kr" : l.askingPrice,
      askingPriceNum: askingNum,
      soldPrice,
      soldPriceSqm,
      priceChange: l.priceChange || (askingNum > 0 ? Math.round(((soldPrice - askingNum) / askingNum) * 100) : null),
      soldDate: l.soldDate ? new Date(typeof l.soldDate === "number" ? l.soldDate * 1000 : l.soldDate) : new Date(),
      housingForm: l.housingForm,
      fee: typeof l.fee === "number" ? l.fee + " kr/mån" : l.fee,
      feeNum,
      buildYear: l.buildYear,
      images: l.images || [],
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

  console.log(`✅ Sold scrape done: ${allSold.length} total, ${newCount} new`);
  return { total: allSold.length, new: newCount };
};
