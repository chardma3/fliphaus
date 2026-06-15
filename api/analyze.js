const Anthropic = require("@anthropic-ai/sdk");
const { uniqueByUrl, selectImagesForAnalysis, selectDisplayImages, coverageFromDisplaySet, MAX_DISPLAY_IMAGES } = require("./image-selection");

const client = new Anthropic();

// Two-tier models. A cheap model triages every listing (room classification +
// a coarse kitchen/bathroom condition read); the expensive model only runs the
// full renovation score on listings that aren't gated out as already-modern.
// Both are env-overridable for tuning without a redeploy.
const TRIAGE_MODEL = process.env.TRIAGE_MODEL || "claude-haiku-4-5";
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are a Swedish apartment renovation analyst for FlipHaus, an investment platform that finds undervalued properties with renovation potential in Stockholm.

Analyse the listing photos and return a JSON assessment. The business goal is to identify apartments where renovation creates upside, especially kitchens and bathrooms.

Important kitchen rule — judge the cabinets, worktop and appliances FIRST:
The most reliable signal of a kitchen's age is the CABINET FRONTS, then the worktop, then the appliances. Decide "original vs renovated" from those before anything else. Do NOT let one dated-looking element (a sink, a tap, a tile) override clearly modern cabinetry.

- Signs the kitchen is RENOVATED / NEWLY RENOVATED (do NOT flag for renovation; score it low):
  - Cabinet doors are clean, consistent, modern fronts — flat/slab or simple shaker, often handleless or with slim bar/edge handles, in good condition with no wear or gaps.
  - Worktop is a solid modern surface: stone/quartz/composite, or a modern woodgrain/solid-colour laminate with a clean edge.
  - Appliances are integrated or panel-covered (or modern stainless built-ins), with an induction/ceramic hob and a discreet or integrated extractor.
  - If the cabinets AND worktop are clearly modern, classify the kitchen as renovated EVEN IF there is a stainless-steel sink, a farmhouse/apron-front sink, or another single older-looking detail. New cabinets + new worktop = a renovated kitchen.

- Signs the kitchen is ORIGINAL (flag for renovation; score it high) — these must appear TOGETHER, not in isolation:
  - A continuous shiny stainless-steel combined sink-and-bench/countertop unit (integrated drainer, metal worktop around the sink) COMBINED WITH dated cabinet fronts.
  - Dated cabinet fronts (worn laminate, old timber, 60s-80s hinges/handles), laminate worktops paired with those dated fronts, free-standing white appliances, no dishwasher.

- A standalone farmhouse/apron-front/Belfast sink is NOT an "original" indicator. In a modern kitchen it is an intentional design choice — treat the kitchen as renovated and, if you mention the sink, note "farmhouse sink appears intentional".
- When the cabinets look modern but a metal worktop/sink tempts you to call it original, DEFAULT TO RENOVATED and lower your confidence rather than scoring it for a full renovation.

Bathroom indicators of needed renovation:
- Linoleum or vinyl flooring (very common in older Swedish apartments)
- Blue flooring or blue tiles
- Dated tile patterns, cracked tiles
- Old fixtures (basin, toilet, shower)
- Mould or water damage signs

Kitchen indicators of needed renovation:
- Continuous stainless-steel combined sink-and-bench/countertop unit (old Swedish original kitchen indicator)
- White range hood (plasticky/basic) combined with otherwise dated kitchen
- White dishwasher (not integrated/panel-covered) combined with otherwise dated kitchen
- Laminate countertops when paired with dated fronts/fixtures
- Dated cabinet fronts
- No integrated appliances

General renovation indicators:
- Worn or dated flooring throughout
- Old radiators
- Dated wallpaper or paint
- Old electrical outlets/switches
- Original 60s/70s/80s interior untouched

Scoring scale (use the FULL 1-10 range — do NOT cluster in the middle):
- 1-2: Fully/newly renovated throughout — modern kitchen AND bathroom, move-in ready, no work needed.
- 3-4: Mostly modern; only minor cosmetic updates (paint, small fixes).
- 5-6: Partially dated; ONE of the kitchen or bathroom clearly needs renovation.
- 7-8: Clearly dated; BOTH kitchen and bathroom need renovation, dated finishes throughout.
- 9-10: Essentially original/untouched — e.g. an original Swedish kitchen (continuous steel sink-and-bench unit) AND an original bathroom (lino/blue tiles, old fixtures), dated throughout, needing a full gut renovation. This is maximum upside. Assign 9-10 whenever an apartment is genuinely untouched — do not shy away from the top of the scale.

Calibrate to the scale above based on the evidence; an untouched original apartment should score 9 or 10, not be capped at 7-8.

Coverage requirement:
- The app relies on seeing at least one kitchen image and one bathroom image when available.
- Include roomCoverage.kitchenVisible and roomCoverage.bathroomVisible.
- If kitchen or bathroom is missing from the provided photos, lower confidence and say what is missing in summary.

Respond with ONLY valid JSON, no markdown fences. Use this exact structure:
{
  "renovationScore": <1-10, where 10 = maximum renovation needed>,
  "confidence": <0.0-1.0>,
  "roomCoverage": {
    "kitchenVisible": <true|false>,
    "bathroomVisible": <true|false>,
    "analysedImageCount": <number>
  },
  "rooms": [
    {
      "type": "<bathroom|kitchen|living|bedroom|hallway|other>",
      "condition": "<original|dated|fair|renovated|newly_renovated>",
      "indicators": ["<specific indicator found>"],
      "estimatedCostSEK": <rough cost to renovate this room, null if not needed>
    }
  ],
  "summary": "<1-2 sentence summary of renovation potential>",
  "totalEstimatedCostSEK": <total estimated renovation cost>,
  "investmentPotential": "<high|medium|low>"
}`;

const TRIAGE_PROMPT = `You are a fast triage pass for a Swedish apartment renovation analyser. For each listing photo, identify the visible room type(s) and, for kitchens and bathrooms only, a coarse condition read.

Return ONLY valid JSON in this format:
{
  "images": [
    { "index": 0, "roomTypes": ["kitchen"], "condition": "renovated", "confidence": 0.0 }
  ]
}

roomTypes (one or more): kitchen, bathroom, living, bedroom, hallway, exterior, floorplan, other. For an open-plan kitchen/living space include both kitchen and living.

condition (set ONLY for photos containing a kitchen or bathroom; use null otherwise). For kitchens, judge the CABINET FRONTS and WORKTOP first:
- "renovated" — modern cabinet fronts (clean flat/slab or shaker, handleless or slim handles, no wear) AND a modern worktop (stone/quartz/composite or modern laminate), usually with integrated/built-in appliances. Classify as renovated EVEN IF a stainless-steel or farmhouse sink is present — new cabinets + new worktop outweigh the sink. For bathrooms: modern tiling, modern vanity/fixtures.
- "dated" — tired but not fully original: older finishes, partial updates, mixed old and new.
- "original" — clearly untouched: dated cabinet fronts TOGETHER WITH a continuous stainless-steel sink-and-bench unit and/or laminate worktop; for bathrooms, lino/blue tiles and old fixtures.

Do not call a kitchen "original" just because of a metal sink/worktop if the cabinet fronts are clearly modern. confidence is your 0.0-1.0 certainty. Only use "renovated" with high confidence when the cabinetry is unambiguously modern; when genuinely unsure between renovated and original, prefer "dated" with lower confidence.`;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found in model response");
    return JSON.parse(match[0]);
  }
}

// Stage 1 — cheap triage on TRIAGE_MODEL. Classifies every photo by room type
// and, for kitchen/bathroom photos, reads a coarse condition. The result both
// drives the gate (below) and feeds image selection for the expensive scoring
// call, so the expensive model never re-does classification.
async function triageRooms(images) {
  const classified = [];
  const batchSize = 12;

  for (let start = 0; start < images.length; start += batchSize) {
    const batch = images.slice(start, start + batchSize);
    const content = [
      {
        type: "text",
        text: `Triage these ${batch.length} listing photos. The first photo has index ${start}; return original indexes.`,
      },
      ...batch.flatMap((url, offset) => ([
        { type: "text", text: `Image index ${start + offset}` },
        { type: "image", source: { type: "url", url } },
      ])),
    ];

    const response = await client.messages.create({
      model: TRIAGE_MODEL,
      max_tokens: 900,
      system: TRIAGE_PROMPT,
      messages: [{ role: "user", content }],
    });

    const parsed = parseJson(response.content[0].text);
    if (Array.isArray(parsed.images)) {
      for (const item of parsed.images) {
        if (Number.isInteger(item.index)) classified.push(item);
      }
    }
  }

  return classified;
}

// A room is "modern" only when every classified photo of it reads as renovated
// with high confidence. Any dated/original/low-confidence photo — or no photo
// at all — leaves it not-modern, so the gate stays conservative.
function roomIsModern(classified, room) {
  const pics = classified.filter((c) => c.roomTypes?.includes(room) && c.condition);
  if (!pics.length) return false;
  return pics.every((c) => c.condition === "renovated" && (c.confidence ?? 0) >= 0.7);
}

// Gate out (skip the expensive score) only when triage is confident BOTH the
// kitchen and bathroom are already modern — i.e. low renovation upside, which
// is exactly the listing FlipHaus doesn't care about. Biased toward false
// positives: when in doubt, the listing falls through to the full score.
function triageGated(classified) {
  return roomIsModern(classified, "kitchen") && roomIsModern(classified, "bathroom");
}

// Cheap stand-in result for a gated listing, shaped like a real analysis so the
// downstream field mapping (renovationScore, roomCoverage, rooms…) is unchanged.
function buildGatedAnalysis(images) {
  const room = (type) => ({
    type,
    condition: "renovated",
    indicators: ["appears already modernised (cheap triage pass — not deep-scored)"],
    estimatedCostSEK: null,
  });
  return {
    renovationScore: 2,
    confidence: 0.6,
    roomCoverage: {
      kitchenVisible: true,
      bathroomVisible: true,
      analysedImageCount: 0,
      totalImageCount: images.length,
      selectionMethod: "triage-gated",
    },
    rooms: [room("kitchen"), room("bathroom")],
    summary:
      "Triage gate: kitchen and bathroom both appear already renovated, so renovation upside is low. Skipped full scoring to save cost — re-run a full analysis if this looks wrong.",
    totalEstimatedCostSEK: 0,
    investmentPotential: "low",
    triageGated: true,
  };
}

async function analyzeListingImages(images, listingInfo = {}) {
  if (!images || images.length === 0) {
    return null;
  }

  // Stage 1 — cheap triage. On failure, fall through and score without a gate
  // (never drop a listing because the cheap pass errored).
  let classified = null;
  try {
    classified = await triageRooms(images);
  } catch (err) {
    console.error(`  ✗ Triage failed, scoring without gate: ${err.message}`);
  }

  // Curate the photos we'll keep for display (wet-rooms-first, capped). Computed
  // once from the same triage pass and attached to every return path so the
  // caller can persist a consistent set regardless of gate outcome.
  const displayImages = selectDisplayImages(images, classified);

  // Coverage is measured against the photos we actually keep (displayImages),
  // not the wider analysis gallery — so kitchenPictured/bathroomPictured can't
  // claim a wet room the curated set dropped. When that set lacks a room,
  // self-heal re-hydrates the listing on a later run. Null when triage produced
  // no classification; the caller then falls back to the model's roomCoverage.
  const displayCoverage = coverageFromDisplaySet(images, displayImages, classified);

  // Gate: skip the expensive score when both wet rooms are already modern.
  if (classified && triageGated(classified)) {
    return { ...buildGatedAnalysis(images), displayImages, displayCoverage };
  }

  // Stage 2 — full renovation score on the expensive model.
  const { selectedImages, coverageSource } = selectImagesForAnalysis(images, classified);

  if (selectedImages.length === 0) {
    return null;
  }

  const kitchenCandidates = classified?.filter((img) => img.roomTypes?.includes("kitchen")).length ?? null;
  const bathroomCandidates = classified?.filter((img) => img.roomTypes?.includes("bathroom")).length ?? null;

  const content = [
    {
      type: "text",
      text: `Analyse these ${selectedImages.length} selected photos from ${images.length} total photos in a Stockholm apartment listing.${
        listingInfo.size ? ` Size: ${listingInfo.size}.` : ""
      }${listingInfo.rooms ? ` Rooms: ${listingInfo.rooms}.` : ""}${
        listingInfo.askingPrice ? ` Asking price: ${listingInfo.askingPrice}.` : ""
      } Selection method: ${coverageSource}.${
        kitchenCandidates != null ? ` Room classifier found ${kitchenCandidates} kitchen candidate(s) and ${bathroomCandidates} bathroom candidate(s) across all photos.` : ""
      } Pay special attention to the distinction between an old combined stainless-steel sink-and-bench unit and a modern intentional farmhouse/apron-front sink.`,
    },
    ...selectedImages.map((url) => ({
      type: "image",
      source: { type: "url", url },
    })),
  ];

  try {
    const response = await client.messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 1400,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });

    const analysis = parseJson(response.content[0].text);
    analysis.roomCoverage = {
      ...(analysis.roomCoverage || {}),
      analysedImageCount: selectedImages.length,
      totalImageCount: images.length,
      selectionMethod: coverageSource,
    };
    analysis.displayImages = displayImages;
    analysis.displayCoverage = displayCoverage;
    return analysis;
  } catch (err) {
    console.error(`  ✗ Analysis failed: ${err.message}`);
    return null;
  }
}

module.exports = { analyzeListingImages, selectImagesForAnalysis, selectDisplayImages, triageRooms, MAX_DISPLAY_IMAGES };
