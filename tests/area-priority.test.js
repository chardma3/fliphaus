const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AREA_PRIORITY,
  rolloutOrder,
  pendingForPhase,
  getArea,
  getAreaFilters,
  DEFAULT_FILTERS,
} = require("../api/area-priority");

test("every backlog entry is well-formed", () => {
  for (const a of AREA_PRIORITY) {
    assert.ok(a.name, "has a name");
    assert.ok(["A", "B", "C"].includes(a.tier), `${a.name} has a valid tier`);
    assert.ok(["pending", "skip", "active"].includes(a.status), `${a.name} has a valid status`);
    // Nothing in the backlog is live yet — live areas belong in LOCATION_IDS.
    assert.equal(a.locationId, null, `${a.name} has no locationId in the backlog`);
    assert.ok(a.filters && typeof a.filters === "object", `${a.name} has a filters object`);
    for (const key of Object.keys(DEFAULT_FILTERS)) {
      assert.ok(key in a.filters, `${a.name} filters define ${key}`);
    }
  }
});

test("skip-tier (C) areas are never pending and carry no phase", () => {
  for (const a of AREA_PRIORITY.filter((x) => x.tier === "C")) {
    assert.equal(a.status, "skip", `${a.name} is skip`);
    assert.equal(a.phase, null, `${a.name} has no rollout phase`);
  }
});

test("rolloutOrder sorts by tier then phase, sinking skips to the bottom", () => {
  const order = rolloutOrder();
  const ranks = order.map((a) => ({ A: 0, B: 1, C: 2 }[a.tier]));
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i] >= ranks[i - 1], "tiers are non-decreasing");
  }
  // First out of the gate is a Tier-A Phase-1 area.
  assert.equal(order[0].tier, "A");
  assert.equal(order[0].phase, 1);
  // Tier C lands last.
  assert.equal(order[order.length - 1].tier, "C");
});

test("pendingForPhase returns only pending areas for that phase", () => {
  const p1 = pendingForPhase(1);
  assert.ok(p1.length >= 1, "phase 1 has candidates");
  assert.deepEqual(
    p1.map((a) => a.name).sort(),
    ["Essingeöarna", "Gärdet"],
    "phase 1 is Gärdet + Essingeöarna"
  );
  for (const a of p1) {
    assert.equal(a.status, "pending");
    assert.equal(a.phase, 1);
  }
  // Skips never surface, regardless of phase argument.
  assert.equal(pendingForPhase(null).length, 0);
});

test("getArea is case- and whitespace-insensitive; unknown -> null", () => {
  assert.equal(getArea("  gÄRDET ").name, "Gärdet");
  assert.equal(getArea("Nope"), null);
});

test("getAreaFilters falls back to permissive defaults for unknown areas", () => {
  assert.deepEqual(getAreaFilters("Nope"), DEFAULT_FILTERS);
  // The inner-city cores carry the unrenovated-outlier price cap.
  assert.equal(getAreaFilters("Östermalm").maxPriceSEK, 6_000_000);
  assert.equal(getAreaFilters("Södermalm").maxPriceSEK, 6_000_000);
  // Nacka filters out new-build dilution.
  assert.equal(getAreaFilters("Nacka").excludeNewBuild, true);
});
