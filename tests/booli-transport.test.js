const test = require("node:test");
const assert = require("node:assert/strict");

const {
  looksChallenged,
  openBooliSession,
  fetchNextDataWith,
  resolveAreaId,
  gotoWithRetry,
  installResourceBlocking,
} = require("../api/booli-transport");

// Minimal stand-in for a Puppeteer page: `evaluate` runs the passed function with
// the supplied args against a fake document, so header/URL construction and the
// Apollo-cache walk are exercised without a browser.
function fakePage({ title = "Booli", bodyText = "", nextData = null, fetchImpl = null } = {}) {
  const calls = { goto: [], fetch: [] };
  return {
    calls,
    async goto(url) {
      calls.goto.push(url);
    },
    async title() {
      return title;
    },
    async evaluate(fn, ...args) {
      global.document = {
        body: { innerText: bodyText },
        getElementById: (id) =>
          id === "__NEXT_DATA__" && nextData !== null ? { textContent: JSON.stringify(nextData) } : null,
      };
      global.fetch = async (url, opts) => {
        calls.fetch.push({ url, headers: opts?.headers || {} });
        return fetchImpl ? fetchImpl(url, opts) : { status: 200, text: async () => "{}" };
      };
      try {
        return await fn(...args);
      } finally {
        delete global.document;
        delete global.fetch;
      }
    },
  };
}

test("looksChallenged recognises Cloudflare interstitials", () => {
  assert.equal(looksChallenged("Just a moment..."), true);
  assert.equal(looksChallenged("Attention Required! | Cloudflare"), true);
  assert.equal(looksChallenged("Booli - Sveriges största utbud av bostäder till salu"), false);
  assert.equal(looksChallenged(""), false);
});

test("openBooliSession throws a named error on a challenge page", async () => {
  const page = fakePage({ title: "Just a moment...", bodyText: "Enable JavaScript" });
  await assert.rejects(() => openBooliSession(page), (err) => err.code === "BOOLI_CHALLENGED");
});

test("openBooliSession succeeds on the real homepage", async () => {
  const page = fakePage({ title: "Booli - Sveriges största utbud" });
  const session = await openBooliSession(page);
  assert.match(session.title, /Booli/);
});

test("fetchNextDataWith navigates and returns parsed __NEXT_DATA__", async () => {
  const page = fakePage({ nextData: { props: { pageProps: { ok: true } } } });
  const fetchNextData = fetchNextDataWith(page);
  const data = await fetchNextData("https://www.booli.se/sok/slutpriser?areaIds=874649");
  assert.deepEqual(data, { props: { pageProps: { ok: true } } });
  assert.deepEqual(page.calls.goto, ["https://www.booli.se/sok/slutpriser?areaIds=874649"]);
});

test("fetchNextDataWith returns null when the page has no __NEXT_DATA__", async () => {
  const fetchNextData = fetchNextDataWith(fakePage({ nextData: null }));
  assert.equal(await fetchNextData("https://www.booli.se/x"), null);
});

test("resolveAreaId sends the headers Apollo's CSRF guard demands", async () => {
  // A bare GET is rejected 400 "blocked as a potential Cross-Site Request Forgery"
  // unless content-type or x-apollo-operation-name is present — regression guard.
  const page = fakePage({
    fetchImpl: async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          data: {
            areaSuggestionSearch: {
              suggestions: [{ type: "locality", id: "874649", displayName: "Årsta", parent: "Stockholm" }],
            },
          },
        }),
    }),
  });
  const picked = await resolveAreaId(page, "Årsta");
  assert.equal(picked.areaId, "874649");
  const sent = page.calls.fetch[0];
  assert.equal(sent.headers["content-type"], "application/json");
  assert.equal(sent.headers["x-apollo-operation-name"], "areaSuggestionSearch");
  assert.match(sent.url, /operationName=areaSuggestionSearch/);
});

test("resolveAreaId returns null on a non-JSON (challenged) response", async () => {
  const page = fakePage({
    fetchImpl: async () => ({ status: 403, text: async () => "<html>Just a moment...</html>" }),
  });
  assert.equal(await resolveAreaId(page, "Årsta"), null);
});

// ── navigation resilience (the 45s-timeout failure over the proxy) ────────────

function flakyPage({ failures = 0, nextData = { ok: true }, titles = [] } = {}) {
  let gotos = 0;
  let titleIdx = 0;
  return {
    get gotos() { return gotos; },
    async goto() {
      gotos += 1;
      if (gotos <= failures) throw new Error("Navigation timeout of 90000 ms exceeded");
    },
    async title() {
      const t = titles.length ? titles[Math.min(titleIdx++, titles.length - 1)] : "Booli";
      return t;
    },
    async evaluate(fn) {
      global.document = {
        body: { innerText: "" },
        getElementById: () => (nextData ? { textContent: JSON.stringify(nextData) } : null),
      };
      try { return await fn(); } finally { delete global.document; }
    },
  };
}

test("gotoWithRetry survives a slow proxy exit and retries", async () => {
  const page = flakyPage({ failures: 2 });
  await gotoWithRetry(page, "https://www.booli.se", { timeout: 10, attempts: 3 });
  assert.equal(page.gotos, 3);
});

test("gotoWithRetry gives up with a named error, quoting the cause", async () => {
  const page = flakyPage({ failures: 5 });
  await assert.rejects(
    () => gotoWithRetry(page, "https://www.booli.se", { timeout: 10, attempts: 2 }),
    (err) => err.code === "BOOLI_NAV_FAILED" && /Navigation timeout/.test(err.message)
  );
  assert.equal(page.gotos, 2);
});

test("openBooliSession waits for an interstitial to clear instead of crying block", async () => {
  // Stopping at domcontentloaded means we can arrive mid-challenge; the page
  // resolves itself a moment later. Declaring a block here would be wrong.
  const page = flakyPage({ titles: ["Just a moment...", "Just a moment...", "Booli - Sveriges största utbud"] });
  const session = await openBooliSession(page, { timeout: 10, settleMs: 5000 });
  assert.match(session.title, /Booli/);
});

test("openBooliSession still reports a challenge that never clears", async () => {
  const page = flakyPage({ titles: ["Just a moment..."] });
  await assert.rejects(
    () => openBooliSession(page, { timeout: 10, settleMs: 1200 }),
    (err) => err.code === "BOOLI_CHALLENGED"
  );
});

test("fetchNextDataWith retries a timed-out page fetch", async () => {
  const page = flakyPage({ failures: 1, nextData: { props: { pageProps: {} } } });
  const fetchNextData = fetchNextDataWith(page, { timeout: 10, attempts: 3 });
  const data = await fetchNextData("https://www.booli.se/sok/slutpriser?areaIds=874649");
  assert.deepEqual(data, { props: { pageProps: {} } });
  assert.equal(page.gotos, 2);
});

test("installResourceBlocking aborts images but lets scripts through", async () => {
  // Cloudflare's challenge needs JS, so blocking scripts would break the session;
  // images/fonts/CSS are pure cost on a per-GB proxy.
  const handlers = [];
  let interception = null;
  const page = {
    async setRequestInterception(v) { interception = v; },
    on(event, fn) { if (event === "request") handlers.push(fn); },
  };
  assert.equal(await installResourceBlocking(page), true);
  assert.equal(interception, true);

  const seen = {};
  const req = (type) => ({
    resourceType: () => type,
    abort: async () => { seen[type] = "abort"; },
    continue: async () => { seen[type] = "continue"; },
  });
  for (const type of ["image", "media", "font", "stylesheet", "script", "xhr", "document"]) {
    handlers[0](req(type));
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.image, "abort");
  assert.equal(seen.font, "abort");
  assert.equal(seen.stylesheet, "abort");
  assert.equal(seen.script, "continue");
  assert.equal(seen.xhr, "continue");
  assert.equal(seen.document, "continue");
});

test("installResourceBlocking is a no-op on a page that can't intercept", async () => {
  assert.equal(await installResourceBlocking({}), false);
});
