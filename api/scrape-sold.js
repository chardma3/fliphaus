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

async function scrapeSoldArea(page, areaName, locationId) {
  const url = buildSoldUrl(locationId);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  const listings = await page.evaluate(() => {
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

  let newCount = 0;
  for (const l of allSold) {
    const sizeNum = parseFloat((l.size || "").replace(",", ".").replace(/[^\d.]/g, "")) || 0;
    const askingNum = parsePrice(l.askingPrice);
    const soldPrice = parsePrice(l.finalPrice);
    const feeNum = parsePrice(l.fee);
    const soldPriceSqm = l.squareMeterPrice ? parsePrice(l.squareMeterPrice) : (sizeNum > 0 ? Math.round(soldPrice / sizeNum) : 0);
    const priceChange = parsePriceChange(l.priceChange);
    const soldDate = l.soldAt ? new Date(parseFloat(l.soldAt) * 1000) : new Date();

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
      images: l.image ? [l.image] : [],
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
