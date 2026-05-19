const mongoose = require("mongoose");

const soldSchema = new mongoose.Schema({
  hemnetId: { type: String, unique: true },
  streetAddress: String,
  locationDescription: String,
  area: String,
  rooms: String,
  size: String,
  sizeNum: Number,
  askingPrice: String,
  askingPriceNum: Number,
  soldPrice: Number,
  soldPriceSqm: Number,
  priceChange: Number, // percentage over/under asking
  soldDate: Date,
  daysOnMarket: Number,
  housingForm: String,
  fee: String,
  feeNum: Number,
  buildYear: Number,
  brfName: { type: String, default: null },
  stambyteYear: { type: Number, default: null },
  stambyteStatus: { type: String, enum: ["done", "planned", "needed", "unknown", null], default: null },
  renovationScore: { type: Number, default: null },
  renovationConfidence: { type: Number, default: null },
  renovationSummary: { type: String, default: null },
  renovationRooms: { type: mongoose.Schema.Types.Mixed, default: null },
  conditionLabel: { type: String, enum: ["renovated", "partly_renovated", "unrenovated", "unknown", null], default: null },
  images: [String],
  link: String,
  scrapedAt: { type: Date, default: Date.now },
});

soldSchema.index({ area: 1, soldDate: -1 });
soldSchema.index({ brfName: 1, soldDate: -1 });

module.exports = mongoose.model("SoldListing", soldSchema);
