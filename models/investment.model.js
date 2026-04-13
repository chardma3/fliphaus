const mongoose = require("mongoose");

const investmentSchema = new mongoose.Schema({
  listingId: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "HemnetUser", required: true },
  amountSEK: { type: Number, required: true, min: 1 },
  investedAt: { type: Date, default: Date.now },
});

investmentSchema.index({ listingId: 1, userId: 1 });

module.exports = mongoose.model("Investment", investmentSchema);
