const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { AREA_NAMES } = require("../api/hemnet-refresh-safety");

const userSchema = new mongoose.Schema({
  googleId: { type: String, sparse: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: String,
  name: String,
  avatar: String,
  role: { type: String, enum: ["admin", "investor"], default: "investor" },
  settings: {
    maxPrice: { type: Number, default: 4000000 },
    areas: {
      type: [String],
      default: () => [...AREA_NAMES],
    },
  },
  createdAt: { type: Date, default: Date.now },
});

userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model("HemnetUser", userSchema);
