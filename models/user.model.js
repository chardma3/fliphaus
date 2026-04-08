const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true },
  email: String,
  name: String,
  avatar: String,
  settings: {
    maxPrice: { type: Number, default: 4000000 },
    areas: {
      type: [String],
      default: ["Bromma","Blackeberg","Rissne","Kista","Sollentuna","Skarpnäck","Bagarmossen","Farsta","Enskede","Hökarängen"],
    },
  },
});

module.exports = mongoose.model("HemnetUser", userSchema);
