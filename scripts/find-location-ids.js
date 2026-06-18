#!/usr/bin/env node
/**
 * Resolve Hemnet location_ids for area names, through the configured residential
 * proxy. Hemnet Cloudflare-blocks datacenter IPs, so this must run on Render
 * where HEMNET_PROXY_* are set (it won't work from a local/datacenter IP).
 *
 * Prints the candidate locations Hemnet returns for each query as compact JSON,
 * so you can read off the right `id` (match the granularity of the reference
 * areas printed first — Rissne/Farsta, the ones already in LOCATION_IDS).
 * Read-only: no DB, no writes.
 *
 *   node scripts/find-location-ids.js                       # default 8 + refs
 *   node scripts/find-location-ids.js Bromma Kista          # specific areas
 */
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { buildPuppeteerLaunchOptions, authenticateProxyPage, logProxyStatus } = require("../api/puppeteer-options");

puppeteer.use(StealthPlugin());

// Printed first as a calibration reference — their ids are already known to be
// the right node level (Rissne 473493, Farsta 925962).
const REFERENCE = ["Rissne", "Farsta"];
const TARGETS = ["Bromma", "Blackeberg", "Kista", "Sollentuna", "Skarpnäck", "Bagarmossen", "Enskede", "Hökarängen", "Kärrtorp", "Högdalen"];

async function lookup(page, area) {
  const url = `https://www.hemnet.se/locations/search?q=${encodeURIComponent(area)}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  const body = await page.evaluate(() => document.body.innerText || "");
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    console.log(`\n### ${area}: non-JSON response (Cloudflare/HTML?) — first 160 chars:\n  ${body.slice(0, 160)}`);
    return;
  }
  const list = Array.isArray(data) ? data : data.locations || data.results || data.data || [];
  console.log(`\n### ${area} — ${list.length} candidate(s)`);
  list.slice(0, 8).forEach((loc) => console.log("  " + JSON.stringify(loc)));
}

(async () => {
  const areas = process.argv.slice(2).length ? process.argv.slice(2) : [...REFERENCE, ...TARGETS];
  logProxyStatus();
  const browser = await puppeteer.launch(buildPuppeteerLaunchOptions());
  try {
    const page = await browser.newPage();
    await authenticateProxyPage(page);
    await page.setViewport({ width: 1280, height: 800 });
    for (const area of areas) {
      try {
        await lookup(page, area);
      } catch (err) {
        console.log(`\n### ${area}: lookup failed — ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
