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
  // AI renovation analysis
  renovationScore: { type: Number, default: null },
  renovationConfidence: { type: Number, default: null },
  renovationSummary: { type: String, default: null },
  renovationRooms: { type: mongoose.Schema.Types.Mixed, default: null },
  totalEstimatedCostSEK: { type: Number, default: null },
  investmentPotential: { type: String, enum: ["high", "medium", "low", null], default: null },
  analyzedAt: { type: Date, default: null },
});

module.exports = mongoose.model("Listing", listingSchema);
