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
    Kärrtorp: 58000,
    Högdalen: 48000,
    Enskede: 52600,
    Bagarmossen: 46000,
    Skarpnäck: 50000,
    Bromma: 50000,
    Kista: 38000,
    Sollentuna: 42000,
    Järvastaden: 56000,
  };
  const DEFAULT_RENOVATED_SQM = 45000;
  // Minimum cash deposit as a share of price. This is the Swedish mortgage cap
  // (kontantinsats / bolånetak), a national regulation — not per-listing data —
  // lowered from 15% to 10%.
  const DEPOSIT_PCT = 0.1;
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

  // Resale liquidity for an area, derived from trailing-12-month sold
  // bostadsrätt volume (the /api/sold/stats `totalSold`, which is scraped with
  // sold_age=12m). Liquidity is an exit-risk axis the profit calc doesn't
  // capture: a flip only works if you can SELL within months of finishing. A
  // thin market (e.g. Rissne — ~20 BR sales a year, because ~70% of its stock is
  // rental) means a finished unit can sit, and every extra month of carrying
  // cost erodes the profit; a deep one (Årsta — several hundred a year) lets you
  // exit any week. Thresholds are per 12 months. avgDaysOnMarket refines the
  // detail line but doesn't change the tier.
  const LIQUIDITY_TIERS = [
    { min: 250, level: "high", label: "High liquidity", cssClass: "positive" },
    { min: 100, level: "moderate", label: "Moderate liquidity", cssClass: "neutral" },
    { min: 35, level: "thin", label: "Thin market", cssClass: "cautious" },
    { min: 0, level: "very-thin", label: "Very thin — exit risk", cssClass: "negative" },
  ];

  function liquidityRating(soldCount12m, avgDaysOnMarket) {
    const count = parseNumber(soldCount12m);
    if (!count) {
      return {
        level: "unknown",
        label: "No sold data",
        cssClass: "neutral",
        soldCount12m: 0,
        avgDaysOnMarket: null,
        perMonth: 0,
        detail: "No sold comparables collected yet for this area.",
      };
    }
    const tier = LIQUIDITY_TIERS.find((t) => count >= t.min) || LIQUIDITY_TIERS[LIQUIDITY_TIERS.length - 1];
    const days = parseNumber(avgDaysOnMarket);
    const perMonth = Math.round((count / 12) * 10) / 10;
    let detail = `~${count} sold in the last 12 months (~${perMonth}/month)`;
    detail += days > 0 ? `, avg ${days} days on market.` : ".";
    if (tier.level === "very-thin" || tier.level === "thin") {
      detail += " A renovated unit may take longer to sell — budget extra carrying cost.";
    }
    return {
      level: tier.level,
      label: tier.label,
      cssClass: tier.cssClass,
      soldCount12m: count,
      avgDaysOnMarket: days || null,
      perMonth,
      detail,
    };
  }

  function hasMoveInReadySignal(listing) {
    const text = [listing?.renovationSummary, listing?.description]
      .filter(Boolean)
      .join(" ");
    return MOVE_IN_READY_SIGNALS.some((pattern) => pattern.test(text));
  }

  // Resolve the renovated kr/m² used to estimate the post-renovation sale price.
  // Prefer the real sold-comparable average when we have medium/high-confidence
  // evidence for it; otherwise fall back to the hardcoded per-area benchmark.
  // Always returns a usable price — we never refuse to produce an estimate, we
  // just flag whether it's "confident" (sold-comp backed) or "preliminary"
  // (benchmark only).
  function resolveRenovatedSqmPrice(listing) {
    const arb = listing?.brfIntelligence?.renovationArbitrage;
    const soldAvg = arb ? parseNumber(arb.avgRenovatedSqm) : 0;
    if (soldAvg > 0 && ["medium", "high"].includes(arb.confidence)) {
      return { sqmPrice: soldAvg, source: "sold-comparables", confident: true };
    }
    return {
      sqmPrice: getAreaSqmPrice(listing?.locationDescription || listing?.area),
      source: "area-benchmark",
      confident: false,
    };
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
    const deposit = Math.round(price * DEPOSIT_PCT);
    const months = 7;
    const carryingCost = feeNum * months;
    const totalInvestment = deposit + renoCost + carryingCost;
    const { sqmPrice, source: estimateSource, confident: confidentEstimate } = resolveRenovatedSqmPrice(listing);
    const estimatedRenovatedSalePrice = sizeNum > 0 ? Math.round(sizeNum * sqmPrice) : 0;
    const grossMarketGap = estimatedRenovatedSalePrice > 0 ? estimatedRenovatedSalePrice - price : 0;
    const renovationProfit = estimatedRenovatedSalePrice > 0 ? grossMarketGap - renoCost - carryingCost : 0;
    const roi = totalInvestment > 0 && renovationProfit > 0 ? Math.round((renovationProfit / totalInvestment) * 100) : 0;
    const candidate = isRenovationUpsideCandidate(listing);
    // "Preliminary" = the estimate rests on the area benchmark, not sold
    // comparables. We always show the number either way; preliminary just means
    // lower confidence (and keeps the listing out of the confidently-unprofitable
    // bucket the Deals tab filters on).
    const preliminary = !confidentEstimate;

    let classification = "insufficient-data";
    if (!price || !sizeNum || !estimatedRenovatedSalePrice) {
      classification = "insufficient-data";
    } else if (!candidate) {
      classification = grossMarketGap > 0 ? "market-gap" : "low-upside";
    } else if (renovationProfit > 0) {
      classification = preliminary ? "preliminary-renovation-upside" : "renovation-upside";
    } else {
      classification = preliminary ? "preliminary-unprofitable" : "unprofitable";
    }

    const displayProfit = ["renovation-upside", "preliminary-renovation-upside", "unprofitable", "preliminary-unprofitable"].includes(classification) ? renovationProfit : 0;

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
      estimateSource,
      preliminary,
      classification,
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
    if (calc.classification === "preliminary-unprofitable") {
      return {
        type: "preliminary-unprofitable",
        cssClass: "cautious",
        label: `~${formatSEKShort(calc.renovationProfit)}`,
        detail: "Preliminary estimate (area benchmark) — needs similar sold properties",
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
    liquidityRating,
    isRenovationUpsideCandidate,
    calcInvestment,
    formatProfitBadgeModel,
    sortListingsByProfit,
  };
});
