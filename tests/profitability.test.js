const test = require("node:test");
const assert = require("node:assert/strict");

const { sortListingsByProfit } = require("../profitability");

function fakeCalc(listing) {
  return { profit: listing.profit };
}

test("sorts profitable listings from highest profit to lowest profit", () => {
  const listings = [
    { id: "low", profit: 75000 },
    { id: "high", profit: 320000 },
    { id: "mid", profit: 180000 },
  ];

  const sorted = sortListingsByProfit(listings, "desc", fakeCalc);

  assert.deepEqual(sorted.map((listing) => listing.id), ["high", "mid", "low"]);
  assert.deepEqual(listings.map((listing) => listing.id), ["low", "high", "mid"], "does not mutate the original list");
});

test("sorts unprofitable listings from closest to profitable down to worst loss", () => {
  const listings = [
    { id: "worst", profit: -250000 },
    { id: "closest", profit: -10000 },
    { id: "middle", profit: -90000 },
  ];

  const sorted = sortListingsByProfit(listings, "desc", fakeCalc);

  assert.deepEqual(sorted.map((listing) => listing.id), ["closest", "middle", "worst"]);
});
