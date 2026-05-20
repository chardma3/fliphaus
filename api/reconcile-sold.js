function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(st|street|gatan|gränd|grand|vägen|vagen)\b/g, "")
    .replace(/[^a-z0-9åäö\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = parseFloat(String(value).replace(",", ".").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstAreaToken(value) {
  return normalizeText(value).split(/,|\s+-\s+|\s/).filter(Boolean)[0] || "";
}

function tokenOverlap(a, b) {
  const aTokens = new Set(normalizeText(a).split(" ").filter(Boolean));
  const bTokens = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;
  let shared = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) shared += 1;
  }
  return shared / Math.max(aTokens.size, bTokens.size);
}

function scoreSoldMatch(listing, sold) {
  let score = 0;
  const reasons = [];
  const listingAddress = normalizeText(listing.streetAddress);
  const soldAddress = normalizeText(sold.streetAddress);

  if (listingAddress && soldAddress && listingAddress === soldAddress) {
    score += 55;
    reasons.push("address exact");
  } else {
    const overlap = tokenOverlap(listing.streetAddress, sold.streetAddress);
    if (overlap >= 0.75) {
      score += 35;
      reasons.push("address close");
    }
  }

  const listingSize = parseNumber(listing.sizeNum ?? listing.size);
  const soldSize = parseNumber(sold.sizeNum ?? sold.size);
  if (listingSize != null && soldSize != null) {
    const diff = Math.abs(listingSize - soldSize);
    if (diff <= 2) {
      score += 20;
      reasons.push("size within 2sqm");
    } else if (diff <= 5) {
      score += 8;
      reasons.push("size close");
    }
  }

  const listingRooms = parseNumber(listing.rooms);
  const soldRooms = parseNumber(sold.rooms);
  if (listingRooms != null && soldRooms != null) {
    const diff = Math.abs(listingRooms - soldRooms);
    if (diff === 0) {
      score += 10;
      reasons.push("rooms exact");
    } else if (diff <= 0.5) {
      score += 5;
      reasons.push("rooms close");
    }
  }

  const listingArea = firstAreaToken(listing.locationDescription || listing.area);
  const soldArea = firstAreaToken(sold.locationDescription || sold.area);
  if (listingArea && soldArea && listingArea === soldArea) {
    score += 10;
    reasons.push("same area");
  }

  if (listing.brfName && sold.brfName && normalizeText(listing.brfName) === normalizeText(sold.brfName)) {
    score += 10;
    reasons.push("same BRF");
  }

  return { score, reasons };
}

function findBestSoldMatch(listing, soldListings, threshold = 80) {
  const candidates = (soldListings || [])
    .map((sold) => ({ sold, ...scoreSoldMatch(listing, sold) }))
    .sort((a, b) => b.score - a.score);
  const best = candidates[0] || null;
  if (!best || best.score < threshold) return null;
  return best;
}

async function reconcileSoldListings({ Listing, SoldListing, threshold = 80 } = {}) {
  if (!Listing || !SoldListing) throw new Error("Listing and SoldListing models are required");
  const listings = await Listing.find({ status: { $in: ["disappeared", "unknown"] } });
  const soldListings = await SoldListing.find({});
  let confirmed = 0;

  for (const listing of listings) {
    const listingObj = typeof listing.toObject === "function" ? listing.toObject() : listing;
    const soldObjs = soldListings.map((sold) => (typeof sold.toObject === "function" ? sold.toObject() : sold));
    const match = findBestSoldMatch(listingObj, soldObjs, threshold);
    if (!match) continue;

    await Listing.findByIdAndUpdate(listing._id, {
      status: "confirmed_sold",
      soldPrice: match.sold.soldPrice || null,
      soldDate: match.sold.soldDate || null,
      soldStatusConfidence: "confirmed",
      soldListingId: match.sold._id || null,
      matchedSoldHemnetId: match.sold.hemnetId || null,
      soldMatchScore: match.score,
    });
    confirmed += 1;
  }

  return { checked: listings.length, confirmed };
}

module.exports = {
  normalizeText,
  parseNumber,
  scoreSoldMatch,
  findBestSoldMatch,
  reconcileSoldListings,
};
