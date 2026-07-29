const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyFailure,
  summarizeAreaFailures,
  describeScrapeFailure,
  withAreaFailures,
} = require("../api/scrape-failures");

test("classifyFailure names the proxy for tunnel/auth errors", () => {
  assert.equal(classifyFailure("net::ERR_TUNNEL_CONNECTION_FAILED at https://www.hemnet.se/bostader").cause, "proxy");
  assert.equal(classifyFailure("Request failed with status code 407").cause, "proxy");
  assert.match(classifyFailure("net::ERR_TUNNEL_CONNECTION_FAILED").hint, /proxy-check/);
});

test("classifyFailure separates a block from a transport failure", () => {
  // Both stop the scrape, but the fixes are opposite: rotate/ease pacing vs fix
  // the proxy account. Conflating them sends you to the wrong place.
  const blocked = classifyFailure(
    "Hemnet bot protection detected for Farsta active listings (https://www.hemnet.se/bostader?location_ids[]=925962)"
  );
  assert.equal(blocked.cause, "blocked");
  assert.match(blocked.hint, /blocked or rate-limited/);
});

test("classifyFailure flags a changed page shape as a parser problem", () => {
  const parser = classifyFailure("Hemnet page missing __NEXT_DATA__ for Kista active listings; scraper cannot safely parse");
  assert.equal(parser.cause, "parser");
  assert.match(parser.hint, /changed its page shape/);
});

test("classifyFailure recognises timeouts, network drops and browser faults", () => {
  assert.equal(classifyFailure("Navigation timeout of 30000 ms exceeded").cause, "timeout");
  assert.equal(classifyFailure("net::ERR_CONNECTION_RESET").cause, "network");
  assert.equal(classifyFailure("Could not find Chrome (ver. 131.0.6778.204)").cause, "browser");
});

test("classifyFailure degrades honestly on an unknown message", () => {
  const unknown = classifyFailure("something entirely new went wrong");
  assert.equal(unknown.cause, "unknown");
  assert.match(unknown.hint, /run log/);
});

test("summarizeAreaFailures collapses one cause across many areas", () => {
  // The real 2026-07-28 shape: every area failing for the same reason. Thirteen
  // identical lines buries the one fact that matters.
  const areas = ["Farsta", "Kista", "Bagarmossen", "Skarpnäck", "Johanneshov"];
  const groups = summarizeAreaFailures(
    areas.map((area) => ({ area, attempts: 6, message: "net::ERR_TUNNEL_CONNECTION_FAILED" }))
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 5);
  assert.equal(groups[0].cause, "proxy");
  assert.equal(groups[0].attempts, 6);
  assert.deepEqual(groups[0].areas, areas);
});

test("summarizeAreaFailures keeps distinct causes apart, dominant first", () => {
  const groups = summarizeAreaFailures([
    { area: "Farsta", message: "Navigation timeout of 30000 ms exceeded" },
    { area: "Kista", message: "net::ERR_TUNNEL_CONNECTION_FAILED" },
    { area: "Solna", message: "net::ERR_TUNNEL_CONNECTION_FAILED" },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].cause, "proxy"); // 2 areas beats 1
  assert.equal(groups[1].cause, "timeout");
});

test("describeScrapeFailure says 'All N areas' only when the whole run failed", () => {
  const failures = [
    { area: "Farsta", message: "net::ERR_TUNNEL_CONNECTION_FAILED" },
    { area: "Kista", message: "net::ERR_TUNNEL_CONNECTION_FAILED" },
  ];
  const total = describeScrapeFailure(failures, { totalAreas: 2 });
  assert.match(total.text, /^All 2 areas failed —/);
  assert.equal(total.cause, "proxy");

  const partial = describeScrapeFailure(failures, { totalAreas: 13 });
  assert.match(partial.text, /^2 areas failed \(Farsta, Kista\)/);
});

test("describeScrapeFailure returns null when nothing failed", () => {
  assert.equal(describeScrapeFailure([]), null);
  assert.equal(describeScrapeFailure(undefined), null);
});

test("withAreaFailures attaches causes to a thrown guard error", () => {
  // The guard fires after the area loop, so this is what stops the reasons being
  // lost exactly when the run fails hardest.
  const err = new Error("Refusing to persist zero active listings because …");
  const failures = [{ area: "Farsta", message: "net::ERR_TUNNEL_CONNECTION_FAILED" }];
  assert.equal(withAreaFailures(err, failures).areaFailures, failures);
  assert.equal(withAreaFailures(new Error("x"), []).areaFailures, undefined);
});
