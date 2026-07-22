// Human-like pacing for Hemnet scraping. Cloudflare bot detection reacts to
// bursty, perfectly-regular request patterns, so we (a) space requests out and
// (b) add random jitter so the intervals aren't robotic. Every delay is
// env-overridable: on the dedicated scrape worker a slower run costs nothing but
// trips far fewer blocks, so the defaults lean gentle. Turn them all down with
// the env vars if a run needs to be fast (e.g. a manual one-off).

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A base delay plus up to +50% random jitter (so two runs never hit the same
// cadence). Never returns less than `baseMs`.
function jitter(baseMs) {
  const b = Math.max(0, Number(baseMs) || 0);
  return Math.round(b + Math.random() * b * 0.5);
}

function jitteredSleep(baseMs) {
  return sleep(jitter(baseMs));
}

// Growing, jittered backoff for retries after a block: base × attempt (+jitter),
// so a fresh proxy exit and any Cloudflare rate window have progressively more
// time to clear on each successive try.
function retryBackoff(attempt, baseMs) {
  return sleep(jitter((Number(baseMs) || 0) * Math.max(1, Number(attempt) || 1)));
}

const PACING = {
  // Pause between one area and the next (active + sold scrapes).
  areaDelayMs: Number(process.env.SCRAPE_AREA_DELAY_MS) || 4000,
  // Base for retry backoff after a blocked/failed area or sold page.
  retryBaseMs: Number(process.env.SCRAPE_RETRY_BASE_MS) || 3000,
  // Pause between successive sold-listing result pages within one area.
  soldPageDelayMs: Number(process.env.SOLD_PAGE_DELAY_MS) || 1500,
  // Pause between individual sold detail-page fetches.
  soldDetailDelayMs: Number(process.env.SOLD_DETAIL_DELAY_MS) || 1500,
};

module.exports = { sleep, jitter, jitteredSleep, retryBackoff, PACING };
