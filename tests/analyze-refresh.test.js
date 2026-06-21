const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyActiveAnalysisUpdate,
  nextHydrationAttempts,
  applySoldAnalysisUpdate,
  buildAnalysisQuery,
  conditionLabelFromScore,
} = require("../api/analyze-refresh");

test("a successful gallery fetch counts toward the give-up cap", () => {
  assert.equal(nextHydrationAttempts(0, true), 1);
  assert.equal(nextHydrationAttempts(3, true), 4);
  assert.equal(nextHydrationAttempts(undefined, true), 1);
});

test("a bot-blocked fetch resets the counter so self-heal keeps retrying", () => {
  // No gallery this run -> transient block -> reset, don't burn a try. This also
  // clears the budget one-off backfill/recurate runs spent on now-blocked listings.
  assert.equal(nextHydrationAttempts(3, false), 0);
  assert.equal(nextHydrationAttempts(4, false), 0);
});

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

test("a target restricts the query to one listing by id or slug and ignores onlyMissing/self-heal", () => {
  const query = buildAnalysisQuery({ onlyMissing: true, status: "active", requireAnalyzedAt: true, target: "abc123" });
  assert.deepEqual(query.$or, [{ id: "abc123" }, { slug: "abc123" }]);
  assert.equal(query.status, "active");
  // No onlyMissing/self-heal clauses leaked in — the $or is exactly the target match.
  assert.ok(!query.$or.some((c) => "renovationScore" in c || "$and" in c));
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

test("a fully-analysed gallery lets the model's coverage rescue a triage false-negative", () => {
  // Small 5-photo listing: triage mis-tagged the bathroom shots so displayCoverage
  // says no bathroom, but the scoring model analysed every photo and saw it. Since
  // the whole gallery was analysed, trust the stronger model.
  const update = applyActiveAnalysisUpdate({
    renovationScore: 7,
    roomCoverage: { kitchenVisible: true, bathroomVisible: true, analysedImageCount: 5, totalImageCount: 5 },
    displayCoverage: { kitchenPictured: true, bathroomPictured: false },
  });
  assert.equal(update.bathroomPictured, true);
  assert.equal(update.imageCoverageComplete, true);
});

test("a partly-analysed gallery still defers to the display set (no rescue)", () => {
  // Only 12 of 40 photos analysed: the bathroom the model saw may not be in the
  // curated display set, so we must NOT claim it — self-heal should re-hydrate.
  const update = applyActiveAnalysisUpdate({
    renovationScore: 7,
    roomCoverage: { kitchenVisible: true, bathroomVisible: true, analysedImageCount: 12, totalImageCount: 40 },
    displayCoverage: { kitchenPictured: true, bathroomPictured: false },
  });
  assert.equal(update.bathroomPictured, false);
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
