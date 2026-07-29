// Turn raw per-area scrape errors into something the dashboard can act on.
//
// WHY THIS EXISTS: when every area fails, the active scrape ends with
// "Refusing to persist zero active listings…" — the guard doing its job, but a
// SYMPTOM. The actual cause (a dead proxy, a blocked exit IP, a changed Hemnet
// page) only ever appeared as `✗ Farsta attempt 1/6: …` lines in the cron log, so
// diagnosing a broken refresh meant digging through Render logs. On 2026-07-25 the
// refresh stopped and the dashboard showed only the guard message for four days.
//
// This module is pure (no I/O) so it can be unit-tested and reused by the scraper,
// the run log and the frontend.

// Error-message signatures → what actually went wrong and what to do about it.
// Ordered: the most specific patterns first, since a proxy failure can also
// mention "net::ERR_".
const CAUSES = [
  {
    cause: "proxy",
    test: /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES|\b407\b|proxy auth/i,
    hint: "The residential proxy isn't connecting — dead, out of monthly quota, or wrong credentials. Check it with scripts/proxy-check.js.",
  },
  {
    cause: "blocked",
    test: /bot protection|just a moment|attention required|cf-browser-verification|access denied|\b403\b/i,
    hint: "Hemnet served bot protection — the proxy exit IP was blocked or rate-limited (a datacenter exit does this immediately).",
  },
  {
    cause: "parser",
    test: /missing __NEXT_DATA__|cannot safely parse/i,
    hint: "The page loaded but wasn't the expected Hemnet markup — either an error page, or Hemnet changed its page shape and the parser needs updating.",
  },
  {
    cause: "timeout",
    test: /timeout|timed out|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/i,
    hint: "Navigation timed out — the proxy is slow or Hemnet is throttling. Ease the pacing env vars, or check proxy latency.",
  },
  {
    cause: "network",
    test: /ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_(RESET|REFUSED|CLOSED)|socket hang up|ECONNRESET/i,
    hint: "The connection never completed — transient network or proxy instability. If it repeats every run, treat it as a proxy fault.",
  },
  {
    cause: "browser",
    test: /Could not find Chrome|WS endpoint|Failed to launch|Target closed|Protocol error/i,
    hint: "Chromium itself failed — usually a missing browser install on the worker or an out-of-memory kill. See the README's 'Could not find Chrome'.",
  },
];

function classifyFailure(message) {
  const text = String(message || "");
  for (const entry of CAUSES) {
    if (entry.test.test(text)) return { cause: entry.cause, hint: entry.hint };
  }
  return {
    cause: "unknown",
    hint: "Unrecognised failure — read the cron job's run log for this stage.",
  };
}

// Collapse per-area failures into one row per distinct cause.
//
// Grouping matters: 13 areas failing for one reason is ONE fact ("the proxy is
// down"), and printing it 13 times buries it. Identical messages are merged, and
// the area names are kept so a single-area problem is still nameable.
function summarizeAreaFailures(failures = []) {
  const groups = new Map();
  for (const failure of failures) {
    if (!failure) continue;
    const message = String(failure.message || "unknown error").trim();
    // Bucket by cause + message so "same reason" collapses even when a message
    // carries a per-area URL.
    const { cause, hint } = classifyFailure(message);
    const key = `${cause}::${message}`;
    if (!groups.has(key)) {
      groups.set(key, { cause, hint, message, areas: [], count: 0 });
    }
    const group = groups.get(key);
    group.count += 1;
    if (failure.area && !group.areas.includes(failure.area)) group.areas.push(failure.area);
    if (failure.attempts != null) {
      group.attempts = Math.max(group.attempts || 0, Number(failure.attempts) || 0);
    }
  }
  // Biggest group first — the dominant cause is the one to act on.
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// A single sentence for the top of the health panel, e.g.
// "All 13 areas failed — the residential proxy isn't connecting…".
// Returns null when there's nothing to report.
function describeScrapeFailure(failures = [], { totalAreas = null } = {}) {
  const groups = summarizeAreaFailures(failures);
  if (!groups.length) return null;
  const dominant = groups[0];
  const failedCount = groups.reduce((sum, g) => sum + g.count, 0);
  const scope =
    totalAreas && failedCount >= totalAreas
      ? `All ${failedCount} areas failed`
      : `${failedCount} area${failedCount === 1 ? "" : "s"} failed${
          dominant.areas.length && failedCount <= 3 ? ` (${dominant.areas.join(", ")})` : ""
        }`;
  return {
    cause: dominant.cause,
    text: `${scope} — ${dominant.hint}`,
    message: dominant.message,
    groups,
  };
}

// Attach per-area failures to an error so they survive being thrown. The zero-
// listing guard fires AFTER the area loop, so without this the reasons are lost
// exactly when they matter most.
function withAreaFailures(error, failures) {
  if (error && failures && failures.length) error.areaFailures = failures;
  return error;
}

module.exports = {
  CAUSES,
  classifyFailure,
  summarizeAreaFailures,
  describeScrapeFailure,
  withAreaFailures,
};
