// Pure image-selection helpers, deliberately free of the Anthropic SDK so they
// can be unit-tested and reused without constructing an API client. analyze.js
// re-exports these alongside its model-calling functions.

function uniqueByUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    const url = typeof item === "string" ? item : item.url;
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

// Pick the images for the expensive scoring call from the (already computed)
// triage classification — no model call here. Falls back to an evenly-spread
// selection when classification is missing.
function selectImagesForAnalysis(images, classified = null) {
  const maxAnalysisImages = 12;

  if (images.length <= maxAnalysisImages) {
    return { selectedImages: images, coverageSource: "all", classified };
  }

  if (classified && classified.length) {
    const pick = (room) =>
      classified
        .filter((img) => img.roomTypes?.includes(room))
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, 4)
        .map((img) => ({ url: images[img.index], reason: room }));

    const evenlySpaced = Array.from({ length: maxAnalysisImages }, (_, i) => {
      const index = Math.floor((i * images.length) / maxAnalysisImages);
      return { url: images[index], reason: "overview" };
    });

    const selected = uniqueByUrl([...pick("kitchen"), ...pick("bathroom"), ...evenlySpaced])
      .slice(0, maxAnalysisImages)
      .map((item) => item.url);

    return { selectedImages: selected, coverageSource: "room-classifier", classified };
  }

  const step = images.length / maxAnalysisImages;
  const selectedImages = Array.from({ length: maxAnalysisImages }, (_, i) => images[Math.floor(i * step)]);
  return { selectedImages, coverageSource: "fallback-spread", classified: null };
}

// How many photos we keep on a listing for display. Hemnet galleries run 20-50
// images; we don't need them all. We persist a small curated set instead so the
// feed shows a consistent handful of the most relevant photos rather than
// anywhere from 5 (thumbnail-only) to 50 (fully hydrated) depending on pipeline
// luck.
const MAX_DISPLAY_IMAGES = 6;

// Pick the photos to KEEP on the listing for display, from the triage
// classification. Always leads with the kitchen and bathroom (the rooms that
// drive a renovation flip) — even for a small gallery, where it reorders the
// photos wet-rooms-first rather than leaving Hemnet's living-room-heavy order.
// Returns image URLs, wet-rooms-first. Falls back to an even spread (large
// gallery) or the original order (small gallery) when no classification exists.
function selectDisplayImages(images, classified = null) {
  if (!images || !images.length) return [];

  const small = images.length <= MAX_DISPLAY_IMAGES;
  const evenSpread = (n) =>
    Array.from({ length: n }, (_, i) => images[Math.floor((i * images.length) / n)]);

  if (!classified || !classified.length) {
    // No room info: keep a small gallery as-is, else thin a large one.
    return small ? images : uniqueByUrl(evenSpread(MAX_DISPLAY_IMAGES)).slice(0, MAX_DISPLAY_IMAGES);
  }

  const pick = (room, n) =>
    classified
      .filter((img) => img.roomTypes?.includes(room))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, n)
      .map((img) => images[img.index])
      .filter(Boolean);

  const wetRooms = uniqueByUrl([...pick("kitchen", 2), ...pick("bathroom", 2)]);
  // Small gallery: keep every photo but lead with the wet rooms. Large gallery:
  // wet rooms then an even spread of overview shots, capped.
  const filler = small ? images : evenSpread(MAX_DISPLAY_IMAGES);
  return uniqueByUrl([...wetRooms, ...filler]).slice(0, MAX_DISPLAY_IMAGES);
}

module.exports = { uniqueByUrl, selectImagesForAnalysis, selectDisplayImages, MAX_DISPLAY_IMAGES };
