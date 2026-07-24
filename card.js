// Shared listing-card renderer + its formatting helpers, used by the main
// dashboard (index.html / friends) and the favorites page so the two never drift.
// Pairs with card.css (the markup here targets those classes). Depends on
// profitability.js (calcInvestment, formatProfitBadgeModel) and Leaflet (L),
// both of which each page already loads.
//
// Exposes helpers as globals (like profitability.js) AND under window.FlipCard.
// Currency state (SEK base; AUD for the friends view) lives here privately; pages
// drive it through setDisplayCurrency()/loadFx() and read it via getDisplayCurrency()
// so every money formatter stays in one place.
(function (root) {
  // ---- currency state ----
  let displayCurrency = "SEK";
  let fxRate = 1;    // multiply a SEK amount to get the display currency
  let fxInfo = null; // { rate, asOf, source } — powers the "rate as of…" note

  function getDisplayCurrency() { return displayCurrency; }
  function setDisplayCurrency(c) { displayCurrency = c || "SEK"; }
  function getFxInfo() { return fxInfo; }
  async function loadFx() {
    // SEK is the base; only non-SEK needs a rate. /api/fx/sek-aud is a daily
    // Frankfurter rate (cached), shape { rate, asOf, source }.
    if (displayCurrency === "SEK") { fxRate = 1; return; }
    try {
      fxInfo = await (await fetch("/api/fx/sek-aud")).json();
      fxRate = fxInfo && fxInfo.rate ? fxInfo.rate : 1;
    } catch { fxInfo = null; fxRate = 1; }
  }

  // ---- money formatters (currency-aware) ----
  function perSqm(sek) {
    const v = Math.round((sek || 0) * fxRate);
    return displayCurrency === "SEK" ? v.toLocaleString("sv-SE") + " kr/m²" : "A$ " + v.toLocaleString("en-AU") + "/m²";
  }
  // Asking price: keep Hemnet's exact SEK text in SEK mode, convert otherwise.
  function priceStr(l) {
    if (displayCurrency === "SEK") return l.askingPrice || "—";
    return l.askingPriceNum ? formatSEK(l.askingPriceNum) : (l.askingPrice || "—");
  }
  // Convert "…kr / …K kr / …M kr" amounts inside a preformatted string (e.g. a
  // profit-badge label) to the display currency. No-op in SEK mode.
  function convertMoneyStr(str) {
    if (displayCurrency === "SEK" || !str) return str;
    return str.replace(/(\d[\d\s.,]*)\s*(M|K)?\s*kr\b/g, (m, num, unit) => {
      let n = parseFloat(num.replace(/\s/g, "").replace(",", "."));
      if (!isFinite(n)) return m;
      if (unit === "M") n *= 1e6; else if (unit === "K") n *= 1e3;
      return formatSEKShort(n);
    });
  }
  function formatSEK(n) {
    if (!n) return null;
    const v = Math.round(n * fxRate);
    return displayCurrency === "SEK" ? v.toLocaleString("sv-SE") + " kr" : "A$ " + v.toLocaleString("en-AU");
  }
  function formatSEKShort(n) {
    if (!n) return "—";
    const v = n * fxRate, sign = v < 0 ? "-" : "", abs = Math.abs(v);
    if (displayCurrency === "SEK") {
      if (abs >= 1000000) return sign + (abs / 1000000).toFixed(1) + "M kr";
      return sign + Math.round(abs / 1000) + "K kr";
    }
    if (abs >= 1000000) return sign + "A$ " + (abs / 1000000).toFixed(2) + "M";
    return sign + "A$ " + Math.round(abs).toLocaleString("en-AU");
  }

  // ---- pure helpers ----
  function renoClass(score) {
    if (score >= 7) return "high";
    if (score >= 4) return "medium";
    return "low";
  }
  function renoLabel(score) {
    if (score >= 7) return "High potential";
    if (score >= 4) return "Some potential";
    return "Move-in ready";
  }
  function translateRooms(str) {
    if (!str) return null;
    return str.replace("rum", "rooms").replace("rooms", "rooms");
  }
  function translateFloor(str) {
    if (!str) return null;
    return str.replace(/^vån\s*/i, "Floor ");
  }
  function translateFee(str) {
    if (!str) return null;
    return str.replace("kr/mån", "kr/mo");
  }
  function isApartmentType(str) {
    if (!str) return false;
    return /lägenhet|bostadsrätt/i.test(str);
  }
  function translateLocation(str) {
    if (!str) return str;
    return str.replace(/s kommun/gi, "").replace(/kommun/gi, "").replace(/,\s*$/, "").trim();
  }
  function shareBtnLabel(shared) {
    return shared ? "★ Shared with friends" : "☆ Share with friends";
  }
  function styleShareBtn(btn, shared) {
    btn.textContent = shareBtnLabel(shared);
    btn.style.background = shared ? "#1a3a1a" : "#2a2a2a";
    btn.style.color = shared ? "#69db7c" : "#bbb";
  }
  // A listing was gated by the cheap triage pass if the flag says so (set on
  // listings analysed after the flag shipped) or, for older scores, if its
  // summary carries the triage-gate stand-in text.
  function isGated(l) {
    return l.triageGated === true || (l.renovationSummary || "").startsWith("Triage gate:");
  }

  async function savePreference(listingId, status) {
    const res = await fetch("/api/preference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listingId, status }),
    });
    return res.json().catch(() => ({}));
  }

  // Hiding (❌) or un-saving (💚 off) a listing may have unshared it from the
  // friends dashboard server-side (admin only). Reflect that on the card's
  // ★ button immediately so it doesn't stay stale until reload.
  function reflectUnshare(div, data) {
    if (!data || !data.unshared) return;
    const shareBtn = div.querySelector(".share-friends-btn");
    if (shareBtn) {
      shareBtn.dataset.shared = "0";
      styleShareBtn(shareBtn, false);
    }
  }

  // Build one listing card. ctx carries the page-specific bits so the same card
  // renders on the dashboard, the friends view and favorites:
  //   currentUser      signed-in user (or null)
  //   friendsView      true on /friends (hides admin-only action buttons)
  //   view             active tab key ("deals" | "moveinready" | "newbuild" | "sitting")
  //   onReanalyzed()   async — reload the list after an Opus re-score
  //   onRemoved(l,el)  optional — if set, renders a "Remove" button (favorites)
  //   openShareModal(text)  open the page's copy-link modal
  //   showLoginPrompt()     prompt a signed-out visitor to log in
  function buildListingCard(listing, ctx = {}) {
    const { currentUser = null, friendsView = false, view = "deals" } = ctx;
    const isRejected = listing.preferenceStatus === "rejected";
    const isSaved = listing.preferenceStatus === "saved";

    const div = document.createElement("div");
    div.className = `listing${isRejected ? " rejected" : ""}${isSaved ? " saved" : ""}`;
    div.dataset.id = listing.id;

    const imgs = listing.images && listing.images.length ? listing.images : (listing.thumbnail ? [listing.thumbnail] : []);

    const carouselHtml = imgs.length
      ? `<div class="carousel" data-idx="0">
          <div class="carousel-track" style="transform:translateX(0)">
            ${imgs.map(url => `<img class="carousel-slide" src="${url}" loading="lazy" />`).join("")}
          </div>
          ${imgs.length > 1 ? `<button class="carousel-btn carousel-prev">&#8249;</button><button class="carousel-btn carousel-next">&#8250;</button><div class="carousel-counter">1 / ${imgs.length}</div>` : ""}
        </div>`
      : `<div class="carousel-no-img">No image</div>`;

    const floorPlanHtml = listing.hasFloorPlan === true
      ? `<div class="floor-plan-link">Floor plan: <a href="${listing.link}" target="_blank">View on Hemnet</a></div>`
      : `<div class="floor-plan-link">Floor plan: None provided</div>`;

    const renoCls = listing.renovationScore != null ? renoClass(listing.renovationScore) : null;
    const renoBadgeHtml = listing.renovationScore != null
      ? `<div class="reno-badge ${renoCls}">${listing.renovationScore}/10 — ${renoLabel(listing.renovationScore)}</div>`
      : "";
    const isNew = listing.publishedAt && (Date.now() - new Date(listing.publishedAt).getTime()) < 3 * 24 * 60 * 60 * 1000;
    const newBadgeHtml = isNew ? `<div class="new-badge">NEW</div>` : "";
    const daysOnMarket = listing.publishedAt ? Math.floor((Date.now() - new Date(listing.publishedAt).getTime()) / (1000*60*60*24)) : null;
    // Stale-listing signal. Stockholm flats normally sell in weeks, so a
    // listing on the market for months is a flag worth surfacing.
    const SLOW_DAYS = 180, STALE_DAYS = 365;
    let daysCls = "", daysNote = "on market";
    if (daysOnMarket != null && daysOnMarket >= STALE_DAYS) { daysCls = " stale"; daysNote = "on market · stale"; }
    else if (daysOnMarket != null && daysOnMarket >= SLOW_DAYS) { daysCls = " slow"; daysNote = "on market · slow"; }
    const daysBadgeHtml = daysOnMarket != null
      ? `<div class="days-badge${daysCls}" title="On the market ${daysOnMarket} days${daysCls ? " — unusually long; may be mispriced or stuck" : ""}">${daysOnMarket}d ${daysNote}</div>`
      : "";
    // No flip/profit badge on the New builds tab — they're new construction, not flips.
    const badgeModel = (view !== "newbuild" && listing.askingPriceNum) ? formatProfitBadgeModel(listing) : null;
    const profitBadgeHtml = badgeModel ? `<div class="profit-badge ${badgeModel.cssClass}" title="${badgeModel.detail}">${convertMoneyStr(badgeModel.label)}</div>` : "";
    const gatedBadgeHtml = isGated(listing)
      ? `<div class="gated-badge" title="Gated by the cheap triage pass — kitchen & bathroom looked already renovated, so full scoring was skipped. Low renovation upside.">⚡ triage only</div>`
      : "";
    const renoSummaryHtml = listing.renovationSummary
      ? `<div class="reno-summary ${renoCls}">
          ${listing.renovationSummary}
          ${listing.totalEstimatedCostSEK ? `<br/><span class="reno-cost">Est. renovation: ${formatSEK(listing.totalEstimatedCostSEK)}</span>` : ""}
        </div>`
      : "";
    const missingRoom = listing.renovationScore != null && listing.imageCoverageComplete === false
      ? (listing.kitchenPictured === false && listing.bathroomPictured === false ? "Kitchen & bathroom"
        : listing.bathroomPictured === false ? "Bathroom"
        : listing.kitchenPictured === false ? "Kitchen" : null)
      : null;
    // Suppress the provisional-coverage warning for new builds: projekt listings
    // show staged renders, not real wet-room photos, and a new build needs no
    // bathroom reno — so "Bathroom not pictured" is noise there.
    const coverageWarnHtml = (missingRoom && view !== "newbuild")
      ? `<div class="coverage-warn" title="A key room wasn't in the listing photos, so the renovation score is provisional.">⚠ ${missingRoom} not pictured — score provisional</div>`
      : "";
    const brfIntel = listing.brfIntelligence;
    const arb = brfIntel?.renovationArbitrage;
    const b = brfIntel?.brf;
    const hasStambyte = b?.stambyte?.status && b.stambyte.status !== "unknown";
    const hasDebt = b && (b.debtPerSqm || (b.avgiftRisk && b.avgiftRisk !== "unknown"));
    const hasArb = arb && arb.scope !== "none" && (arb.estimatedUpliftPerSqm != null || arb.totalComparableSales > 0);
    const brfIntelHtml = (hasDebt || hasArb) ? `<div class="brf-intel">
      <h5>BRF intelligence</h5>
      ${b.name || b.buildYear ? `<div class="calc-row"><span class="calc-label">BRF / built</span><span class="calc-value">${b.name || "Unknown"}${b.buildYear ? " · " + b.buildYear : ""}</span></div>` : ""}
      ${hasStambyte ? `<div class="calc-row"><span class="calc-label">Pipe replacement</span><span class="calc-value">${b.stambyte.status}${b.stambyte.year ? " " + b.stambyte.year : ""}</span></div>` : ""}
      ${hasDebt ? `<div class="calc-row"><span class="calc-label">BRF debt risk</span><span class="calc-value">${b.debtPerSqm ? perSqm(b.debtPerSqm) + " · " : ""}${b.avgiftRisk}</span></div>` : ""}
      ${hasArb ? `
      <div class="calc-divider"></div>
      <div class="calc-row sale"><span class="calc-label">Renovated resale</span><span class="calc-value">${arb.estimatedRenovatedSqm ? perSqm(arb.estimatedRenovatedSqm) : "No sold comparables yet"}</span></div>
      ${arb.estimatedUpliftTotal ? `<div class="calc-row profit"><span class="calc-label">Potential uplift for this flat</span><span class="calc-value">+${formatSEKShort(arb.estimatedUpliftTotal)}</span></div>` : ""}
      <div class="calc-row"><span class="calc-label">Evidence</span><span class="calc-value">${arb.scope === "same_brf" ? "Same BRF" : "Area-level"} · ${arb.totalComparableSales} sold · ${arb.confidence} confidence</span></div>
      <div class="intel-note">${arb.summary}</div>` : ""}
    </div>` : "";

    const investHtml = listing.askingPriceNum ? (() => {
      const c = calcInvestment(listing);
      const badge = formatProfitBadgeModel(listing);
      // Move-in-ready "market gap" is a buy-and-resell profit, so it gets the same
      // green profit + ROI headline as the renovation deals.
      const hasResaleProfit = c.classification === "market-gap" && c.renovationProfit > 0;
      const isProfitClass = c.classification === "renovation-upside" || hasResaleProfit;
      const profitClass = isProfitClass ? "profit" : "loss";
      const headline = c.classification === "renovation-upside"
        ? `Estimated renovation profit${c.roi > 0 ? ' (' + c.roi + '% ROI)' : ''}`
        : hasResaleProfit
        ? `Estimated resale profit${c.roi > 0 ? ' (' + c.roi + '% ROI)' : ''}`
        : badge?.detail || "No strong renovation ROI signal";
      return `<div class="invest-calc">
        <h5>Investment analysis</h5>
        <div class="calc-row"><span class="calc-label">Purchase price</span><span class="calc-value">${formatSEKShort(c.price)}</span></div>
        <div class="calc-row"><span class="calc-label">Deposit (10%)</span><span class="calc-value">${formatSEKShort(c.deposit)}</span></div>
        <div class="calc-row"><span class="calc-label">Renovation</span><span class="calc-value">${formatSEKShort(c.renoCost)}</span></div>
        <div class="calc-row"><span class="calc-label">Carrying cost (${c.months}mo × ${(c.feeNum/1000).toFixed(1)}K)</span><span class="calc-value">${formatSEKShort(c.carryingCost)}</span></div>
        <div class="calc-row total"><span class="calc-label">Total investment</span><span class="calc-value">${formatSEKShort(c.totalInvestment)}</span></div>
        <div class="calc-divider"></div>
        <div class="calc-row sale"><span class="calc-label">${c.estimateSource === "sold-comparables" ? "Sold comparables" : "Area benchmark"} (${(c.sqmPrice/1000).toFixed(1)}K/m² avg)</span><span class="calc-value">${formatSEKShort(c.estimatedRenovatedSalePrice)}</span></div>
        <div class="calc-row sale"><span class="calc-label">Market gap before costs</span><span class="calc-value">${c.grossMarketGap > 0 ? '+' : ''}${formatSEKShort(c.grossMarketGap)}</span></div>
        <div class="calc-row ${profitClass}"><span class="calc-label">${headline}</span><span class="calc-value">${isProfitClass ? '+' + formatSEKShort(c.renovationProfit) : convertMoneyStr(badge?.label || '—')}</span></div>
      </div>`;
    })() : "";

    const isAdmin = currentUser && currentUser.role === "admin";
    const removeBtnHtml = ctx.onRemoved ? `<button class="action-btn remove-btn">Remove</button>` : "";
    const sendBuildersHtml = isAdmin && !friendsView ? `<button class="action-btn send-builders-btn" data-id="${listing.id}" style="background:#2a2a1a;color:#ffd43b;">Send to builders</button>` : "";
    const reanalyzeHtml = isAdmin && !friendsView ? `<button class="action-btn reanalyze-btn" data-id="${listing.id}" style="background:#1a2233;color:#7eb8f7;" title="Re-score this listing with Opus (strongest vision) — corrects a wrong score or kitchen/bathroom classification">↻ Reanalyze (Opus)</button>` : "";
    const shareFriendsHtml = isAdmin && !friendsView ? `<button class="action-btn share-friends-btn" data-id="${listing.id}" data-shared="${listing.sharedWithFriends ? "1" : "0"}" title="Show or hide this listing on the friends dashboard">${shareBtnLabel(listing.sharedWithFriends)}</button>` : "";
    const shareLinkHtml = currentUser && (currentUser.role === "admin" || friendsView) ? `<button class="action-btn share-link-btn" data-id="${listing.id}" style="background:#20261a;color:#8fd15a;" title="Copy a personal link to send this listing (e.g. on Messenger) — opens a preview, recipient signs in with Google to see it">📤 Send link</button>` : "";

    div.innerHTML = `
      <div style="position:relative">
        ${carouselHtml}
        ${renoBadgeHtml}
        ${newBadgeHtml}
        ${profitBadgeHtml}
        ${daysBadgeHtml}
        ${gatedBadgeHtml}
      </div>
      <div class="listing-body">
        <div class="listing-header">
          <h3>${listing.streetAddress}</h3>
          <div class="listing-header-actions">
            <button class="cb-btn reject-cb${isRejected ? " active-reject" : ""}" title="Hide">❌</button>
            <button class="cb-btn save-cb${isSaved ? " active-save" : ""}" title="Save">💚</button>
          </div>
        </div>
        <div class="location">${translateLocation(listing.locationDescription)}</div>
        <div class="rejected-summary">${priceStr(listing)} · ${listing.rooms ? listing.rooms.replace('rum','rooms') : ''} · ${listing.size || ''}</div>
        <div class="listing-meta">
          <span class="price-tag">${priceStr(listing)}</span>
          ${listing.rooms ? `<span>${translateRooms(listing.rooms)}</span>` : ""}
          ${listing.size ? `<span>${listing.size}</span>` : ""}
          ${listing.housingForm && !isApartmentType(listing.housingForm) ? `<span>${listing.housingForm}</span>` : ""}
          ${listing.fee ? `<span>Fee ${translateFee(listing.fee)}</span>` : ""}
          ${listing.floor ? `<span>${translateFloor(listing.floor)}</span>` : ""}
          ${listing.squareMeterPrice ? `<span>${displayCurrency === "SEK" ? listing.squareMeterPrice : (listing.askingPriceNum && listing.sizeNum ? perSqm(Math.round(listing.askingPriceNum / listing.sizeNum)) : listing.squareMeterPrice)}</span>` : ""}
        </div>
        ${listing.transitMinutes ? `<div class="listing-agency">${listing.nearestStation} · ${listing.transitLine ? listing.transitLine.replace('T-bana','metro') + ' · ' : ''}${listing.transitMinutes} min to T-Centralen</div>` : ""}
        ${listing.brokerAgencyName ? `<div class="listing-agency">${listing.brokerAgencyName}</div>` : ""}
        ${listing.nextShowing ? `<div class="listing-showing">${listing.nextShowing}</div>` : ""}
        ${listing.brfName || listing.buildYear || listing.stambyteStatus ? `<div class="listing-agency">${listing.brfName ? 'BRF ' + listing.brfName : ''}${listing.buildYear ? ' · Built ' + listing.buildYear : ''}${listing.stambyteStatus ? ' · Pipe replacement: ' + listing.stambyteStatus : ''}</div>` : ""}
        ${renoSummaryHtml}
        ${coverageWarnHtml}
        ${brfIntelHtml}
        ${listing.renovationRooms?.length ? `
          <button class="reno-detail-toggle" data-target="reno-${listing.id}">Show room-by-room breakdown ▾</button>
          <div class="reno-detail" id="reno-${listing.id}">
            ${listing.renovationRooms.map(r => `
              <div class="reno-room ${r.estimatedCostSEK ? 'needs-work' : 'good'}">
                <div class="reno-room-header">
                  <h5>${r.type}</h5>
                  <span class="room-cost ${r.estimatedCostSEK ? '' : 'none'}">${r.estimatedCostSEK ? formatSEKShort(r.estimatedCostSEK) : 'No work needed'}</span>
                </div>
                <div class="condition">${r.condition === 'original' || r.condition === 'dated' ? 'Needs full renovation' : r.condition === 'fair' ? 'Needs cosmetic update' : 'Good condition'}</div>
                ${r.indicators?.length ? `<div class="indicators"><strong style="color:#ccc;">Work needed:</strong><ul>${r.indicators.map(i => '<li>Replace/update: ' + i.replace(/^(Old|Dated|Worn|Original|Basic)\s*/i, '') + '</li>').join('')}</ul></div>` : ''}
              </div>
            `).join('')}
          </div>
        ` : ""}
        ${investHtml}
        ${listing.coordinates?.lat ? `<div class="listing-map" id="map-${listing.id}"></div>` : ""}
        ${floorPlanHtml}
        <div class="listing-actions">
          ${removeBtnHtml}
          <a href="${listing.link}" target="_blank" class="action-btn view-btn">View on Hemnet →</a>
          ${sendBuildersHtml}
          ${reanalyzeHtml}
          ${shareFriendsHtml}
          ${shareLinkHtml}
        </div>
      </div>
    `;

    div.querySelector(".reject-cb").addEventListener("click", async function () {
      if (!currentUser) { ctx.showLoginPrompt?.(); return; }
      const active = this.classList.toggle("active-reject");
      div.classList.toggle("rejected", active);
      if (active) {
        div.querySelector(".save-cb").classList.remove("active-save");
        div.classList.remove("saved");
        reflectUnshare(div, await savePreference(listing.id, "rejected"));
      } else {
        await savePreference(listing.id, null);
      }
    });

    div.querySelector(".save-cb").addEventListener("click", async function () {
      if (!currentUser) { ctx.showLoginPrompt?.(); return; }
      const active = this.classList.toggle("active-save");
      div.classList.toggle("saved", active);
      if (active) {
        div.querySelector(".reject-cb").classList.remove("active-reject");
        div.classList.remove("rejected");
        await savePreference(listing.id, "saved");
      } else {
        reflectUnshare(div, await savePreference(listing.id, null));
      }
    });

    const removeBtn = div.querySelector(".remove-btn");
    if (removeBtn) removeBtn.addEventListener("click", () => ctx.onRemoved(listing, div));

    const renoToggle = div.querySelector(".reno-detail-toggle");
    if (renoToggle) {
      renoToggle.addEventListener("click", function () {
        const detail = document.getElementById(this.dataset.target);
        const open = detail.classList.toggle("open");
        this.textContent = open ? "Hide room-by-room breakdown ▴" : "Show room-by-room breakdown ▾";
      });
    }

    const sendBtn = div.querySelector(".send-builders-btn");
    if (sendBtn) {
      sendBtn.addEventListener("click", async function () {
        const res = await fetch("/api/admin/builders");
        const data = await res.json();
        if (!data.builders?.length) { alert("No builders invited yet. Go to /builders to add some."); return; }
        const names = data.builders.map((b, i) => `${i + 1}. ${b.name} (${b.company || b.email})`).join("\n");
        const pick = prompt("Send to which builders? Enter numbers separated by commas:\n\n" + names);
        if (!pick) return;
        const indices = pick.split(",").map(s => parseInt(s.trim(), 10) - 1).filter(i => i >= 0 && i < data.builders.length);
        if (!indices.length) return;
        const builderIds = indices.map(i => data.builders[i]._id);
        const note = prompt("Add a note for the builders (optional):") || "";
        const assignRes = await fetch("/api/admin/assign", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ listingId: listing.id, builderIds, note }),
        });
        if (assignRes.ok) {
          this.textContent = "Sent!";
          this.style.color = "#69db7c";
          this.style.background = "#1a3a1a";
        }
      });
    }

    const shareBtn = div.querySelector(".share-friends-btn");
    if (shareBtn) {
      styleShareBtn(shareBtn, shareBtn.dataset.shared === "1");
      shareBtn.addEventListener("click", async function () {
        if (this.disabled) return;
        const next = this.dataset.shared !== "1"; // toggle
        this.disabled = true;
        this.style.opacity = "0.7";
        try {
          const res = await fetch(`/api/admin/listings/${listing.id}/share`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shared: next }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) { alert(data.error || "Failed to update sharing"); return; }
          this.dataset.shared = data.shared ? "1" : "0";
          styleShareBtn(this, data.shared);
        } catch (err) {
          alert("Failed to update sharing: " + err.message);
        } finally {
          this.disabled = false; this.style.opacity = "1";
        }
      });
    }

    const shareLinkBtn = div.querySelector(".share-link-btn");
    if (shareLinkBtn) {
      shareLinkBtn.addEventListener("click", function () {
        const url = `${location.origin}/l/${listing.id}`;
        const price = listing.askingPrice ? ` — ${listing.askingPrice}` : "";
        ctx.openShareModal?.(`Have a look at this Stockholm flip: ${listing.streetAddress}${price}\n${url}`);
      });
    }

    const reanalyzeBtn = div.querySelector(".reanalyze-btn");
    if (reanalyzeBtn) {
      reanalyzeBtn.addEventListener("click", async function () {
        if (this.disabled) return;
        const orig = this.textContent;
        this.disabled = true;
        this.style.opacity = "0.7";
        this.textContent = "↻ Reanalyzing with Opus… (~20s)";
        try {
          const res = await fetch(`/api/admin/reanalyze/${listing.id}`, { method: "POST" });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            alert(data.detail || data.error || "Reanalysis failed");
            this.disabled = false; this.style.opacity = "1"; this.textContent = orig;
            return;
          }
          // Re-score may move the listing between views — reload so the corrected
          // score, badge and photos show.
          this.textContent = "Updated ✓"; this.style.color = "#69db7c";
          await ctx.onReanalyzed?.();
        } catch (err) {
          alert("Reanalysis failed: " + err.message);
          this.disabled = false; this.style.opacity = "1"; this.textContent = orig;
        }
      });
    }

    // Carousel navigation
    const carousel = div.querySelector(".carousel");
    if (carousel && imgs.length > 1) {
      const track = carousel.querySelector(".carousel-track");
      const counter = carousel.querySelector(".carousel-counter");
      let idx = 0;
      const goTo = (n) => {
        idx = (n + imgs.length) % imgs.length;
        track.style.transform = `translateX(-${idx * 100}%)`;
        counter.textContent = `${idx + 1} / ${imgs.length}`;
      };
      carousel.querySelector(".carousel-prev").addEventListener("click", () => goTo(idx - 1));
      carousel.querySelector(".carousel-next").addEventListener("click", () => goTo(idx + 1));
    }

    return div;
  }

  // Init the Leaflet map for a card, once it's in the DOM. No-op without coords.
  function mountMap(cardEl, listing) {
    if (!listing.coordinates?.lat) return;
    const mapEl = cardEl.querySelector(`#map-${CSS.escape(listing.id)}`) || document.getElementById("map-" + listing.id);
    if (!mapEl || typeof L === "undefined") return;
    const map = L.map(mapEl, { scrollWheelZoom: false, dragging: false, zoomControl: false }).setView([listing.coordinates.lat, listing.coordinates.lng], 14);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "" }).addTo(map);
    L.marker([listing.coordinates.lat, listing.coordinates.lng]).addTo(map);
  }

  const api = {
    getDisplayCurrency, setDisplayCurrency, getFxInfo, loadFx,
    perSqm, priceStr, convertMoneyStr, formatSEK, formatSEKShort,
    renoClass, renoLabel, translateRooms, translateFloor, translateFee,
    isApartmentType, translateLocation, shareBtnLabel, styleShareBtn, isGated,
    savePreference, buildListingCard, mountMap,
  };
  root.FlipCard = api;
  Object.assign(root, api); // also expose as globals, like profitability.js
})(typeof window !== "undefined" ? window : this);
