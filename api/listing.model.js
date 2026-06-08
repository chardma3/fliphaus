const mongoose = require("mongoose");

const listingSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  slug: String,
  streetAddress: String,
  locationDescription: String,
  // Hemnet search area this listing was scraped from (e.g. "Rissne", "Farsta").
  // Set in api/scrape.js; previously dropped by Mongoose strict mode because the
  // field was undeclared. Indexed for per-area queries and disappearance
  // reconciliation scoping.
  area: { type: String, default: null, index: true },
  housingForm: String,
  rooms: String,
  size: String,
  askingPrice: String,
  askingPriceNum: Number,
  fee: String,
  floor: String,
  squareMeterPrice: String,
  brokerAgencyName: String,
  description: String,
  nextShowing: String,
  link: String,
  thumbnail: String,
  images: [String],
  hasFloorPlan: { type: Boolean, default: null },
  coordinates: { lat: Number, lng: Number },
  publishedAt: Date,
  scrapeDate: String,
  // Status
  status: { type: String, enum: ["active", "confirmed_sold", "disappeared", "removed", "unknown", "sold"], default: "active" },
  soldDate: { type: Date, default: null },
  soldPrice: { type: Number, default: null },
  daysOnMarket: { type: Number, default: null },
  disappearedAt: { type: Date, default: null },
  lastSeenAt: { type: Date, default: null },
  soldStatusConfidence: { type: String, enum: ["confirmed", "unconfirmed", "unknown", null], default: null },
  soldListingId: { type: mongoose.Schema.Types.ObjectId, ref: "SoldListing", default: null },
  matchedSoldHemnetId: { type: String, default: null },
  soldMatchScore: { type: Number, default: null },
  // Transit
  transitMinutes: { type: Number, default: null },
  nearestStation: { type: String, default: null },
  transitLine: { type: String, default: null },
  // BRF info
  brfName: { type: String, default: null },
  buildYear: { type: Number, default: null },
  totalApartments: { type: Number, default: null },
  brfDebtPerSqm: { type: Number, default: null },
  stambyteYear: { type: Number, default: null },
  stambyteStatus: { type: String, enum: ["done", "planned", "needed", "unknown", null], default: null },
  renovationRules: { type: String, default: null },
  // Image coverage (set during analysis): whether the kitchen/bathroom were
  // actually visible in the analysed photos. imageCoverageComplete is true only
  // when both were seen — otherwise the renovation score is provisional.
  kitchenPictured: { type: Boolean, default: null },
  bathroomPictured: { type: Boolean, default: null },
  imageCoverageComplete: { type: Boolean, default: null },
  // True when the cheap triage pass gated this listing out as already-modern
  // (both wet rooms confidently renovated) and skipped the full score — the
  // score is a low-potential stand-in, not a deep analysis. Null = never analysed.
  triageGated: { type: Boolean, default: null },
  // AI renovation analysis
  renovationScore: { type: Number, default: null },
  renovationConfidence: { type: Number, default: null },
  renovationSummary: { type: String, default: null },
  renovationRooms: { type: mongoose.Schema.Types.Mixed, default: null },
  totalEstimatedCostSEK: { type: Number, default: null },
  investmentPotential: { type: String, enum: ["high", "medium", "low", null], default: null },
  brfIntelligence: { type: mongoose.Schema.Types.Mixed, default: null },
  analyzedAt: { type: Date, default: null },
  // Set whenever an analysis run attempts to hydrate this listing's full
  // detail-page gallery — success OR failure. Once set, the thumbnail-only
  // re-pick stops selecting the listing, so a permanently un-hydratable page
  // (e.g. a delisted listing whose detail page 404s / lacks __NEXT_DATA__)
  // can't be re-analysed forever. Null = never attempted.
  galleryHydrationAttemptedAt: { type: Date, default: null },
});

module.exports = mongoose.model("Listing", listingSchema);
