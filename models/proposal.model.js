const mongoose = require("mongoose");

const proposalSchema = new mongoose.Schema({
  assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Assignment", required: true, unique: true },
  builderId: { type: mongoose.Schema.Types.ObjectId, ref: "Builder", required: true },
  listingId: { type: String, required: true },
  estimatedCostSEK: { type: Number, required: true },
  costBreakdown: String,
  timelineWeeks: { type: Number, required: true },
  bufferWeeks: { type: Number, default: 4 },
  startDate: { type: Date, required: true },
  notes: String,
  submittedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Proposal", proposalSchema);
