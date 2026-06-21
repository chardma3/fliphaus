const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { buildPuppeteerLaunchOptions, authenticateProxyPage, logProxyStatus } = require("./puppeteer-options");
const { assertHemnetPageUsable } = require("./hemnet-refresh-safety");

puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PAGE_ATTEMPTS = Math.max(1, Number(process.env.GALLERY_MAX_PAGE_ATTEMPTS) || 4);
// Recycle the tab every N galleries so Chromium reclaims per-page renderer
// memory rather than accumulating it across navigations (same leak fixed in the
// scrape). Keeps batched gallery hydration safe if the analyse limit is raised.
const GALLERY_RECYCLE_EVERY = Math.max(1, Number(process.env.GALLERY_PAGE_RECYCLE_EVERY) || 25);

async function createGalleryPage(browser) {
  const page = await browser.newPage();
  await authenticateProxyPage(page);
  await page.setViewport({ width: 1280, height: 800 });
  return page;
}

// Pull the full image gallery from a listing's detail page. The active scrape
// runs includeDetails=false and only stores ~5 search-card thumbnails, which
// frequently omit the bathroom/kitchen — so the analyser never sees them. The
// detail page carries the complete gallery (where those rooms always appear).
async function fetchGalleryOnPage(page, slug) {
  const url = `https://www.hemnet.se/bostad/${slug}`;
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  const state = await page.evaluate(() => ({
    hasNextData: Boolean(document.getElementById("__NEXT_DATA__")),
    html: `${document.title || ""}\n${document.body?.innerText || ""}`,
  }));
  assertHemnetPageUsable({ ...state, url, areaName: slug, dataset: "detail gallery" });

  return page.evaluate(() => {
    try {
      const apollo = JSON.parse(document.getElementById("__NEXT_DATA__").textContent).props.pageProps.__APOLLO_STATE__;
      const listing = Object.values(apollo).find((v) => v.__typename === "ActivePropertyListing");
      if (!listing) return [];
      const imgKey = Object.keys(listing).find((k) => k.startsWith("images") && k.includes("300"));
      return ((imgKey && listing[imgKey]?.images) || [])
        .map((img) => {
          const urlKey = Object.keys(img).find((k) => k.startsWith("url"));
          return urlKey ? img[urlKey] : null;
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  });
}

// Fetch full galleries for many slugs using ONE browser. Retries each detail
// page on a block (rotating the proxy exit), mirroring the scrapers. Returns a
// { slug: [imageUrls] } map; slugs that fail after retries are simply absent.
async function fetchGalleries(slugs, { maxAttempts = PAGE_ATTEMPTS } = {}) {
  const result = {};
  const unique = [...new Set((slugs || []).filter(Boolean))];
  if (!unique.length) return result;

  logProxyStatus();
  const browser = await puppeteer.launch(buildPuppeteerLaunchOptions());
  try {
    let page = await createGalleryPage(browser);

    for (let i = 0; i < unique.length; i++) {
      const slug = unique[i];
      if (i > 0 && i % GALLERY_RECYCLE_EVERY === 0) {
        try { await page.close(); } catch { /* already gone */ }
        page = await createGalleryPage(browser);
      }
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const images = await fetchGalleryOnPage(page, slug);
          if (images.length) result[slug] = images;
          break;
        } catch (err) {
          console.error(`  ✗ gallery ${slug} (attempt ${attempt}/${maxAttempts}): ${err.message}`);
          if (attempt < maxAttempts) await sleep(1500);
        }
      }
    }
  } finally {
    await browser.close();
  }
  return result;
}

module.exports = { fetchGalleries, fetchGalleryOnPage };
