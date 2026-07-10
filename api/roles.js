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

// Sync a persisted user's role on login. PROMOTE-ONLY: an env-allowlisted email
// is lifted from investor to friend as a convenience, but this never demotes.
// Friend/investor is managed by the admin in-app (POST /api/admin/users/:id/role
// via the "Friends access" page), and a manual promotion must survive the user's
// next login — so we no longer re-derive the role from the env allowlist (which
// would clobber it back to investor). Admin is always left untouched. Saves only
// when the role actually changes. Returns the (possibly updated) user.
async function syncUserRole(user) {
  if (!user) return user;
  if (user.role !== "investor") return user; // admin + friend are left as-is
  const allowlisted = friendEmails().includes(String(user.email || "").toLowerCase());
  if (allowlisted) {
    user.role = "friend";
    await user.save();
  }
  return user;
}

module.exports = { friendEmails, resolveRole, syncUserRole };
