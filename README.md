# FlipHaus

AI-powered digital investment platform for co-investing in renovation-based apartment flips in Stockholm. Uses a SPV-per-property model where investors receive a fixed, market-linked return, builders receive a performance bonus, and FlipHaus manages the full renovation cycle with AI-driven property selection.

## How it works

1. **AI identifies property** — scrapes Hemnet, analyses photos and floorplans for renovation potential
2. **Builder reviews and accepts** — inputs timeline + 1-month buffer, cost structure
3. **Inspector confirms feasibility** — pre-purchase verification
4. **SPV opens for investor funding** — escrow partner holds funds
5. **Renovation executes** — mid-project inspector check
6. **Property sold** — investors receive capital + ROI, builder gets bonus, FlipHaus takes profit share

## AI renovation analysis

Analyses listing photos to detect indicators of dated/renovatable properties:

### Bathrooms
- Linoleum flooring
- Blue flooring (common in older Swedish apartments)

### Kitchens
- White range hood
- White dishwasher
- Combined sink/kitchen bench in shiny metallic material

### Cost estimation
- Extracts room dimensions from floorplan images
- Predicts renovation cost with ±100,000 SEK accuracy
- Suggests renovation templates (kitchen, bathroom, floors)

## Financial model (base case)

| Item | Amount |
|------|--------|
| Apartment price | 2,500,000 SEK |
| Deposit | 500,000 SEK |
| Renovation | 250,000 SEK |
| Sale uplift | 200,000 SEK |
| Investor ROI (6 months) | 5.125% (25,625 SEK) |
| Builder bonus | 10,000 SEK |
| Inspector cost | 12,000 SEK |
| FlipHaus profit | ~152,375 SEK |

## Revenue streams

- SPV profit share
- Subscription tiers (premium investor access & analytics)
- Data licensing (to brokers, banks, insurers)
- White-label API (partner banks)
- Secondary share marketplace (future)

## Tech stack

- **Backend:** Node.js + Express
- **Database:** MongoDB (Mongoose)
- **Scraping:** Puppeteer + stealth plugin
- **Auth:** Google OAuth 2.0 (Passport)
- **Frontend:** Single-page HTML

## Scale plan

Launch in Sweden → expand to Australia, UK, Portugal, Netherlands.

## Data refresh pipeline

FlipHaus depends on fresh Hemnet data for property selection, renovation analysis, and sold-market evidence. The front-end health banner and `/api/scrape-health` endpoint should be checked whenever the dashboard looks wrong.

### Scheduled refresh

GitHub Actions runs `.github/workflows/refresh-fliphaus.yml` once per day:

- Cron: `20 5 * * *`
- UTC time: 05:20
- Stockholm summer time: 07:20 CEST

The workflow uses `FLIPHAUS_REFRESH_URL` and `FLIPHAUS_REFRESH_TOKEN` GitHub secrets. Do not commit token values.

### Refresh steps

1. `/api/scrape` refreshes active dashboard listings.
2. `/api/scrape-sold?area=Rissne&detailLimit=20` refreshes Rissne sold comparable properties.
3. `/api/scrape-sold?area=Farsta&detailLimit=20` refreshes Farsta sold comparable properties.
4. `/api/reconcile-sold` confirms disappeared dashboard listings only when they match scraped sold records strongly enough.

The sold scrape is intentionally split by area and capped at 20 detail pages per request. This keeps each HTTP request shorter and reduces the chance of Render/GitHub/Cloudflare timeouts. Add more area-specific workflow steps if more areas are added to `api/hemnet-refresh-safety.js`.

Longer-term architecture note: if Hemnet scraping continues to exceed HTTP/proxy time limits even after area splitting and lower `detailLimit` values, move the actual browser scraping into a background worker/queue. In that model the HTTP endpoint should enqueue a refresh job and return quickly, while the worker updates MongoDB and exposes job status separately.

### Prototype proxy setup for Hemnet bot protection

Fresh prototype/demo listings may require routing Puppeteer through a residential proxy because Hemnet can block Render/cloud datacenter IPs with Cloudflare security verification.

The scraper supports these Render environment variables:

- `HEMNET_PROXY_SERVER` — proxy host URL, for example `http://host:port` or `http://gate.provider.example:7000`
- `HEMNET_PROXY_USERNAME` — proxy username, if the provider requires authentication
- `HEMNET_PROXY_PASSWORD` — proxy password, if the provider requires authentication

Do not commit proxy credentials. Add them only in Render service environment variables.

Recommended setup:

1. Choose a residential proxy or scraping-browser provider with Sweden/Stockholm residential exits.
2. In Render, open the FlipHaus web service.
3. Go to Environment.
4. Add `HEMNET_PROXY_SERVER`, `HEMNET_PROXY_USERNAME`, and `HEMNET_PROXY_PASSWORD` using the provider values.
5. Save changes and let Render redeploy.
6. Manually run the GitHub Actions workflow `Refresh FlipHaus data`.
7. Check the workflow logs. A successful active scrape should return a JSON body like `Scrape complete` with a non-zero `total`.
8. Check `/api/scrape-health` and confirm the active `lastScrapeDate` moved to today.

Known working Smartproxy shape for the prototype:

- `HEMNET_PROXY_SERVER`: `http://eu.smartproxy.net:3120`
- `HEMNET_PROXY_USERNAME`: Smartproxy-generated username with Sweden/Stockholm targeting, for example a value containing `_area-SE_city-STOCKHOLM`
- `HEMNET_PROXY_PASSWORD`: Smartproxy password

Do not use `proxy.eu.smartproxy.net`; that host may not resolve. Do not put the username or password inside `HEMNET_PROXY_SERVER` when separate username/password environment variables are configured.

Before running the full workflow, test the proxy inside Render Web Shell without exposing secrets:

```bash
curl -sS --max-time 25 -x "$HEMNET_PROXY_SERVER" -U "$HEMNET_PROXY_USERNAME:$HEMNET_PROXY_PASSWORD" "https://api.ipify.org?format=json"
```

Then test what Hemnet serves to Puppeteer:

```bash
node - <<'NODE'
const puppeteer = require('puppeteer');
const { buildPuppeteerLaunchOptions, authenticateProxyPage } = require('./api/puppeteer-options');

(async () => {
  const browser = await puppeteer.launch(buildPuppeteerLaunchOptions());
  try {
    const page = await browser.newPage();
    await authenticateProxyPage(page);
    await page.goto('https://www.hemnet.se/bostader?location_ids%5B%5D=18031', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    console.log('TITLE:', await page.title());
    console.log('HAS NEXT_DATA:', await page.evaluate(() => !!document.querySelector('#__NEXT_DATA__')));
    console.log('BODY PREVIEW:', await page.evaluate(() => document.body.innerText.slice(0, 2000)));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
```

If the title is `Just a moment...` and `HAS NEXT_DATA` is `false`, the proxy is connected but Hemnet is still showing bot protection. If the title is a real Hemnet page and `HAS NEXT_DATA` is `true`, run the workflow.

The scheduled workflow calls `/api/scrape?includeDetails=false` for the active refresh. This updates active listings quickly from Hemnet search result pages and skips slower detail-page/AI image analysis so GitHub Actions can continue to the sold comparable-property steps. The scheduled sold refreshes also use `includeDetails=false&includeAnalysis=false` with small per-area requests; run richer sold refreshes manually if detail-page enrichment or AI condition scoring is needed.

Cost note: this should not require a new paid Render service, but the residential proxy/scraping provider itself is usually paid. For the production broker-partnership model, this proxy is only a prototype/demo data workaround.

### Safety rules

The scraper must fail loudly rather than silently corrupting data:

- If Hemnet serves a Cloudflare/security-verification/bot-protection page, the API returns an error with a clear detail message.
- If a Hemnet page is missing `__NEXT_DATA__`, the API returns an error instead of parsing an empty result.
- If the active-listing scrape produces zero listings, FlipHaus refuses to persist the result. This prevents a blocked scrape from marking existing active listings as `disappeared`.
- Missing active listings are marked `disappeared`, not `sold`. They become `confirmed_sold` only after `/api/reconcile-sold` finds a strong sold-listing match.

### Operational checks

Use `/api/scrape-health` to inspect:

- active listing count and latest active scrape date
- sold comparable-property count and latest sold scrape date
- stale flags for each dataset separately

If data is stale and GitHub Actions failed:

1. Open the failed GitHub Actions run and identify which endpoint failed.
2. If the error mentions Hemnet bot protection or missing `__NEXT_DATA__`, the source site blocked or changed the scraper; do not trust zero-result data.
3. If the error is `524` or a long timeout on `/api/scrape-sold`, keep the area-split workflow and lower `detailLimit` further.
4. Re-run the workflow manually only after checking that the source site is reachable.

## Setup

```bash
npm install
cp .env.example .env  # fill in MONGO_URI, Google OAuth creds, SESSION_SECRET, REFRESH_TOKEN
npm start
```
