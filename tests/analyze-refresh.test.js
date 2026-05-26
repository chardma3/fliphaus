const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyActiveAnalysisUpdate,
  applySoldAnalysisUpdate,
  buildAnalysisQuery,
  conditionLabelFromScore,
} = require("../api/analyze-refresh");

test("active image analysis query only picks active listings with images needing analysis", () => {
  assert.deepEqual(buildAnalysisQuery({ onlyMissing: true, status: "active", requireAnalyzedAt: true }), {
    "images.0": { $exists: true },
    status: "active",
    $or: [
      { renovationScore: null },
      { renovationScore: { $exists: false } },
      { analyzedAt: null },
      { analyzedAt: { $exists: false } },
    ],
  });
});

test("sold image analysis query does not require analyzedAt because sold listings do not store it", () => {
  assert.deepEqual(buildAnalysisQuery({ onlyMissing: true }), {
    "images.0": { $exists: true },
    $or: [
      { renovationScore: null },
      { renovationScore: { $exists: false } },
    ],
  });
});

test("analysis update maps model response to active listing fields", () => {
  const update = applyActiveAnalysisUpdate({
    renovationScore: 8,
    confidence: 0.72,
    summary: "Needs kitchen and bathroom renovation.",
    rooms: [{ type: "kitchen" }],
    totalEstimatedCostSEK: 350000,
    investmentPotential: "high",
  });

  assert.equal(update.renovationScore, 8);
  assert.equal(update.renovationConfidence, 0.72);
  assert.equal(update.renovationSummary, "Needs kitchen and bathroom renovation.");
  assert.deepEqual(update.renovationRooms, [{ type: "kitchen" }]);
  assert.equal(update.totalEstimatedCostSEK, 350000);
  assert.equal(update.investmentPotential, "high");
  assert.ok(update.analyzedAt instanceof Date);
});

test("sold analysis update sets condition label from score", () => {
  assert.equal(conditionLabelFromScore(2), "renovated");
  assert.equal(conditionLabelFromScore(5), "partly_renovated");
  assert.equal(conditionLabelFromScore(8), "unrenovated");

  const update = applySoldAnalysisUpdate({
    renovationScore: 8,
    confidence: 0.8,
    summary: "Unrenovated comparable property.",
    rooms: [{ type: "bathroom" }],
  });
  assert.equal(update.conditionLabel, "unrenovated");
  assert.equal(update.renovationScore, 8);
});
