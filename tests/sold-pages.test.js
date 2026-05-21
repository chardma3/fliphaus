const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("Sold page uses FlipHaus dashboard sold listings, not general market sales", () => {
  const soldHtml = fs.readFileSync(path.join(root, "sold.html"), "utf8");

  assert.match(soldHtml, /fetch\("\/api\/sold"\)/);
  assert.doesNotMatch(soldHtml, /fetch\("\/api\/sold\/stats"\)/);
  assert.match(soldHtml, /FlipHaus dashboard/i);
});

test("separate market sales page keeps the general similar sold properties feed", () => {
  const marketSalesPath = path.join(root, "market-sales.html");
  assert.equal(fs.existsSync(marketSalesPath), true);

  const marketSalesHtml = fs.readFileSync(marketSalesPath, "utf8");
  assert.match(marketSalesHtml, /fetch\("\/api\/sold\/stats"\)/);
  assert.match(marketSalesHtml, /Similar sold properties|Market sales/i);
});

test("homepage and sold page navigation include separate Sold and Market sales destinations", () => {
  const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const soldHtml = fs.readFileSync(path.join(root, "sold.html"), "utf8");

  for (const html of [indexHtml, soldHtml]) {
    assert.match(html, /href="\/sold"[^>]*>Sold</);
    assert.match(html, /href="\/market-sales"[^>]*>Market sales</);
  }
});
