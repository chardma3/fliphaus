const test = require("node:test");
const assert = require("node:assert/strict");

const { escapeHtml, sharePageHtml } = require("../api/share-page");

const BASE = "https://fliphaus.example";
const LISTING = {
  id: "abc123",
  streetAddress: "Skrakgränd 3",
  locationDescription: "Farsta, Stockholms kommun",
  askingPrice: "2 350 000 kr",
  rooms: "3 rum",
  size: "76 m²",
  images: ["https://img.hemnet.se/a.jpg", "https://img.hemnet.se/b.jpg"],
  renovationSummary: "Original kitchen and bathroom — strong renovation upside.",
};

test("share page renders per-listing Open Graph + Twitter tags with the hero photo", () => {
  const html = sharePageHtml(LISTING, BASE, LISTING.id);
  assert.match(html, /<meta property="og:title" content="Skrakgränd 3 — Farsta"\/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/img\.hemnet\.se\/a\.jpg"\/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/fliphaus\.example\/l\/abc123"\/>/);
  assert.match(html, /twitter:card" content="summary_large_image"/);
  // Facts line drives the description.
  assert.match(html, /<meta property="og:description" content="3 rum · 76 m² · 2 350 000 kr"\/>/);
});

test("share page offers Google sign-in that returns to this listing", () => {
  const html = sharePageHtml(LISTING, BASE, LISTING.id);
  assert.match(html, /\/auth\/google\?returnTo=\/l\/'/); // built client-side with the id appended
  assert.match(html, /Sign in with Google/);
});

test("share page without a photo falls back to a summary card, no og:image", () => {
  const html = sharePageHtml({ ...LISTING, images: [], thumbnail: null }, BASE, LISTING.id);
  assert.doesNotMatch(html, /og:image/);
  assert.match(html, /twitter:card" content="summary"/);
});

test("missing listing renders a friendly not-found page, not a crash", () => {
  const html = sharePageHtml(null, BASE, "gone");
  assert.match(html, /Listing not found/);
  assert.match(html, /noindex/);
});

test("escapeHtml neutralises markup so listing text can't break the page or inject", () => {
  assert.equal(escapeHtml(`<script>"&'`), "&lt;script&gt;&quot;&amp;&#39;");
  const html = sharePageHtml({ ...LISTING, streetAddress: `Evil <img src=x onerror=alert(1)>` }, BASE, LISTING.id);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /Evil &lt;img src=x onerror=alert\(1\)&gt;/);
});
