const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldUnshareOnPreference } = require("../api/friends-share");

test("admin hiding a listing (❌) unshares it from friends", () => {
  assert.equal(shouldUnshareOnPreference("admin", "rejected", null), true);
  assert.equal(shouldUnshareOnPreference("admin", "rejected", "saved"), true);
});

test("admin un-saving (💚 off, saved → none) unshares it from friends", () => {
  assert.equal(shouldUnshareOnPreference("admin", null, "saved"), true);
  assert.equal(shouldUnshareOnPreference("admin", undefined, "saved"), true);
});

test("admin un-rejecting (rejected → none) does NOT unshare", () => {
  assert.equal(shouldUnshareOnPreference("admin", null, "rejected"), false);
});

test("admin saving or clearing a neutral listing does not unshare", () => {
  assert.equal(shouldUnshareOnPreference("admin", "saved", null), false);
  assert.equal(shouldUnshareOnPreference("admin", null, null), false);
});

test("non-admins never unshare, even on the same actions", () => {
  // A friend or investor un-saving on their own dashboard must not touch the
  // global sharedWithFriends flag.
  assert.equal(shouldUnshareOnPreference("friend", "rejected", "saved"), false);
  assert.equal(shouldUnshareOnPreference("friend", null, "saved"), false);
  assert.equal(shouldUnshareOnPreference("investor", "rejected", null), false);
  assert.equal(shouldUnshareOnPreference(undefined, "rejected", "saved"), false);
});
