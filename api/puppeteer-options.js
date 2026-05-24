const DEFAULT_CHROMIUM_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--single-process",
];

function buildPuppeteerLaunchOptions(env = process.env) {
  const args = [...DEFAULT_CHROMIUM_ARGS];
  if (env.HEMNET_PROXY_SERVER) {
    args.push(`--proxy-server=${env.HEMNET_PROXY_SERVER}`);
  }

  return {
    headless: true,
    executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args,
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
