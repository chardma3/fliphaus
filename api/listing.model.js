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
  // When this listing was first inserted (set once, on upsert insert). Drives the
  // daily digest's "new listings found" — scrapeDate/lastSeenAt can't, they update
  // every scrape. Null on listings that predate this field.
  firstSeenAt: { type: Date, default: null },
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
  // Renovation/resale intelligence (sold-comp analysis) is PRECOMPUTED after each
  // daily sold refresh and on manual reanalyse, then stored here — so the feed
  // reads it instead of re-crunching the whole sold set on every request. See
  // api/precompute-estimates.js. brfIntelligenceAt stamps when it was last built,
  // for the freshness check on /api/scrape-health and the diagnostic script.
  brfIntelligence: { type: mongoose.Schema.Types.Mixed, default: null },
  brfIntelligenceAt: { type: Date, default: null },
  analyzedAt: { type: Date, default: null },
  // Set whenever an analysis run attempts to hydrate this listing's full
  // detail-page gallery — success OR failure. Used with galleryHydrationAttempts
  // to space out and bound the self-heal retries (see buildAnalysisQuery), so a
  // flaky hydration heals on a later run while a permanently un-hydratable page
  // (delisted / 404 / genuinely photo-poor) eventually stops. Null = never tried.
  galleryHydrationAttemptedAt: { type: Date, default: null },
  // How many times we've attempted to hydrate the full gallery. Caps the
  // self-heal retry loop so we don't re-analyse an un-hydratable listing forever.
  galleryHydrationAttempts: { type: Number, default: 0 },
  // Curated sharing: the admin hand-picks which listings friends see, rather than
  // exposing the whole feed. sharedWithFriends gates the friends dashboard; the
  // friends `/api/listings` intersects its view with sharedWithFriends: true.
  // sharedAt records when it was shared (for future "recently shared" ordering).
  // Phase 1 is a single global shared set; per-recipient targeting comes later.
  sharedWithFriends: { type: Boolean, default: false, index: true },
  sharedAt: { type: Date, default: null },
});

module.exports = mongoose.model("Listing", listingSchema);
