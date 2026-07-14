// Precompute each active listing's renovation/resale intelligence (the sold-comp
// "crunching") once — after the daily sold refresh and on manual reanalyse — and
// store it on the listing, so the feed reads a stored value instead of loading
// and indexing the whole sold set on every page request. This is what makes the
// dashboard load fast and removes the memory spike that collided with the scrape.
//
// Freshness: the sold data only changes once a day (the scrape), so recomputing
// right after each refresh keeps the stored estimate exactly as fresh as its
// inputs. New/just-reanalysed listings are recomputed on the spot via `ids`.
const { buildBrfIntelligence, buildSoldIndex } = require("./brf-intelligence");

// The only sold fields buildBrfIntelligence / buildSoldIndex actually read. We
// project to these so we never pull the large images[] arrays (or other unused
// columns) into memory — issue 2: stop collecting/crunching data we don't use.
const SOLD_COMP_FIELDS = {
  soldPriceSqm: 1,
  brfName: 1,
  locationDescription: 1,
  area: 1,
  soldDate: 1,
  conditionLabel: 1,
  renovationScore: 1,
  size: 1,
  sizeNum: 1,
};

// Load the sold set (lean, projected) and build the shared comp index once.
async function loadSoldIndex(SoldListing) {
  const sold = await SoldListing.find({}, SOLD_COMP_FIELDS).sort({ soldDate: -1 }).lean();
  return buildSoldIndex(sold);
}

// Compute + persist brfIntelligence for active listings (or a specific `ids`
// subset). Pass a prebuilt `soldIndex` to reuse one across calls; otherwise it's
// loaded once here. Returns { updated, at } for the run log.
async function precomputeEstimates({ Listing, SoldListing, ids = null, soldIndex = null } = {}) {
  const index = soldIndex || (await loadSoldIndex(SoldListing));
  const query = ids && ids.length ? { id: { $in: ids } } : { status: "active" };
  const listings = await Listing.find(query).lean();
  const at = new Date();

  const ops = listings.map((listing) => ({
    updateOne: {
      filter: { _id: listing._id },
      update: { $set: { brfIntelligence: buildBrfIntelligence(listing, index), brfIntelligenceAt: at } },
    },
  }));
  if (ops.length) await Listing.bulkWrite(ops, { ordered: false });
  return { updated: ops.length, at };
}

module.exports = { precomputeEstimates, loadSoldIndex, SOLD_COMP_FIELDS };
