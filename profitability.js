(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function sortListingsByProfit(listings, direction = "desc", calcInvestmentFn) {
    const multiplier = direction === "asc" ? 1 : -1;
    return [...(listings || [])].sort((a, b) => {
      const aProfit = calcInvestmentFn(a).profit || 0;
      const bProfit = calcInvestmentFn(b).profit || 0;
      return (aProfit - bProfit) * multiplier;
    });
  }

  return { sortListingsByProfit };
});
