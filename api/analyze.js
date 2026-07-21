const Anthropic = require("@anthropic-ai/sdk");
const { uniqueByUrl, selectImagesForAnalysis, selectDisplayImages, coverageFromDisplaySet, MAX_DISPLAY_IMAGES } = require("./image-selection");

const client = new Anthropic();

// Two-tier pipeline. A cheap WORKER pass triages every listing (room
// classification + a coarse kitchen/bathroom condition read) and gates out
// already-modern listings; the ARCHITECT pass then runs the full renovation
// score (1–10, room breakdown, cost estimate) on whatever isn't gated.
//
// The worker stays on Haiku 4.5 ($1/$5 per MTok): it runs on every photo of
// every listing, so it's the cost-sensitive stage, and it only classifies/gates.
// The architect runs on Sonnet 4.6 ($3/$15) — Haiku's renovation scores were too
// weak (the visible deal score), and the triage gate already limits how many
// listings reach this stage, so the extra cost is bounded. If Sonnet still isn't
// good enough, the next step up is ANALYSIS_MODEL=claude-opus-4-8 (Anthropic's
// strongest vision model: high-res images + better surface/material perception).
//
// Both env-overridable (no redeploy needed to retune). Note: the analyser passes
// no effort/thinking params — Haiku rejects them, and Sonnet/Opus run fine
// without — so a model swap stays a pure model swap. Keep it that way unless you
// add model-conditional thinking.
const TRIAGE_MODEL = process.env.TRIAGE_MODEL || "claude-haiku-4-5";
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are a Swedish apartment renovation analyst for FlipHaus, an investment platform that finds undervalued properties with renovation potential in Stockholm.

Analyse the listing photos and return a JSON assessment. The business goal is to identify apartments where renovation creates upside, especially kitchens and bathrooms.

Important kitchen rule — judge the cabinets, worktop and appliances FIRST:
The most reliable signal of a kitchen's age is the CABINET FRONTS, then the worktop, then the appliances. Decide "original vs renovated" from those before anything else. Do NOT let one dated-looking element (a sink, a tap, a tile) override clearly modern cabinetry.

- Signs the kitchen is RENOVATED / NEWLY RENOVATED (do NOT flag for renovation; score it low):
  - Cabinet doors are clean, consistent, modern fronts — flat/slab or simple shaker, often handleless or with slim bar/edge handles, in good condition with no wear. Doors sit FLUSH and tightly fitted in one even plane, with uniform narrow reveals and CONCEALED hinges.
  - Worktop is a solid modern surface: stone/quartz/composite, or a modern woodgrain/solid-colour laminate with a clean edge.
  - Appliances are integrated or panel-covered (or modern stainless built-ins), with an induction/ceramic hob and a discreet or integrated extractor.
  - If the cabinets AND worktop are clearly modern, classify the kitchen as renovated EVEN IF there is a stainless-steel sink, a farmhouse/apron-front sink, or another single older-looking detail. New cabinets + new worktop = a renovated kitchen.

- Signs the kitchen is ORIGINAL (flag for renovation; score it high) — these must appear TOGETHER, not in isolation:
  - A continuous shiny stainless-steel combined sink-and-bench/countertop unit (integrated drainer, metal worktop around the sink) COMBINED WITH dated cabinet fronts.
  - Dated cabinet fronts (worn laminate, old timber, 60s-80s hinges/handles), laminate worktops paired with those dated fronts, free-standing white appliances, no dishwasher.
  - Doors that sit slightly PROUD of the carcass with visible gaps between them and surface-mounted/exposed hinges, usually with chrome cup-pull or round-knob handles.

- A standalone farmhouse/apron-front/Belfast sink is NOT an "original" indicator. In a modern kitchen it is an intentional design choice — treat the kitchen as renovated and, if you mention the sink, note "farmhouse sink appears intentional".
- When the cabinets look modern but a metal worktop/sink tempts you to call it original, DEFAULT TO RENOVATED and lower your confidence rather than scoring it for a full renovation.

Door fit is a decisive age cue — judge it BEFORE colour: original mid-century Swedish cabinets have doors that sit slightly proud of the carcass with visible gaps and surface-mounted/exposed hinges; renovated cabinets have flush, tightly-fitted doors with even narrow reveals and concealed hinges. Do NOT call a kitchen "original" just because the fronts are plain or painted a pale/muted colour: a flat, flush, tightly-fitted front with concealed hinges is an UPDATE even if the styling is simple. Reserve "original" for doors that are clearly proud/gappy with exposed hinges — normally alongside a continuous steel sink-and-bench and a tiled splashback.

Bathroom rule — judge the WHOLE room, not one feature (same logic as the kitchen):
A bathroom is RENOVATED when the wet zone has modern FULL-WALL tiling (clean large-format or subway) with modern fixtures. It is ORIGINAL/DATED when SEVERAL of these appear TOGETHER:
- Vinyl/linoleum sheet flooring (plastmatta), especially blue or marbled blue/grey — a very common untouched-bathroom tell.
- Walls painted/untiled, OR carrying only a small PARTIAL splashback of dated small SQUARE tiles. A patch of old square tiles above a basin is a DATED signal, NOT "modern tiling".
- Dated tile patterns, cracked tiles, dated grout.
- Old fixtures: pedestal/wall-hung basin with exposed trap, separate hot/cold cross-handle taps, old toilet with separate cistern, bidet, wall-mounted tub mixer with hose.
- Surface-mounted/exposed wall pipes; an old tub with an exposed waste pipe dropping into the floor drain.
- Mould or water-damage signs.

Bathroom cautions (avoid false positives):
- A vinyl/plastmatta floor ON ITS OWN, in a bathroom with modern full-wall tiling and modern fixtures, is NOT a renovation trigger — it is an intentional, code-compliant budget choice ("kakel på vägg, matta på golv") and converting it to tile is high-cost/low-value. Only treat the vinyl floor as dated when the walls and/or fixtures are ALSO dated.
- An exposed tub waste pipe or a retained old tub is only a WEAK contextual clue (renovations often keep the old tub) — never raise the score on it alone.
- "Tiled walls = modern" means modern FULL wet-zone tiling, not a small dated square-tile splashback.

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

Renovation cost per room (estimatedCostSEK) — cost the ACTUAL WORK you identified, NOT the room type, and keep each room's cost consistent with its condition and your indicators/summary:
- Kitchen:
  - renovated / newly_renovated → null (no work).
  - COSMETIC — modern cabinet fronts AND worktop, only the appliances, a splashback, a tap or handles are dated → 10,000–30,000. A free-standing white cooker/fridge in an otherwise modern kitchen is an APPLIANCE swap, not a kitchen renovation — cost it here. If your indicators say the fronts are modern/updated, the kitchen CANNOT be a 90k+ full gut.
  - PARTIAL — some cabinetry/worktop dated but mixed old/new → 40,000–70,000.
  - FULL GUT — original: dated fronts with laminate/steel worktop needing NEW cabinets AND worktop → 90,000–150,000.
- Bathroom:
  - renovated / newly_renovated → null.
  - COSMETIC — sound modern wet zone, only a basin/tap/toilet/paint dated → 15,000–40,000.
  - FULL WET-ROOM RENO — dated/original needing re-tile + re-waterproof + new fixtures → 90,000–150,000.
Reserve the 90k+ bands for a kitchen that needs new cabinetry AND worktop, or a bathroom that needs a full re-tile/re-waterproof. totalEstimatedCostSEK is the sum of the per-room costs.

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

roomTypes (one or more): kitchen, bathroom, living, bedroom, hallway, exterior, floorplan, other. For an open-plan kitchen/living space include both kitchen and living. Tag a photo "bathroom" if it shows ANY of: a toilet/WC, a wash-basin or vanity, a shower or bathtub, a tiled wet wall, or a floor drain — even a partial, cropped or close-up shot. Don't miss bathrooms.

condition (set ONLY for photos containing a kitchen or bathroom; use null otherwise). For kitchens, judge the CABINET FRONTS and WORKTOP first:
- "renovated" — modern cabinet fronts (clean flat/slab or shaker, handleless or slim handles, no wear) AND a modern worktop (stone/quartz/composite or modern laminate), usually with integrated/built-in appliances. Classify as renovated EVEN IF a stainless-steel or farmhouse sink is present — new cabinets + new worktop outweigh the sink. For bathrooms: modern FULL-wall tiling AND modern fixtures (a vinyl/plastmatta floor with modern tiled walls + modern fixtures is still renovated — don't call it original for the floor alone).
- "dated" — tired but not fully original: older finishes, partial updates, mixed old and new.
- "original" — clearly untouched: cabinet doors that sit proud of the carcass with visible gaps and surface-mounted/exposed hinges (chrome cup-pull or knob handles), usually TOGETHER WITH a continuous stainless-steel sink-and-bench unit and/or laminate worktop; for bathrooms, SEVERAL dated cues together — vinyl/plastmatta floor (esp. blue), painted/untiled walls or only a small partial square-tile splashback, and old fixtures (exposed-trap basin, cross-handle taps, bidet). A small patch of old square tiles is dated, not modern tiling.

Do not call a kitchen "original" just because of a metal sink/worktop if the cabinet fronts are clearly modern. Judge door fit before colour: flush, tightly-fitted doors with concealed hinges are RENOVATED even if plain or pale-painted; reserve "original" for proud/gappy doors with exposed hinges. confidence is your 0.0-1.0 certainty. Only use "renovated" with high confidence when the cabinetry is unambiguously modern; when genuinely unsure between renovated and original, prefer "dated" with lower confidence.`;

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

async function analyzeListingImages(images, listingInfo = {}, options = {}) {
  if (!images || images.length === 0) {
    return null;
  }
  // Per-call overrides used by the manual "reanalyze" button: force a specific
  // scoring model (e.g. claude-opus-4-8) and skip the triage gate so a listing
  // mis-gated as "already renovated" still gets a full fresh score.
  const scoringModel = options.analysisModel || ANALYSIS_MODEL;
  const forceScore = !!options.forceScore;

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
  // A forced (manual) reanalyze bypasses the gate — its whole purpose is to
  // re-judge a listing the cheap pass may have mis-gated.
  if (!forceScore && classified && triageGated(classified)) {
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
      model: scoringModel,
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
