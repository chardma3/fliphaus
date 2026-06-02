const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a Swedish apartment renovation analyst for FlipHaus, an investment platform that finds undervalued properties with renovation potential in Stockholm.

Analyse the listing photos and return a JSON assessment. The business goal is to identify apartments where renovation creates upside, especially kitchens and bathrooms.

Important kitchen rule:
- DO flag an old/original Swedish kitchen when you see a continuous shiny stainless-steel combined sink-and-bench/countertop unit, often with integrated draining board and metal worktop around the sink. This usually indicates an original kitchen needing renovation.
- DO NOT flag a standalone farmhouse/apron-front/Belfast-style sink as old just because it looks vintage. In a recently renovated kitchen, a farmhouse sink is often an intentional design feature. Treat it as renovated/newly_renovated if the surrounding cabinetry, worktop, taps, lighting and appliances look modern.
- If a kitchen has modern fronts/worktops/appliances but a vintage-style sink, call out "farmhouse sink appears intentional" and do not increase the renovation score for that sink alone.

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

const ROOM_CLASSIFIER_PROMPT = `Classify each apartment listing photo by visible room type.
Return ONLY valid JSON in this format:
{
  "images": [
    { "index": 0, "roomTypes": ["kitchen"], "confidence": 0.0 }
  ]
}
Use roomTypes from: kitchen, bathroom, living, bedroom, hallway, exterior, floorplan, other.
If a photo contains an open-plan kitchen/living space, include both kitchen and living.`;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found in model response");
    return JSON.parse(match[0]);
  }
}

function uniqueByUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    const url = typeof item === "string" ? item : item.url;
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

async function classifyRooms(images) {
  const classified = [];
  const batchSize = 12;

  for (let start = 0; start < images.length; start += batchSize) {
    const batch = images.slice(start, start + batchSize);
    const content = [
      {
        type: "text",
        text: `Classify these ${batch.length} listing photos. The first photo has index ${start}; return original indexes.`,
      },
      ...batch.flatMap((url, offset) => ([
        { type: "text", text: `Image index ${start + offset}` },
        { type: "image", source: { type: "url", url } },
      ])),
    ];

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 900,
      system: ROOM_CLASSIFIER_PROMPT,
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

async function selectImagesForAnalysis(images) {
  const maxAnalysisImages = 12;

  if (images.length <= maxAnalysisImages) {
    return { selectedImages: images, coverageSource: "all", classified: null };
  }

  try {
    const classified = await classifyRooms(images);
    const kitchen = classified
      .filter((img) => img.roomTypes?.includes("kitchen"))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 4)
      .map((img) => ({ url: images[img.index], reason: "kitchen" }));

    const bathroom = classified
      .filter((img) => img.roomTypes?.includes("bathroom"))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 4)
      .map((img) => ({ url: images[img.index], reason: "bathroom" }));

    const evenlySpaced = Array.from({ length: maxAnalysisImages }, (_, i) => {
      const index = Math.floor((i * images.length) / maxAnalysisImages);
      return { url: images[index], reason: "overview" };
    });

    const selected = uniqueByUrl([...kitchen, ...bathroom, ...evenlySpaced])
      .slice(0, maxAnalysisImages)
      .map((item) => item.url);

    return { selectedImages: selected, coverageSource: "room-classifier", classified };
  } catch (err) {
    console.error(`  ✗ Room classification failed, falling back to spread selection: ${err.message}`);
    const step = images.length / maxAnalysisImages;
    const selectedImages = Array.from({ length: maxAnalysisImages }, (_, i) => images[Math.floor(i * step)]);
    return { selectedImages, coverageSource: "fallback-spread", classified: null };
  }
}

async function analyzeListingImages(images, listingInfo = {}) {
  if (!images || images.length === 0) {
    return null;
  }

  const { selectedImages, coverageSource, classified } = await selectImagesForAnalysis(images);

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
      model: "claude-sonnet-4-6",
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
    return analysis;
  } catch (err) {
    console.error(`  ✗ Analysis failed: ${err.message}`);
    return null;
  }
}

module.exports = { analyzeListingImages, selectImagesForAnalysis };
