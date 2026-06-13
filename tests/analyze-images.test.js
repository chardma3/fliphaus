const test = require("node:test");
const assert = require("node:assert/strict");

const { selectDisplayImages, MAX_DISPLAY_IMAGES } = require("../api/image-selection");

const gallery = (n) => Array.from({ length: n }, (_, i) => `img${i}`);

test("a small gallery with no classification is returned unchanged (nothing to trim)", () => {
  const imgs = gallery(MAX_DISPLAY_IMAGES);
  assert.deepEqual(selectDisplayImages(imgs, null), imgs);
  assert.deepEqual(selectDisplayImages(gallery(3), null), gallery(3));
});

test("a small gallery still leads with the wet rooms when classified", () => {
  // 5 images, kitchen at index 3 and bathroom at index 4 — they should be
  // pulled to the front, but no photo is dropped.
  const classified = [
    { index: 3, roomTypes: ["kitchen"], confidence: 0.9 },
    { index: 4, roomTypes: ["bathroom"], confidence: 0.9 },
  ];
  const result = selectDisplayImages(gallery(5), classified);
  assert.equal(result.length, 5, "keeps all 5 photos");
  assert.deepEqual(result.slice(0, 2), ["img3", "img4"], "wet rooms lead");
  assert.deepEqual(new Set(result), new Set(gallery(5)), "same photos, reordered");
});

test("an empty gallery yields an empty set", () => {
  assert.deepEqual(selectDisplayImages([], null), []);
  assert.deepEqual(selectDisplayImages(null, null), []);
});

test("a large gallery with no classification is capped to an even spread", () => {
  const result = selectDisplayImages(gallery(25), null);
  assert.equal(result.length, MAX_DISPLAY_IMAGES);
  // Even spread across 25: floor(i*25/6) = 0,4,8,12,16,20
  assert.deepEqual(result, ["img0", "img4", "img8", "img12", "img16", "img20"]);
});

test("a large gallery keeps the kitchen and bathroom ahead of the spread", () => {
  const classified = [
    { index: 10, roomTypes: ["kitchen"], condition: "original", confidence: 0.9 },
    { index: 11, roomTypes: ["kitchen"], condition: "dated", confidence: 0.5 },
    { index: 20, roomTypes: ["bathroom"], condition: "original", confidence: 0.8 },
  ];
  const result = selectDisplayImages(gallery(25), classified);

  assert.equal(result.length, MAX_DISPLAY_IMAGES);
  // Highest-confidence wet-room photos come first, in confidence order.
  assert.equal(result[0], "img10");
  assert.ok(result.includes("img11"), "second kitchen photo kept");
  assert.ok(result.includes("img20"), "bathroom photo kept");
});

test("the priority picker keeps at most two of each wet room", () => {
  // Indices chosen to avoid the even spread (0,4,8,12,16,20 over 25 images), so
  // this isolates the picker's cap rather than coincidental spread overlap.
  const classified = [
    { index: 1, roomTypes: ["kitchen"], confidence: 0.9 },
    { index: 2, roomTypes: ["kitchen"], confidence: 0.8 },
    { index: 3, roomTypes: ["kitchen"], confidence: 0.7 },
    { index: 5, roomTypes: ["kitchen"], confidence: 0.6 },
  ];
  const result = selectDisplayImages(gallery(25), classified);
  const kitchenKept = ["img1", "img2", "img3", "img5"].filter((u) => result.includes(u));
  assert.equal(kitchenKept.length, 2, `kept ${kitchenKept.length} prioritised kitchen photos, expected 2`);
});

test("deduplicates so a photo picked as both wet-room and spread appears once", () => {
  // index 0 is a kitchen AND the first even-spread pick -> must not duplicate.
  const classified = [{ index: 0, roomTypes: ["kitchen"], confidence: 0.9 }];
  const result = selectDisplayImages(gallery(25), classified);
  assert.equal(new Set(result).size, result.length);
});
