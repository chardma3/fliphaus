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
