const mongoose = require("mongoose");

const listingSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  slug: String,
  streetAddress: String,
  locationDescription: String,
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
  status: { type: String, enum: ["active", "sold", "removed"], default: "active" },
  soldDate: { type: Date, default: null },
  soldPrice: { type: Number, default: null },
  daysOnMarket: { type: Number, default: null },
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
  // AI renovation analysis
  renovationScore: { type: Number, default: null },
  renovationConfidence: { type: Number, default: null },
  renovationSummary: { type: String, default: null },
  renovationRooms: { type: mongoose.Schema.Types.Mixed, default: null },
  totalEstimatedCostSEK: { type: Number, default: null },
  investmentPotential: { type: String, enum: ["high", "medium", "low", null], default: null },
  brfIntelligence: { type: mongoose.Schema.Types.Mixed, default: null },
  analyzedAt: { type: Date, default: null },
});

module.exports = mongoose.model("Listing", listingSchema);
