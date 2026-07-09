// Friends dashboard access via an email allowlist. Emails listed in the
// FRIEND_EMAILS env var (comma-separated) are granted the read-only "friend"
// role on login/signup. Admin is never downgraded by this — an allowlisted
// address that is also the admin stays admin.

function friendEmails() {
  return (process.env.FRIEND_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// The role an account should have, given its email and current role. Admin is
// sticky (never downgraded by the allowlist). For everyone else the allowlist is
// authoritative: an allowlisted email is a friend, anyone else is an investor —
// so removing someone from FRIEND_EMAILS demotes them back on next login.
function resolveRole(email, currentRole) {
  if (currentRole === "admin") return "admin";
  const normalized = String(email || "").toLowerCase();
  return friendEmails().includes(normalized) ? "friend" : "investor";
}

// Sync a persisted user's role against the current allowlist, saving only if it
// changed (so adding someone to FRIEND_EMAILS promotes them on their next login,
// and removing them demotes back to investor). Returns the (possibly updated) user.
async function syncUserRole(user) {
  if (!user) return user;
  const next = resolveRole(user.email, user.role);
  if (next !== user.role) {
    user.role = next;
    await user.save();
  }
  return user;
}

module.exports = { friendEmails, resolveRole, syncUserRole };
