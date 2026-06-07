// Build/version marker. Render injects RENDER_GIT_COMMIT / RENDER_GIT_BRANCH /
// RENDER_SERVICE_NAME into the environment, so after a deploy we can confirm
// exactly which commit is live (and, via startedAt/uptime, whether the process
// just restarted). All values are non-secret. Returns nulls in local dev where
// the Render vars are absent.
function buildVersionInfo(env = process.env, { startedAt, uptimeSeconds } = {}) {
  const commit = env.RENDER_GIT_COMMIT || null;
  return {
    commit,
    commitShort: commit ? commit.slice(0, 7) : null,
    branch: env.RENDER_GIT_BRANCH || null,
    service: env.RENDER_SERVICE_NAME || null,
    startedAt: startedAt || null,
    uptimeSeconds: typeof uptimeSeconds === "number" ? Math.round(uptimeSeconds) : null,
  };
}

module.exports = { buildVersionInfo };
