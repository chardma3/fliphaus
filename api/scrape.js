const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const Listing = require("./listing.model");
const { analyzeListingImages } = require("./analyze");

puppeteer.use(StealthPlugin());

const LOCATION_IDS = {
  Bromma: 898740,
  Blackeberg: 473450,
  Rissne: 473493,
  Kista: 925951,
  Sollentuna: 18027,
  Skarpnäck: 898478,
  Bagarmossen: 473340,
  Farsta: 925962,
  Enskede: 925961,
  Hökarängen: 473375,
};

const MAX_PRICE = 4000000;

function buildUrl(locationId) {
  return (
    `https://www.hemnet.se/bostader?` +
    `location_ids[]=${locationId}&` +
    `max_price=${MAX_PRICE}&` +
    `item_types[]=bostadsratt&item_types[]=villa&item_types[]=radhus&item_types[]=tomt&` +
    `sort=newest`
  );
}

function parseAskingPrice(str) {
  if (!str) return null;
  return parseInt(str.replace(/\D/g, ""), 10) || null;
}

async function scrapeArea(page, areaName, locationId) {
  const url = buildUrl(locationId);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  const listings = await page.evaluate(() => {
    const next = document.getElementById("__NEXT_DATA__");
    if (!next) return [];
    const apollo = JSON.parse(next.textContent).props.pageProps.__APOLLO_STATE__;

    return Object.values(apollo)
      .filter((v) => v.__typename === "ListingCard" && v.askingPrice)
      .map((v) => {
        // thumbnails({"format":"ITEMGALLERY_CUT"}) contains direct URL strings
        const thumbKey = Object.keys(v).find((k) => k.startsWith("thumbnails"));
        const images = (thumbKey && Array.isArray(v[thumbKey])) ? v[thumbKey].filter(Boolean) : [];

        return {
          id: v.id,
          slug: v.slug,
          streetAddress: v.streetAddress,
          locationDescription: v.locationDescription,
          housingForm: v.housingForm?.name || null,
          rooms: v.rooms,
          size: v.livingAndSupplementalAreas,
          askingPrice: v.askingPrice,
          fee: v.fee,
          floor: v.floor,
          squareMeterPrice: v.squareMeterPrice,
          brokerAgencyName: v.brokerAgencyName,
          description: v.description,
          nextShowing: v.showings?.[0] || null,
          images,
          thumbnail: images[0] || null,
          lat: v.coordinates?.lat || null,
          lng: v.coordinates?.long || null,
          publishedAt: v.publishedAt,
        };
      });
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

  const allListings = [];

  for (const [area, id] of Object.entries(LOCATION_IDS)) {
    try {
      console.log(`Scraping ${area}...`);
      const listings = await scrapeArea(page, area, id);
      allListings.push(...listings);
      console.log(`  → ${listings.length} listings`);
    } catch (err) {
      console.error(`  ✗ Failed ${area}:`, err.message);
    }
  }

  const scrapeDate = new Date().toLocaleDateString("sv-SE");

  // Deduplicate by id
  const seen = new Set();
  const unique = allListings.filter((l) => {
    if (seen.has(l.id)) return false;
    seen.add(l.id);
    return true;
  });

  // Visit each detail page to get all images + floor plan status + AI analysis
  console.log(`Fetching detail pages & analysing ${unique.length} listings...`);
  for (let i = 0; i < unique.length; i++) {
    const l = unique[i];
    try {
      await page.goto(`https://www.hemnet.se/bostad/${l.slug}`, { waitUntil: "networkidle2", timeout: 20000 });
      const detail = await page.evaluate(() => {
        try {
          const apollo = JSON.parse(document.getElementById("__NEXT_DATA__").textContent).props.pageProps.__APOLLO_STATE__;
          const listing = Object.values(apollo).find((v) => v.__typename === "ActivePropertyListing");
          if (!listing) return null;
          const imgKey = Object.keys(listing).find((k) => k.startsWith("images") && k.includes("300"));
          const allImages = (imgKey && listing[imgKey]?.images || []).map((img) => {
            const urlKey = Object.keys(img).find((k) => k.startsWith("url"));
            return urlKey ? img[urlKey] : null;
          }).filter(Boolean);
          const hasFloorPlan = (listing.floorPlanImages || []).length > 0;
          return { allImages, hasFloorPlan };
        } catch { return null; }
      });
      if (detail) {
        if (detail.allImages.length > 0) l.images = detail.allImages;
        l.hasFloorPlan = detail.hasFloorPlan;
      }
    } catch { /* keep search-page images */ }

    // AI renovation analysis (runs in parallel with next page load conceptually)
    if (l.images && l.images.length > 0) {
      try {
        const analysis = await analyzeListingImages(l.images, {
          size: l.size,
          rooms: l.rooms,
          askingPrice: l.askingPrice,
        });
        if (analysis) {
          l.renovationScore = analysis.renovationScore;
          l.renovationConfidence = analysis.confidence;
          l.renovationSummary = analysis.summary;
          l.renovationRooms = analysis.rooms;
          l.totalEstimatedCostSEK = analysis.totalEstimatedCostSEK;
          l.investmentPotential = analysis.investmentPotential;
          l.analyzedAt = new Date();
          console.log(`  ✓ ${l.streetAddress}: score ${analysis.renovationScore}/10 — ${analysis.investmentPotential}`);
        }
      } catch (err) {
        console.error(`  ✗ Analysis error for ${l.streetAddress}:`, err.message);
      }
    }

    if ((i + 1) % 20 === 0) console.log(`  ${i + 1} / ${unique.length}`);
  }

  await browser.close();

  // Upsert each listing
  for (const l of unique) {
    const update = {
      ...l,
      askingPriceNum: parseAskingPrice(l.askingPrice),
      coordinates: l.lat ? { lat: l.lat, lng: l.lng } : undefined,
      link: `https://www.hemnet.se/bostad/${l.slug}`,
      images: l.images || [],
      publishedAt: l.publishedAt ? new Date(parseFloat(l.publishedAt) * 1000) : undefined,
      scrapeDate,
    };
    if (l.hasFloorPlan !== undefined) update.hasFloorPlan = l.hasFloorPlan;
    if (l.renovationScore != null) {
      update.renovationScore = l.renovationScore;
      update.renovationConfidence = l.renovationConfidence;
      update.renovationSummary = l.renovationSummary;
      update.renovationRooms = l.renovationRooms;
      update.totalEstimatedCostSEK = l.totalEstimatedCostSEK;
      update.investmentPotential = l.investmentPotential;
      update.analyzedAt = l.analyzedAt;
    }
    await Listing.findOneAndUpdate({ id: l.id }, update, { upsert: true, new: true });
  }

  // Remove listings no longer on Hemnet (not seen in last scrape)
  const currentIds = unique.map((l) => l.id);
  await Listing.deleteMany({ id: { $nin: currentIds } });

  return { total: unique.length, scrapeDate };
};
