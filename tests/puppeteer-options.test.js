const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPuppeteerLaunchOptions,
  authenticateProxyPage,
} = require("../api/puppeteer-options");

test("Puppeteer launch options include stable Render-safe Chromium flags by default", () => {
  const options = buildPuppeteerLaunchOptions({});

  assert.equal(options.headless, true);
  assert.equal(options.executablePath, undefined);
  assert.ok(options.args.includes("--no-sandbox"));
  assert.ok(options.args.includes("--disable-setuid-sandbox"));
  assert.ok(options.args.includes("--disable-dev-shm-usage"));
});

test("Puppeteer launch options set generous default launch/protocol timeouts", () => {
  const options = buildPuppeteerLaunchOptions({});

  assert.equal(options.timeout, 120000);
  assert.equal(options.protocolTimeout, 180000);
});

test("Puppeteer launch timeouts are env-overridable", () => {
  const options = buildPuppeteerLaunchOptions({
    PUPPETEER_LAUNCH_TIMEOUT_MS: "90000",
    PUPPETEER_PROTOCOL_TIMEOUT_MS: "200000",
  });

  assert.equal(options.timeout, 90000);
  assert.equal(options.protocolTimeout, 200000);
});

test("Puppeteer launch timeouts fall back to defaults on invalid env values", () => {
  const options = buildPuppeteerLaunchOptions({
    PUPPETEER_LAUNCH_TIMEOUT_MS: "not-a-number",
    PUPPETEER_PROTOCOL_TIMEOUT_MS: "-5",
  });

  assert.equal(options.timeout, 120000);
  assert.equal(options.protocolTimeout, 180000);
});

test("Puppeteer launch options add proxy server when configured", () => {
  const options = buildPuppeteerLaunchOptions({
    HEMNET_PROXY_SERVER: "http://gate.smartproxy.example:7000",
    PUPPETEER_EXECUTABLE_PATH: "/usr/bin/chromium",
  });

  assert.equal(options.executablePath, "/usr/bin/chromium");
  assert.ok(options.args.includes("--proxy-server=http://gate.smartproxy.example:7000"));
});

test("proxy authentication is applied only when username and password are configured", async () => {
  const calls = [];
  const page = { authenticate: async (credentials) => calls.push(credentials) };

  const didAuth = await authenticateProxyPage(page, {
    HEMNET_PROXY_USERNAME: "demo-user",
    HEMNET_PROXY_PASSWORD: "demo-pass",
  });

  assert.equal(didAuth, true);
  assert.deepEqual(calls, [{ username: "demo-user", password: "demo-pass" }]);
});

test("proxy authentication is skipped when credentials are incomplete", async () => {
  const calls = [];
  const page = { authenticate: async (credentials) => calls.push(credentials) };

  const didAuth = await authenticateProxyPage(page, { HEMNET_PROXY_USERNAME: "demo-user" });

  assert.equal(didAuth, false);
  assert.deepEqual(calls, []);
});
