const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();

  // Intercept all image requests
  const floorPlanUrls = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('bilder.hemnet') && (url.includes('floor') || url.includes('plan'))) {
      floorPlanUrls.push(url);
    }
  });

  await page.goto('https://www.hemnet.se/bostad/lagenhet-2rum-riksby-stockholms-kommun-stramaljvagen-28,-2tr-21697717', { waitUntil: 'networkidle2', timeout: 30000 });

  // Scroll to trigger lazy loads
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 2000));

  const data = await page.evaluate(() => {
    const apollo = JSON.parse(document.getElementById('__NEXT_DATA__').textContent).props.pageProps.__APOLLO_STATE__;

    // Find all image entries in apollo state
    const allImages = Object.entries(apollo)
      .filter(([k, v]) => v.__typename === 'ListingImage')
      .map(([k, v]) => ({ key: k, val: JSON.stringify(v).slice(0, 300) }));

    return { allImages: allImages.slice(0, 10) };
  });

  console.log('Floor plan URLs from network:', floorPlanUrls);
  console.log('\nAll ListingImage entries:', JSON.stringify(data.allImages, null, 2));

  await browser.close();
})().catch(e => console.error(e.message));
