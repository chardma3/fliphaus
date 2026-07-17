// Server-rendered per-listing SHARE page. Pasting an SPA URL into Messenger gives
// a bare link — the link-preview crawler can't run our client JS, so it sees no
// title/photo. This renders Open Graph + Twitter tags for THE listing so it
// unfurls with the address, price and hero photo, then offers Google sign-in
// (returnTo brings the visitor back here) to reveal the full details.

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function notFoundPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>FlipHaus · Listing not found</title>
<meta name="robots" content="noindex"/></head>
<body style="background:#141414;color:#eee;font-family:system-ui,sans-serif;text-align:center;padding:60px 20px;">
<h1 style="font-size:1.4rem;">Listing not found</h1>
<p style="color:#999;">It may have sold or been withdrawn.</p>
<p><a style="color:#69db7c;" href="/friends">See current FlipHaus picks &rarr;</a></p>
</body></html>`;
}

function sharePageHtml(listing, base, id) {
  if (!listing) return notFoundPage();

  const url = `${base}/l/${encodeURIComponent(id)}`;
  const photo = (listing.images && listing.images[0]) || listing.thumbnail || "";
  const addr = listing.streetAddress || "Stockholm apartment";
  const loc = listing.locationDescription || "";
  const price = listing.askingPrice || "";
  const facts = [listing.rooms, listing.size, price].filter(Boolean).join(" · ");
  const title = `${addr}${loc ? ` — ${loc.split(",")[0]}` : ""}`;
  const desc = facts || "A Stockholm renovation flip on FlipHaus.";
  const og = [
    `<meta property="og:type" content="website"/>`,
    `<meta property="og:site_name" content="FlipHaus"/>`,
    `<meta property="og:title" content="${escapeHtml(title)}"/>`,
    `<meta property="og:description" content="${escapeHtml(desc)}"/>`,
    `<meta property="og:url" content="${escapeHtml(url)}"/>`,
    photo ? `<meta property="og:image" content="${escapeHtml(photo)}"/>` : "",
    `<meta name="twitter:card" content="${photo ? "summary_large_image" : "summary"}"/>`,
    `<meta name="twitter:title" content="${escapeHtml(title)}"/>`,
    `<meta name="twitter:description" content="${escapeHtml(desc)}"/>`,
    photo ? `<meta name="twitter:image" content="${escapeHtml(photo)}"/>` : "",
  ].filter(Boolean).join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)} · FlipHaus</title>
<meta name="robots" content="noindex"/>
${og}
<style>
  body { background:#141414; color:#eee; font-family:system-ui,-apple-system,sans-serif; margin:0; }
  .wrap { max-width:560px; margin:0 auto; padding:20px 16px 48px; }
  .brand { color:#fff; font-size:1.3rem; font-weight:700; text-decoration:none; display:inline-block; margin-bottom:16px; }
  .brand span { color:#69db7c; }
  .hero { width:100%; aspect-ratio:4/3; object-fit:cover; border-radius:14px; background:#222; display:block; }
  h1 { font-size:1.25rem; margin:18px 0 4px; }
  .loc { color:#999; font-size:0.9rem; }
  .facts { display:flex; flex-wrap:wrap; gap:8px 14px; margin:14px 0; color:#ddd; font-size:0.95rem; }
  .facts .price { color:#69db7c; font-weight:700; }
  .summary { background:#1b1b1b; border:1px solid #2a2a2a; border-radius:12px; padding:14px 16px; margin:14px 0; color:#cfcfcf; font-size:0.92rem; line-height:1.5; }
  .btn { display:block; text-align:center; padding:13px 16px; border-radius:11px; font-size:1rem; font-weight:600; text-decoration:none; border:none; cursor:pointer; margin:10px 0; }
  .btn.google { background:#fff; color:#1a1a1a; }
  .btn.ghost { background:#1f2733; color:#7eb8f7; }
  .gate { color:#aaa; font-size:0.9rem; text-align:center; margin:8px 0 2px; }
  .muted { color:#777; font-size:0.8rem; text-align:center; margin-top:24px; }
</style></head>
<body>
  <div class="wrap">
    <a class="brand" href="/friends">Flip<span>Haus</span></a>
    ${photo ? `<img class="hero" src="${escapeHtml(photo)}" alt="${escapeHtml(addr)}"/>` : ""}
    <h1>${escapeHtml(addr)}</h1>
    ${loc ? `<div class="loc">${escapeHtml(loc)}</div>` : ""}
    <div class="facts">
      ${listing.rooms ? `<span>${escapeHtml(listing.rooms)}</span>` : ""}
      ${listing.size ? `<span>${escapeHtml(listing.size)}</span>` : ""}
      ${price ? `<span class="price">${escapeHtml(price)}</span>` : ""}
    </div>
    <div id="detail"></div>
  </div>
  <script>
    var LISTING_ID = ${JSON.stringify(String(id))};
    (async function () {
      var detail = document.getElementById("detail");
      var me = null;
      try { me = (await (await fetch("/api/me")).json()).user; } catch (e) {}
      if (!me) {
        detail.innerHTML =
          '<div class="gate">Sign in to see the full listing — renovation notes, resale estimate and more.</div>' +
          '<a class="btn google" href="/auth/google?returnTo=/l/' + encodeURIComponent(LISTING_ID) + '">Sign in with Google</a>' +
          '<div class="gate" style="margin-top:14px;">No Google account? <a style="color:#7eb8f7;" href="/login">Sign in / create an account</a></div>';
        return;
      }
      try {
        var data = await (await fetch("/api/invest/listing/" + encodeURIComponent(LISTING_ID))).json();
        var l = data.listing || {};
        var parts = [];
        if (l.renovationSummary) parts.push('<div class="summary">' + l.renovationSummary + '</div>');
        if (l.link) parts.push('<a class="btn ghost" href="' + l.link + '" target="_blank" rel="noopener">View on Hemnet &rarr;</a>');
        parts.push('<a class="btn ghost" href="/friends">See all FlipHaus picks &rarr;</a>');
        detail.innerHTML = parts.join("");
      } catch (e) {
        detail.innerHTML = '<a class="btn ghost" href="/friends">See all FlipHaus picks &rarr;</a>';
      }
    })();
  </script>
  <div class="muted">FlipHaus · Stockholm renovation flips</div>
</body></html>`;
}

module.exports = { escapeHtml, sharePageHtml };
