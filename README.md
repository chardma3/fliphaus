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

## Setup

```bash
npm install
cp .env.example .env  # fill in MONGO_URI, Google OAuth creds, SESSION_SECRET
npm start
```
