const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The listing-card styles now live in the shared card.css (used by both the
// dashboard and the favorites page), not inline in index.html.
const cardCss = fs.readFileSync(path.join(__dirname, "..", "card.css"), "utf8");

test("collapsed rejected listings keep ROI badge top-right and move X/heart controls bottom-right", () => {
  assert.match(cardCss, /\.profit-badge\s*\{[\s\S]*?top:\s*10px;[\s\S]*?right:\s*10px;/, "ROI/profit badge should remain in the top-right corner");
  assert.match(cardCss, /\.listing\.rejected\s+\.listing-header-actions\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:\s*16px;[\s\S]*?bottom:\s*10px;/, "collapsed X/heart controls should sit at the bottom-right of the collapsed card");
  assert.match(cardCss, /\.listing\.rejected\s+\.listing-body\s*\{[\s\S]*?min-height:\s*64px;[\s\S]*?padding:\s*10px\s+96px\s+14px\s+16px;/, "collapsed summary text should reserve space so the controls do not cover it");
});
