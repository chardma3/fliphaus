const test = require("node:test");
const assert = require("node:assert/strict");

const { buildVersionInfo } = require("../api/version");

test("version info derives the short commit and echoes Render git env", () => {
  const info = buildVersionInfo(
    {
      RENDER_GIT_COMMIT: "8569d80abcdef0123456789",
      RENDER_GIT_BRANCH: "main",
      RENDER_SERVICE_NAME: "fliphaus",
    },
    { startedAt: "2026-06-07T18:00:00.000Z", uptimeSeconds: 12.7 }
  );

  assert.deepEqual(info, {
    commit: "8569d80abcdef0123456789",
    commitShort: "8569d80",
    branch: "main",
    service: "fliphaus",
    startedAt: "2026-06-07T18:00:00.000Z",
    uptimeSeconds: 13,
  });
});

test("version info is null-safe when Render env is absent (e.g. local dev)", () => {
  assert.deepEqual(buildVersionInfo({}, {}), {
    commit: null,
    commitShort: null,
    branch: null,
    service: null,
    startedAt: null,
    uptimeSeconds: null,
  });
});
