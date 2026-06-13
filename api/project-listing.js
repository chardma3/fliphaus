// New-build / "projekt" listings on Hemnet are addressed by the development's
// NAME (e.g. "Sjöhusen i Klockelund", "Fransyskan", "Haga Palett Ockra") rather
// than a numbered street address, and their detail pages use a different format
// we can't parse for a photo gallery. They're new construction — already
// renovated, not renovation flips — so they're kept out of the Deals / Move-in
// ready views and skipped by the analyser, but surfaced in their own "New
// builds" tab as market data.
//
// Heuristic: a real apartment address always carries a street number; a project
// name has no digit anywhere. (A missing address is NOT treated as a project.)
const PROJECT_ADDRESS = /^[^0-9]+$/;

function isProjectListing(listing) {
  const addr = typeof listing === "string" ? listing : listing?.streetAddress;
  return !!addr && PROJECT_ADDRESS.test(addr);
}

module.exports = { isProjectListing, PROJECT_ADDRESS };
