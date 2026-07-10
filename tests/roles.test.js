const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveRole, friendEmails, syncUserRole } = require("../api/roles");

function withFriendEmails(value, fn) {
  const prev = process.env.FRIEND_EMAILS;
  process.env.FRIEND_EMAILS = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.FRIEND_EMAILS;
    else process.env.FRIEND_EMAILS = prev;
  }
}

test("friendEmails parses, trims and lowercases the allowlist", () => {
  withFriendEmails(" Dad@Example.com , friend2@x.io ,, ", () => {
    assert.deepEqual(friendEmails(), ["dad@example.com", "friend2@x.io"]);
  });
});

test("resolveRole: allowlisted email becomes friend (case-insensitive)", () => {
  withFriendEmails("dad@example.com", () => {
    assert.equal(resolveRole("DAD@example.com", null), "friend");
    assert.equal(resolveRole("DAD@example.com", "investor"), "friend");
  });
});

test("resolveRole: admin is never downgraded, even if allowlisted", () => {
  withFriendEmails("claire@example.com", () => {
    assert.equal(resolveRole("claire@example.com", "admin"), "admin");
  });
});

test("resolveRole: non-allowlisted defaults to investor for new accounts, keeps existing", () => {
  withFriendEmails("dad@example.com", () => {
    assert.equal(resolveRole("random@x.io", null), "investor");
    assert.equal(resolveRole("random@x.io", "investor"), "investor");
  });
});

test("resolveRole: removing an email from the allowlist demotes friend back to investor", () => {
  withFriendEmails("", () => {
    assert.equal(resolveRole("dad@example.com", "friend"), "investor");
  });
});

test("syncUserRole saves only when the role actually changes", async () => {
  // Manage the env directly: the sync withFriendEmails wrapper would restore it
  // before this async body runs, so friendEmails() would read the wrong value.
  const prev = process.env.FRIEND_EMAILS;
  process.env.FRIEND_EMAILS = "dad@example.com";
  try {
    let saves = 0;
    const user = { email: "dad@example.com", role: "investor", save: async () => { saves++; } };
    await syncUserRole(user);
    assert.equal(user.role, "friend");
    assert.equal(saves, 1);
    // Second sync is a no-op — no redundant write.
    await syncUserRole(user);
    assert.equal(saves, 1);
  } finally {
    if (prev === undefined) delete process.env.FRIEND_EMAILS;
    else process.env.FRIEND_EMAILS = prev;
  }
});

test("syncUserRole is promote-only: a manually-set friend is NOT demoted when off the allowlist", async () => {
  // The admin promotes people in-app now (not via env). An email that's not in
  // FRIEND_EMAILS must keep its manually-granted friend role across logins.
  const prev = process.env.FRIEND_EMAILS;
  process.env.FRIEND_EMAILS = ""; // empty allowlist — the Render-env path retired
  try {
    let saves = 0;
    const friend = { email: "hand-picked@example.com", role: "friend", save: async () => { saves++; } };
    await syncUserRole(friend);
    assert.equal(friend.role, "friend"); // stays friend
    assert.equal(saves, 0); // no write
    const admin = { email: "claire@example.com", role: "admin", save: async () => { saves++; } };
    await syncUserRole(admin);
    assert.equal(admin.role, "admin"); // admin untouched
    assert.equal(saves, 0);
  } finally {
    if (prev === undefined) delete process.env.FRIEND_EMAILS;
    else process.env.FRIEND_EMAILS = prev;
  }
});
