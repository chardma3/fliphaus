const DEFAULT_CHROMIUM_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--single-process",
];

// Chrome can be slow to spawn on a cold / memory-constrained Render instance.
// Puppeteer's default launch timeout is 30s, which surfaced in production as
// `500: "Timed out after 30000 ms while waiting for the WS endpoint URL to
// appear in stdout"`. Give the browser longer to come up, and widen the
// protocol timeout so individual CDP commands don't fail under load. Both are
// env-overridable for tuning without a redeploy.
const DEFAULT_LAUNCH_TIMEOUT_MS = 120000;
const DEFAULT_PROTOCOL_TIMEOUT_MS = 180000;

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildPuppeteerLaunchOptions(env = process.env) {
  const args = [...DEFAULT_CHROMIUM_ARGS];
  if (env.HEMNET_PROXY_SERVER) {
    args.push(`--proxy-server=${env.HEMNET_PROXY_SERVER}`);
  }

  return {
    headless: true,
    executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args,
    timeout: toPositiveInt(env.PUPPETEER_LAUNCH_TIMEOUT_MS, DEFAULT_LAUNCH_TIMEOUT_MS),
    protocolTimeout: toPositiveInt(env.PUPPETEER_PROTOCOL_TIMEOUT_MS, DEFAULT_PROTOCOL_TIMEOUT_MS),
  };
}

async function authenticateProxyPage(page, env = process.env) {
  if (!env.HEMNET_PROXY_USERNAME || !env.HEMNET_PROXY_PASSWORD) return false;
  await page.authenticate({
    username: env.HEMNET_PROXY_USERNAME,
    password: env.HEMNET_PROXY_PASSWORD,
  });
  return true;
}

module.exports = {
  buildPuppeteerLaunchOptions,
  authenticateProxyPage,
};
