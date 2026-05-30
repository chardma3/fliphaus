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

// Credential-safe summary of the proxy configuration, for logging at scrape
// startup. A silent no-proxy fallback (server or creds unset) otherwise looks
// identical to a working run until Hemnet serves a Cloudflare challenge — this
// makes the cause obvious in the logs instead. Never prints the password; only
// echoes the (non-secret) server host and whether the username carries
// Sweden/Stockholm geo-targeting.
function describeProxyStatus(env = process.env) {
  const server = env.HEMNET_PROXY_SERVER;
  const hasUser = Boolean(env.HEMNET_PROXY_USERNAME);
  const hasPass = Boolean(env.HEMNET_PROXY_PASSWORD);

  if (!server) {
    return {
      active: false,
      level: "warn",
      message:
        "🌐 Proxy NOT configured (HEMNET_PROXY_SERVER unset) — scraping from the host's own IP; Hemnet may serve Cloudflare bot protection.",
    };
  }
  if (!hasUser || !hasPass) {
    return {
      active: false,
      level: "warn",
      message: `🌐 Proxy server set (${server}) but auth credentials are MISSING (need HEMNET_PROXY_USERNAME and HEMNET_PROXY_PASSWORD) — proxy auth will fail with 407.`,
    };
  }

  // Match Smartproxy/Decodo geo-targeting tokens (e.g. `country-SE`,
  // `_area-SE_city-STOCKHOLM`) — NOT a bare "se", which would false-positive on
  // the literal "user" prefix every Smartproxy username carries.
  const geoTargeted = /stockholm|(?:country|area|region|city)-(?:se|stockholm)/i.test(
    env.HEMNET_PROXY_USERNAME
  );
  return {
    active: true,
    level: "info",
    message: `🌐 Proxy active via ${server} (auth=yes, geo-target=${
      geoTargeted
        ? "SE/Stockholm detected"
        : "NOT detected in username — exits may be non-Swedish and get challenged"
    }).`,
  };
}

function logProxyStatus(env = process.env, logger = console) {
  const status = describeProxyStatus(env);
  const sink = status.level === "warn" ? logger.warn || logger.log : logger.log;
  sink.call(logger, status.message);
  return status;
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
  describeProxyStatus,
  logProxyStatus,
};
