const test = require("node:test");
const assert = require("node:assert/strict");

const { rawNum, normalizeBooliSold, collectBooliSold } = require("../api/booli");

test("rawNum unwraps { raw }, passes numbers, and parses formatted strings", () => {
  assert.equal(rawNum({ raw: 72 }), 72);
  assert.equal(rawNum(72), 72);
  assert.equal(rawNum({ raw: 3450000, formatted: "3 450 000 kr" }), 3450000);
  assert.equal(rawNum("3 450 000 kr"), 3450000);
  assert.equal(rawNum("72 m²"), 72);
  assert.equal(rawNum(null), null);
  assert.equal(rawNum({ raw: null }), null);
});

const sample = {
  booliId: 987654,
  streetAddress: "Skattungsvägen 6",
  soldPrice: { raw: 3450000 },
  soldPriceSqm: { raw: 68000 },
  soldDate: "2026-06-30",
  livingArea: { raw: 51 },
  rooms: { raw: 2 },
  latitude: 59.298,
  longitude: 18.045,
  location: { region: { name: "Stockholm" }, namedAreas: ["Årsta"] },
  url: "https://www.booli.se/annons/987654",
};

test("normalizeBooliSold maps a Booli record to our sold shape", () => {
  const r = normalizeBooliSold(sample);
  assert.equal(r.source, "booli");
  assert.equal(r.booliId, "987654"); // string-coerced
  assert.equal(r.streetAddress, "Skattungsvägen 6");
  assert.equal(r.soldPrice, 3450000);
  assert.equal(r.soldPriceSqm, 68000);
  assert.equal(r.soldDate, "2026-06-30");
  assert.equal(r.sizeNum, 51);
  assert.equal(r.rooms, "2 rum"); // formatted for our rooms-string convention
  assert.deepEqual(r.coordinates, { lat: 59.298, lng: 18.045 });
  assert.equal(r.locationDescription, "Årsta");
  assert.equal(r.url, "https://www.booli.se/annons/987654");
});

test("normalizeBooliSold is null-safe for a sparse record", () => {
  const r = normalizeBooliSold({ booliId: 1, streetAddress: "X" });
  assert.equal(r.soldPrice, null);
  assert.equal(r.sizeNum, null);
  assert.equal(r.rooms, null);
  assert.equal(r.coordinates, null);
  assert.equal(r.locationDescription, null);
});

test("collectBooliSold pages through results and respects maxPages", async () => {
  const calls = [];
  const post = async (_query, vars) => {
    calls.push(vars.page);
    // 3 pages available, but each returns one record
    return { searchSold: { pages: 3, result: [{ ...sample, booliId: vars.page }] } };
  };
  const out = await collectBooliSold({ post, areaId: "76401", maxPages: 2 });
  assert.deepEqual(calls, [1, 2]); // stopped at maxPages, not all 3
  assert.equal(out.length, 2);
  assert.equal(out[0].booliId, "1");
});

test("collectBooliSold stops early on an empty page", async () => {
  const post = async (_q, vars) =>
    vars.page === 1
      ? { searchSold: { pages: 5, result: [{ ...sample }] } }
      : { searchSold: { pages: 5, result: [] } };
  const out = await collectBooliSold({ post, areaId: "76401", maxPages: 5 });
  assert.equal(out.length, 1);
});
