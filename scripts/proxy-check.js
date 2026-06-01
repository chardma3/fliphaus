#!/usr/bin/env node
/**
 * Read-only proxy exit-IP check. Routes a request to ipinfo.io THROUGH the
 * configured Hemnet proxy and prints the exit IP + org/ASN, so we can tell
 * whether the proxy is genuinely residential or datacenter. Credentials are
 * read from env and passed to curl as argv — nothing sensitive is printed.
 * No writes.
 *
 *   node scripts/proxy-check.js
 */
const { execFileSync } = require("child_process");

const { HEMNET_PROXY_SERVER, HEMNET_PROXY_USERNAME, HEMNET_PROXY_PASSWORD } = process.env;
if (!HEMNET_PROXY_SERVER) {
  console.error("HEMNET_PROXY_SERVER is not set in this environment.");
  process.exit(1);
}

const args = ["-sS", "--max-time", "25", "-x", HEMNET_PROXY_SERVER];
if (HEMNET_PROXY_USERNAME && HEMNET_PROXY_PASSWORD) {
  args.push("-U", `${HEMNET_PROXY_USERNAME}:${HEMNET_PROXY_PASSWORD}`);
}
args.push("https://ipinfo.io/json");

try {
  const out = execFileSync("curl", args, { encoding: "utf8" });
  let info;
  try {
    info = JSON.parse(out);
  } catch {
    console.log(out); // not JSON — print raw so we can see what came back
    process.exit(0);
  }
  console.log("Proxy exit-IP info:");
  for (const k of ["ip", "hostname", "city", "region", "country", "org"]) {
    if (info[k]) console.log(`  ${k.padEnd(9)} ${info[k]}`);
  }
} catch (err) {
  console.error("Proxy check failed:", err.message);
  if (err.stderr) console.error(String(err.stderr));
  process.exit(1);
}
