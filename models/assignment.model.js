const mongoose = require("mongoose");

const assignmentSchema = new mongoose.Schema({
  listingId: { type: String, required: true },
  builderId: { type: mongoose.Schema.Types.ObjectId, ref: "Builder", required: true },
  status: {
    type: String,
    enum: ["pending", "proposed", "accepted", "declined"],
    default: "pending",
  },
  assignedAt: { type: Date, default: Date.now },
  note: String,
});

assignmentSchema.index({ listingId: 1, builderId: 1 }, { unique: true });

module.exports = mongoose.model("Assignment", assignmentSchema);
