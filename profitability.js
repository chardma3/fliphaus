(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const RENOVATED_SQM = {
    Rissne: 42500,
    Sundbyberg: 43000,
    Duvbo: 42500,
    Hallonbergen: 28000,
    Farsta: 45600,
    Sköndal: 50400,
    Fagersjö: 31000,
    Gubbängen: 46000,
    Hökarängen: 60000,
    Tallkrogen: 46000,
    Enskede: 52600,
    Bagarmossen: 46000,
    Skarpnäck: 50000,
    Bromma: 50000,
    Kista: 38000,
    Sollentuna: 42000,
    Järvastaden: 56000,
  };
  const DEFAULT_RENOVATED_SQM = 45000;
  const MIN_RENOVATION_COST_FOR_UPSIDE = 75000;
  const MOVE_IN_READY_SIGNALS = [
    /move[-\s]?in ready/i,
    /substantially renovated/i,
    /recently renovated/i,
    /newly renovated/i,
    /low renovation upside/i,
    /minimal upside/i,
  ];

  function parseNumber(value) {
    if (value == null) return 0;
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const normalized = String(value).replace(",", ".").replace(/[^\d.-]/g, "");
    return parseFloat(normalized) || 0;
  }

  function getAreaSqmPrice(locationDesc) {
    if (!locationDesc) return DEFAULT_RENOVATED_SQM;
    const loc = String(locationDesc).toLowerCase();
    for (const [area, price] of Object.entries(RENOVATED_SQM)) {
      if (loc.includes(area.toLowerCase())) return price;
    }
    return DEFAULT_RENOVATED_SQM;
  }

  function hasMoveInReadySignal(listing) {
    const text = [listing?.renovationSummary, listing?.description]
      .filter(Boolean)
      .join(" ");
    return MOVE_IN_READY_SIGNALS.some((pattern) => pattern.test(text));
  }

  function hasLowComparableConfidence(listing) {
    const arb = listing?.brfIntelligence?.renovationArbitrage;
    return arb?.confidence === "low" && arb?.estimatedUpliftTotal == null;
  }

  function isRenovationUpsideCandidate(listing) {
    if (!listing) return false;
    if (listing.renovationScore != null && listing.renovationScore <= 3) return false;
    if (listing.investmentPotential === "low") return false;
    if ((listing.totalEstimatedCostSEK || 0) < MIN_RENOVATION_COST_FOR_UPSIDE) return false;
    if (hasMoveInReadySignal(listing)) return false;
    return (listing.renovationScore != null && listing.renovationScore >= 5) || ["medium", "high"].includes(listing.investmentPotential);
  }

  function calcInvestment(listing) {
    const price = parseNumber(listing?.askingPriceNum || listing?.askingPrice);
    const sizeNum = parseNumber(listing?.sizeNum || listing?.size);
    const feeNum = parseNumber(listing?.feeNum || listing?.fee);
    const renoCost = parseNumber(listing?.totalEstimatedCostSEK);
    const deposit = Math.round(price * 0.15);
    const months = 7;
    const carryingCost = feeNum * months;
    const totalInvestment = deposit + renoCost + carryingCost;
    const sqmPrice = getAreaSqmPrice(listing?.locationDescription || listing?.area);
    const estimatedRenovatedSalePrice = sizeNum > 0 ? Math.round(sizeNum * sqmPrice) : 0;
    const grossMarketGap = estimatedRenovatedSalePrice > 0 ? estimatedRenovatedSalePrice - price : 0;
    const renovationProfit = estimatedRenovatedSalePrice > 0 ? grossMarketGap - renoCost - carryingCost : 0;
    const roi = totalInvestment > 0 && renovationProfit > 0 ? Math.round((renovationProfit / totalInvestment) * 100) : 0;
    const candidate = isRenovationUpsideCandidate(listing);
    const lowComparableConfidence = hasLowComparableConfidence(listing);

    let classification = "insufficient-data";
    if (!price || !sizeNum || !estimatedRenovatedSalePrice) {
      classification = "insufficient-data";
    } else if (!candidate) {
      classification = grossMarketGap > 0 ? "market-gap" : "low-upside";
    } else if (lowComparableConfidence && renovationProfit > 0) {
      classification = "preliminary-renovation-upside";
    } else if (lowComparableConfidence) {
      classification = "insufficient-data";
    } else if (renovationProfit > 0) {
      classification = "renovation-upside";
    } else {
      classification = "unprofitable";
    }

    const displayProfit = ["renovation-upside", "preliminary-renovation-upside", "unprofitable"].includes(classification) ? renovationProfit : 0;

    return {
      price,
      deposit,
      renoCost,
      carryingCost,
      feeNum,
      months,
      totalInvestment,
      estSalePrice: estimatedRenovatedSalePrice,
      estimatedRenovatedSalePrice,
      grossMarketGap,
      profit: displayProfit,
      renovationProfit,
      roi: classification === "renovation-upside" ? roi : 0,
      sizeNum,
      sqmPrice,
      classification,
      lowComparableConfidence,
      isRenovationUpsideCandidate: candidate,
    };
  }

  function formatProfitBadgeModel(listing) {
    const calc = calcInvestment(listing);
    if (calc.classification === "renovation-upside") {
      return {
        type: "renovation-upside",
        cssClass: "positive",
        label: `+${formatSEKShort(calc.renovationProfit)} (${calc.roi}% ROI)`,
        detail: "Renovation upside",
        profit: calc.renovationProfit,
        roi: calc.roi,
        calc,
      };
    }
    if (calc.classification === "preliminary-renovation-upside") {
      return {
        type: "preliminary-renovation-upside",
        cssClass: "cautious",
        label: `~+${formatSEKShort(calc.renovationProfit)}`,
        detail: "Preliminary estimate — needs similar sold properties",
        profit: calc.renovationProfit,
        roi: null,
        calc,
      };
    }
    if (calc.classification === "market-gap") {
      return {
        type: "market-gap",
        cssClass: "cautious",
        label: "Possible market gap",
        detail: "Already renovated / low renovation upside",
        profit: null,
        roi: null,
        calc,
      };
    }
    if (calc.lowComparableConfidence) {
      return {
        type: "insufficient-data",
        cssClass: "neutral",
        label: "Needs similar sales",
        detail: "Insufficient similar sold-property evidence",
        profit: null,
        roi: null,
        calc,
      };
    }
    if (calc.classification === "low-upside") {
      return {
        type: "low-upside",
        cssClass: "neutral",
        label: "Move-in ready",
        detail: "Low renovation upside",
        profit: null,
        roi: null,
        calc,
      };
    }
    if (calc.classification === "unprofitable") {
      return {
        type: "unprofitable",
        cssClass: "negative",
        label: formatSEKShort(calc.renovationProfit),
        detail: "No renovation profit at current price",
        profit: calc.renovationProfit,
        roi: null,
        calc,
      };
    }
    return null;
  }

  function sortListingsByProfit(listings, direction = "desc", calcInvestmentFn = calcInvestment) {
    const multiplier = direction === "asc" ? 1 : -1;
    return [...(listings || [])].sort((a, b) => {
      const aProfit = calcInvestmentFn(a).profit || 0;
      const bProfit = calcInvestmentFn(b).profit || 0;
      return (aProfit - bProfit) * multiplier;
    });
  }

  function formatSEKShort(n) {
    if (!n) return "—";
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(n);
    if (abs >= 1000000) return sign + (abs / 1000000).toFixed(1) + "M kr";
    return sign + Math.round(abs / 1000) + "K kr";
  }

  return {
    RENOVATED_SQM,
    DEFAULT_RENOVATED_SQM,
    MIN_RENOVATION_COST_FOR_UPSIDE,
    getAreaSqmPrice,
    isRenovationUpsideCandidate,
    calcInvestment,
    formatProfitBadgeModel,
    sortListingsByProfit,
  };
});
