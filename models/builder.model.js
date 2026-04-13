const mongoose = require("mongoose");
const crypto = require("crypto");

const builderSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  company: String,
  phone: String,
  token: { type: String, unique: true, default: () => crypto.randomBytes(32).toString("hex") },
  invitedAt: { type: Date, default: Date.now },
  lastLoginAt: Date,
});

module.exports = mongoose.model("Builder", builderSchema);
