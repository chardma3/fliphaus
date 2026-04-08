const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a Swedish apartment renovation analyst for FlipHaus, an investment platform that finds undervalued properties with renovation potential in Stockholm.

Analyse the listing photos and return a JSON assessment. Focus on identifying:

**Bathroom indicators of needed renovation:**
- Linoleum or vinyl flooring (very common in older Swedish apartments)
- Blue flooring or blue tiles
- Dated tile patterns, cracked tiles
- Old fixtures (basin, toilet, shower)
- Mould or water damage signs

**Kitchen indicators of needed renovation:**
- White range hood (plastiga/basic)
- White dishwasher (not integrated/panel-covered)
- Combined sink and bench in shiny metallic/stainless steel (old-style)
- Laminate countertops
- Dated cabinet fronts
- No integrated appliances

**General renovation indicators:**
- Worn or dated flooring throughout
- Old radiators
- Dated wallpaper or paint
- Old electrical outlets/switches
- Original 60s/70s/80s interior untouched

Respond with ONLY valid JSON, no markdown fences. Use this exact structure:
{
  "renovationScore": <1-10, where 10 = maximum renovation needed>,
  "confidence": <0.0-1.0>,
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

async function analyzeListingImages(images, listingInfo = {}) {
  // Use up to 6 images to keep costs reasonable
  const selectedImages = images.slice(0, 6);

  if (selectedImages.length === 0) {
    return null;
  }

  const content = [
    {
      type: "text",
      text: `Analyse these ${selectedImages.length} photos from a Stockholm apartment listing.${
        listingInfo.size ? ` Size: ${listingInfo.size}.` : ""
      }${listingInfo.rooms ? ` Rooms: ${listingInfo.rooms}.` : ""}${
        listingInfo.askingPrice ? ` Asking price: ${listingInfo.askingPrice}.` : ""
      }`,
    },
    ...selectedImages.map((url) => ({
      type: "image",
      source: { type: "url", url },
    })),
  ];

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });

    const text = response.content[0].text;
    return JSON.parse(text);
  } catch (err) {
    console.error(`  ✗ Analysis failed: ${err.message}`);
    return null;
  }
}

module.exports = { analyzeListingImages };
