const test = require("node:test");
const assert = require("node:assert/strict");

const { looksChallenged, openBooliSession, fetchNextDataWith, resolveAreaId } = require("../api/booli-transport");

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
