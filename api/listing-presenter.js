function toPlainListing(listing) {
  return typeof listing?.toObject === "function" ? listing.toObject() : { ...(listing || {}) };
}

function presentListingForFeed(listing, preferenceStatus = null) {
  const plain = toPlainListing(listing);
  const lifecycleStatus = plain.status || "unknown";

  return {
    ...plain,
    status: lifecycleStatus,
    listingStatus: lifecycleStatus,
    preferenceStatus: preferenceStatus || null,
  };
}

module.exports = {
  presentListingForFeed,
  toPlainListing,
};
