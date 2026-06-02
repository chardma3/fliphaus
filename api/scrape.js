const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const Listing = require("./listing.model");
const { LOCATION_IDS, assertHemnetPageUsable, assertNonEmptyRefreshResult, planDisappearanceReconciliation, isHemnetSafetyError } = require("./hemnet-refresh-safety");
const { buildPuppeteerLaunchOptions, authenticateProxyPage, logProxyStatus } = require("./puppeteer-options");
const { buildActiveScrapeOptions } = require("./scrape-options");

puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TRANSIT_INFO = {
  Rissne: { minutes: 15, station: "Rissne", line: "Blue line (T-bana)" },
  Sundbyberg: { minutes: 12, station: "Sundbybergs centrum", line: "Blue line (T-bana)" },
  Farsta: { minutes: 18, station: "Farsta strand", line: "Green line (T-bana)" },
  Tallkrogen: { minutes: 16, station: "Tallkrogen", line: "Green line (T-bana)" },
  Hökarängen: { minutes: 15, station: "Hökarängen", line: "Green line (T-bana)" },
  Sköndal: { minutes: 20, station: "Farsta strand", line: "Green line (T-bana)" },
  Bromma: { minutes: 20, station: "Abrahamsberg", line: "Green line (T-bana)" },
  Blackeberg: { minutes: 18, station: "Blackeberg", line: "Green line (T-bana)" },
  Kista: { minutes: 20, station: "Kista", line: "Blue line (T-bana)" },
  Sollentuna: { minutes: 20, station: "Sollentuna", line: "Pendeltåg" },
  Skarpnäck: { minutes: 15, station: "Skarpnäck", line: "Green line (T-bana)" },
  Bagarmossen: { minutes: 14, station: "Bagarmossen", line: "Green line (T-bana)" },
  Enskede: { minutes: 12, station: "Enskede Gård", line: "Green line (T-bana)" },
};

function getTransitForLocation(locationDesc) {
  if (!locationDesc) return null;
  for (const [area, info] of Object.entries(TRANSIT_INFO)) {
    if (locationDesc.toLowerCase().includes(area.toLowerCase())) return info;
  }
  return null;
}

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

  const pageState = await page.evaluate(() => ({
    hasNextData: Boolean(document.getElementById("__NEXT_DATA__")),
    html: `${document.title || ""}\n${document.body?.innerText || ""}`,
  }));
  assertHemnetPageUsable({ ...pageState, url, areaName, dataset: "active listings" });

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

  return listings.map((l) => {
    const transit = getTransitForLocation(l.locationDescription) || TRANSIT_INFO[areaName];
    return {
      ...l,
      area: areaName,
      transitMinutes: transit?.minutes || null,
      nearestStation: transit?.station || null,
      transitLine: transit?.line || null,
    };
  });
}

module.exports = async (options = {}) => {
  const { includeDetails } = buildActiveScrapeOptions(options);
  logProxyStatus();
  const browser = await puppeteer.launch(buildPuppeteerLaunchOptions());

  const page = await browser.newPage();
  await authenticateProxyPage(page);
  await page.setViewport({ width: 1280, height: 800 });

  const allListings = [];
  const scrapedAreas = [];
  const failedAreas = [];

  // The residential proxy pool is mixed: some exits are datacenter IPs that
  // Hemnet blocks with Cloudflare bot-protection, and the provider can't
  // guarantee a residential IP per request. Each new request rotates to a fresh
  // exit, so a block is usually cleared by simply retrying (drawing a new,
  // hopefully residential, IP). So retry generously on ANY error — including
  // bot-protection — with a short pause between attempts to let the proxy hand
  // out a new exit. If an area is STILL blocked after all attempts it's left in
  // failedAreas, and the partial-scrape guard skips disappearance reconciliation
  // so a persistent block can never mark listings disappeared. A total block
  // (every area failed → zero listings) is caught by assertNonEmptyRefreshResult.
  const MAX_AREA_ATTEMPTS = Math.max(1, Number(process.env.SCRAPE_MAX_AREA_ATTEMPTS) || 6);

  for (const [area, id] of Object.entries(LOCATION_IDS)) {
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_AREA_ATTEMPTS; attempt++) {
      try {
        console.log(`Scraping ${area}${attempt > 1 ? ` (attempt ${attempt}/${MAX_AREA_ATTEMPTS})` : ""}...`);
        const listings = await scrapeArea(page, area, id);
        allListings.push(...listings);
        scrapedAreas.push(area);
        console.log(`  → ${listings.length} listings`);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const blocked = isHemnetSafetyError(err);
        console.error(
          `  ✗ ${area} attempt ${attempt}/${MAX_AREA_ATTEMPTS}` +
            `${blocked ? " (blocked — likely a datacenter proxy exit; retrying for a fresh IP)" : ""}: ${err.message}`
        );
        if (attempt < MAX_AREA_ATTEMPTS) await sleep(1500); // give the proxy time to rotate the exit
      }
    }
    if (lastErr) failedAreas.push(area);
  }

  const scrapeDate = new Date().toLocaleDateString("sv-SE");

  // Deduplicate by id
  const seen = new Set();
  const unique = allListings.filter((l) => {
    if (seen.has(l.id)) return false;
    seen.add(l.id);
    return true;
  });
  if (unique.length === 0) {
    await browser.close();
    assertNonEmptyRefreshResult({ total: unique.length, dataset: "active listings" });
  }

  if (includeDetails) {
    // Visit each detail page to get all images + floor plan status.
    // AI image analysis is intentionally handled by /api/analyze-images after scraping.
    console.log(`Fetching detail pages for ${unique.length} listings...`);
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

            // BRF and building info from Apollo data
            const association = Object.values(apollo).find((v) => v.__typename === "HousingCooperative" || v.__typename === "Association");
            const brfName = association?.name || listing.housingCooperativeName || null;
            const buildYear = listing.constructionYear || listing.buildYear || null;

            // Look for description text for stambyte/renovation clues
            const descText = (listing.description || "").toLowerCase();
            let stambyteStatus = null;
            if (/stambyte.*(gjord|klar|genomförd|2\d{3})/.test(descText)) stambyteStatus = "done";
            else if (/stambyte.*(planerad|kommande|snart)/.test(descText)) stambyteStatus = "planned";

            return { allImages, hasFloorPlan, brfName, buildYear, stambyteStatus, description: listing.description || null };
          } catch { return null; }
        });
        if (detail) {
          if (detail.allImages.length > 0) l.images = detail.allImages;
          l.hasFloorPlan = detail.hasFloorPlan;
          if (detail.brfName) l.brfName = detail.brfName;
          if (detail.buildYear) l.buildYear = detail.buildYear;
          if (detail.stambyteStatus) l.stambyteStatus = detail.stambyteStatus;
        }
      } catch { /* keep search-page images */ }

      if ((i + 1) % 20 === 0) console.log(`  ${i + 1} / ${unique.length}`);
    }
  } else {
    console.log(`Skipping detail pages for ${unique.length} active listings. Image analysis runs separately.`);
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
      status: "active",
      lastSeenAt: new Date(),
      soldStatusConfidence: null,
      disappearedAt: null,
    };
    if (l.hasFloorPlan !== undefined) update.hasFloorPlan = l.hasFloorPlan;
    if (l.transitMinutes) { update.transitMinutes = l.transitMinutes; update.nearestStation = l.nearestStation; update.transitLine = l.transitLine; }
    if (l.brfName) update.brfName = l.brfName;
    if (l.buildYear) update.buildYear = l.buildYear;
    if (l.stambyteStatus) update.stambyteStatus = l.stambyteStatus;
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

  // Mark listings no longer in the active scrape as disappeared — but ONLY when
  // the scrape was complete. A partial scrape (an area failed even after retry)
  // never observed the missing area's listings, so inferring they "disappeared"
  // from their absence would be a false positive. Defer reconciliation to the
  // next complete run instead.
  const currentIds = unique.map((l) => l.id);
  const plan = planDisappearanceReconciliation({ scrapedAreas, failedAreas });
  let disappearedCount = 0;
  if (plan.reconcile) {
    const disappeared = await Listing.find({ id: { $nin: currentIds }, status: "active" });
    for (const d of disappeared) {
      const dom = d.publishedAt ? Math.floor((Date.now() - new Date(d.publishedAt).getTime()) / (1000*60*60*24)) : null;
      await Listing.findByIdAndUpdate(d._id, {
        status: "disappeared",
        disappearedAt: new Date(),
        lastSeenAt: d.lastSeenAt || d.updatedAt || null,
        daysOnMarket: dom,
        soldStatusConfidence: "unconfirmed",
      });
      console.log(`  📋 Marked as disappeared: ${d.streetAddress} (${dom ? dom + ' days' : 'unknown'})`);
    }
    disappearedCount = disappeared.length;
  } else {
    console.warn(`  ⚠️ ${plan.reason}`);
  }

  // Refresh the listings we did see this run as active (safe on partial scrapes).
  await Listing.updateMany(
    { id: { $in: currentIds } },
    { status: "active", lastSeenAt: new Date(), soldStatusConfidence: null, disappearedAt: null }
  );

  return {
    total: unique.length,
    disappeared: disappearedCount,
    scrapeDate,
    partial: plan.partial,
    scrapedAreas,
    failedAreas,
  };
};
