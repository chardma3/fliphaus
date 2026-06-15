const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyActiveAnalysisUpdate,
  applySoldAnalysisUpdate,
  buildAnalysisQuery,
  conditionLabelFromScore,
} = require("../api/analyze-refresh");

test("active image analysis query self-heals incomplete-coverage listings, bounded by attempts and cooldown", () => {
  const cutoff = new Date("2026-06-01T00:00:00.000Z");
  assert.deepEqual(
    buildAnalysisQuery({ onlyMissing: true, status: "active", requireAnalyzedAt: true, hydrationRetry: { maxAttempts: 4, cutoff } }),
    {
      "images.0": { $exists: true },
      streetAddress: { $not: /^[^0-9]+$/ },
      status: "active",
      $or: [
        { renovationScore: null },
        { renovationScore: { $exists: false } },
        { analyzedAt: null },
        { analyzedAt: { $exists: false } },
        // Missing a wet room (hydration failed), fewer than maxAttempts tries so
        // far, and not attempted since the cooldown cutoff -> retry it now.
        {
          $and: [
            { $or: [{ kitchenPictured: false }, { bathroomPictured: false }] },
            { $or: [{ galleryHydrationAttempts: { $lt: 4 } }, { galleryHydrationAttempts: { $exists: false } }] },
            { $or: [{ galleryHydrationAttemptedAt: null }, { galleryHydrationAttemptedAt: { $exists: false } }, { galleryHydrationAttemptedAt: { $lte: cutoff } }] },
          ],
        },
      ],
    }
  );
});

test("hydrationRetry is opt-in: omitting it leaves the self-heal clause off", () => {
  const query = buildAnalysisQuery({ onlyMissing: true, status: "active", requireAnalyzedAt: true });
  assert.deepEqual(query.$or, [
    { renovationScore: null },
    { renovationScore: { $exists: false } },
    { analyzedAt: null },
    { analyzedAt: { $exists: false } },
  ]);
});

test("reanalyzeBefore adds a one-shot stale-cutoff clause to the re-pick", () => {
  const before = new Date("2026-06-13T00:00:00.000Z");
  const query = buildAnalysisQuery({ onlyMissing: true, status: "active", requireAnalyzedAt: true, reanalyzeBefore: before });
  assert.deepEqual(query.$or.at(-1), { analyzedAt: { $lt: before } });
  // Omitting it leaves the clause off entirely.
  const without = buildAnalysisQuery({ onlyMissing: true, status: "active", requireAnalyzedAt: true });
  assert.ok(!without.$or.some((c) => c.analyzedAt && c.analyzedAt.$lt));
});

test("sold image analysis query does not require analyzedAt because sold listings do not store it", () => {
  assert.deepEqual(buildAnalysisQuery({ onlyMissing: true }), {
    "images.0": { $exists: true },
    streetAddress: { $not: /^[^0-9]+$/ },
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
  // A full (non-gated) analysis records triageGated: false, never null/undefined.
  assert.equal(update.triageGated, false);
});

test("coverage flags come from the persisted display set, not the wider gallery", () => {
  // The model saw both wet rooms in the full gallery (roomCoverage) but the
  // curated set only kept the kitchen. The flags must follow the kept photos so
  // self-heal re-hydrates for the missing bathroom.
  const update = applyActiveAnalysisUpdate({
    renovationScore: 7,
    roomCoverage: { kitchenVisible: true, bathroomVisible: true },
    displayCoverage: { kitchenPictured: true, bathroomPictured: false },
  });
  assert.equal(update.kitchenPictured, true);
  assert.equal(update.bathroomPictured, false);
  assert.equal(update.imageCoverageComplete, false);
});

test("coverage falls back to the model's roomCoverage when triage gave no classification", () => {
  // displayCoverage is null (triage failed) -> use what the model reported.
  const update = applyActiveAnalysisUpdate({
    renovationScore: 7,
    roomCoverage: { kitchenVisible: true, bathroomVisible: true },
    displayCoverage: null,
  });
  assert.equal(update.kitchenPictured, true);
  assert.equal(update.bathroomPictured, true);
  assert.equal(update.imageCoverageComplete, true);
});

test("analysis update records triageGated when the triage gate fired", () => {
  const update = applyActiveAnalysisUpdate({
    renovationScore: 2,
    investmentPotential: "low",
    summary: "Triage gate: kitchen and bathroom both appear already renovated.",
    triageGated: true,
  });

  assert.equal(update.triageGated, true);
  assert.equal(update.renovationScore, 2);
  assert.equal(update.investmentPotential, "low");
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
