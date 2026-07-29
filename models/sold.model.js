const mongoose = require("mongoose");

const soldSchema = new mongoose.Schema({
  // SPARSE because a sold record can now come from a source other than Hemnet.
  // Without sparse, every Booli-only document would store hemnetId: null and the
  // SECOND one would violate the unique index. Changing this definition does NOT
  // rebuild the existing index — run scripts/migrate-sold-sources.js once.
  hemnetId: { type: String, unique: true, sparse: true },
  booliId: { type: String, default: null, unique: true, sparse: true },
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
  // Floor + coordinates are what api/listing-fingerprint.js scores on to tell two
  // same-size flats in one building apart. Hemnet's sold scrape doesn't supply
  // them yet; Booli does, so storing them makes future cross-source matches
  // sharper rather than relying on address+size alone.
  floor: { type: Number, default: null },
  coordinates: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },
  // Provenance, mirroring the same field on api/listing.model.js. A sale seen on
  // both Hemnet and Booli is ONE document with two source entries — duplicating it
  // would double-weight that sale in the kr/m² percentile the resale estimate
  // rests on.
  sources: {
    type: [
      {
        _id: false,
        source: String, // "hemnet" | "booli" | ...
        sourceId: String, // that source's own id for this sale
        url: String,
        firstSeen: Date,
      },
    ],
    default: [],
  },
  fingerprintKey: { type: String, default: null, index: true },
});

soldSchema.index({ area: 1, soldDate: -1 });
soldSchema.index({ brfName: 1, soldDate: -1 });

// Index management for THIS collection is explicit (scripts/migrate-sold-sources.js
// → syncIndexes), not automatic on boot. Reason: production already carries a
// non-sparse unique `hemnetId_1`. With autoIndex on, every deploy would ask Mongo
// to build the same-named index with different options, which fails with an
// IndexOptionsConflict — and a failed autoIndex build surfaces as an error event
// on the model, i.e. a possible crash on startup for a purely cosmetic reason.
// Dropping + rebuilding once, deliberately, is safer than racing it on every boot.
soldSchema.set("autoIndex", false);

module.exports = mongoose.model("SoldListing", soldSchema);
