const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { AREA_NAMES } = require("../api/hemnet-refresh-safety");

const userSchema = new mongoose.Schema({
  googleId: { type: String, sparse: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: String,
  name: String,
  avatar: String,
  role: { type: String, enum: ["admin", "investor", "friend"], default: "investor" },
  settings: {
    maxPrice: { type: Number, default: 4000000 },
    areas: {
      type: [String],
      default: () => [...AREA_NAMES],
    },
  },
  createdAt: { type: Date, default: Date.now },
});

// Mongoose 9 does not pass a `next` callback to async middleware — completion is
// signalled by the returned promise resolving. Taking `next` and calling it threw
// "next is not a function", which broke every email/password signup. Just return.
userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;
  this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model("HemnetUser", userSchema);
