const mongoose = require("mongoose");

const preferenceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "HemnetUser", required: true },
  listingId: { type: String, required: true },
  status: { type: String, enum: ["saved", "rejected"], required: true },
});

preferenceSchema.index({ userId: 1, listingId: 1 }, { unique: true });

module.exports = mongoose.model("HemnetPreference", preferenceSchema);
