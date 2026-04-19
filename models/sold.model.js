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
  images: [String],
  link: String,
  scrapedAt: { type: Date, default: Date.now },
});

soldSchema.index({ area: 1, soldDate: -1 });

module.exports = mongoose.model("SoldListing", soldSchema);
