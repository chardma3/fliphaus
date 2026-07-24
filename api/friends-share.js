// Rule for keeping the friends dashboard in sync with Claire's own triage.
//
// Friends should only ever see listings she currently has SHARED and hasn't
// taken off her list. So when the admin hides a listing (❌ → "rejected") or
// removes it from her saved set (💚 off), it also unshares from the friends
// dashboard. Un-rejecting (rejected → none) is NOT an unsave, so it leaves
// sharing untouched.
//
// Pure and admin-gated: a friend un-saving on their own dashboard sends the
// same request shape but must never unshare globally, so `role` is required.
//
// `status` is the new preference ("rejected" | "saved" | null/undefined for
// none). `prevStatus` is what it was before this change.
function shouldUnshareOnPreference(role, status, prevStatus) {
  if (role !== "admin") return false;
  const isReject = status === "rejected";
  const isUnsave = !status && prevStatus === "saved";
  return isReject || isUnsave;
}

module.exports = { shouldUnshareOnPreference };
