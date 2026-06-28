require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const path = require("path");

const scrape = require("./api/scrape");
const scrapeSold = require("./api/scrape-sold");
const { analyzeListingImagesRefresh } = require("./api/analyze-refresh");
const { startScheduler, startCoverageSweep, getCoverageSweepStatus, getCoverageSweepConfig } = require("./api/scheduler");
const jobLock = require("./api/job-lock");
const SoldListing = require("./models/sold.model");
const Listing = require("./api/listing.model");
const User = require("./models/user.model");
const Preference = require("./models/preference.model");
const Builder = require("./models/builder.model");
const Assignment = require("./models/assignment.model");
const Proposal = require("./models/proposal.model");
const Investment = require("./models/investment.model");
const { buildBrfIntelligence } = require("./api/brf-intelligence");
const { buildAreaTrends } = require("./api/sold-trends");
const { buildAreaIntelligence, buildAllAreaIntelligence } = require("./api/area-intelligence");
const { reconcileSoldListings } = require("./api/reconcile-sold");
const { buildScrapeHealth } = require("./api/scrape-health");
const { recordScrapeRun, getRecentScrapeRuns } = require("./api/scrape-run.model");
const { presentListingForFeed } = require("./api/listing-presenter");
const { buildActiveScrapeOptions, buildImageAnalysisOptions, buildSoldScrapeOptions } = require("./api/scrape-options");
const { buildVersionInfo } = require("./api/version");
const { buildActiveFeedFilter, SITTING_MIN_DAYS } = require("./api/listings-query");
const { AREA_NAMES } = require("./api/hemnet-refresh-safety");

const app = express();
const PORT = process.env.PORT || 3001;
const STARTED_AT = new Date().toISOString();

app.use(express.json());

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 },
  })
);

const CALLBACK_URL =
  process.env.NODE_ENV === "production"
    ? `${process.env.BASE_URL}/auth/google/callback`
    : "http://localhost:3001/auth/google/callback";

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: CALLBACK_URL,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        let user = await User.findOne({ googleId: profile.id });
        if (!user) {
          user = await User.create({
            googleId: profile.id,
            email: profile.emails[0].value,
            name: profile.displayName,
            avatar: profile.photos[0].value,
          });
        }
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try { done(null, await User.findById(id)); } catch (err) { done(err); }
});

app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname)));

const requireAuth = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: "Not authenticated" });

function requireRefreshToken(req, res, next) {
  if (!process.env.REFRESH_TOKEN) {
    return res.status(503).json({ error: "Refresh token is not configured" });
  }
  const token = req.query.token || req.get("x-refresh-token");
  if (token !== process.env.REFRESH_TOKEN) return res.status(401).json({ error: "Invalid refresh token" });
  next();
}

function listingWithBrfIntelligence(listing, soldListings) {
  // buildBrfIntelligence only reads fields off each sold listing, so there's no
  // need to clone the (shared) sold array on every call — that was O(listings ×
  // sold) deep-clones per request and made the move-in-ready feed time out.
  // Callers pass .lean() results, so `listing` is already a plain object.
  const lo = typeof listing.toObject === "function" ? listing.toObject() : listing;
  return {
    ...lo,
    brfIntelligence: buildBrfIntelligence(lo, soldListings),
  };
}

// Auth
function roleRedirect(user) {
  if (user.role === "admin") return "/";
  return "/invest";
}

app.get("/auth/google", (req, res, next) => {
  req.session.returnTo = req.query.returnTo || null;
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});
app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => {
    const returnTo = req.session.returnTo;
    delete req.session.returnTo;
    res.redirect(returnTo || roleRedirect(req.user));
  }
);
app.get("/auth/logout", (req, res) => req.logout(() => res.redirect("/login")));

// Email/password signup
app.post("/auth/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: "Email already registered" });
    const user = await User.create({ name, email, password, role: "investor" });
    req.login(user, (err) => {
      if (err) return res.status(500).json({ error: "Login failed" });
      res.json({ ok: true, redirect: roleRedirect(user) });
    });
  } catch (err) {
    res.status(500).json({ error: "Signup failed" });
  }
});

// Email/password login
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !user.password) return res.status(401).json({ error: "Invalid email or password" });
    const valid = await user.comparePassword(password);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });
    req.login(user, (err) => {
      if (err) return res.status(500).json({ error: "Login failed" });
      res.json({ ok: true, redirect: roleRedirect(user) });
    });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

// Current user
app.get("/api/me", (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: { name: req.user.name, email: req.user.email, avatar: req.user.avatar, role: req.user.role, settings: req.user.settings } });
});

// Update settings
app.patch("/api/settings", requireAuth, async (req, res) => {
  try {
    const { maxPrice, areas } = req.body;
    const update = {};
    if (maxPrice != null) update["settings.maxPrice"] = maxPrice;
    if (areas != null) update["settings.areas"] = areas;
    await User.findByIdAndUpdate(req.user.id, update);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save settings" });
  }
});

// Delete account
app.delete("/api/account", requireAuth, async (req, res) => {
  try {
    await Preference.deleteMany({ userId: req.user.id });
    await User.findByIdAndDelete(req.user.id);
    req.logout(() => res.json({ ok: true }));
  } catch (err) {
    res.status(500).json({ error: "Failed to delete account" });
  }
});

// Listings — public, preferences injected if logged in
app.get("/api/listings", async (req, res) => {
  try {
    const settings = req.user?.settings ?? {
      maxPrice: 4000000,
      areas: [...AREA_NAMES],
    };

    const sortParam = req.query.sort;
    let sortOrder;
    if (sortParam === "renovation") {
      sortOrder = { renovationScore: -1, askingPriceNum: 1 };
    } else if (sortParam === "score-newest") {
      // Best renovation opportunity first; newest within the same score.
      // Unscored listings (renovationScore null) sort last in descending order.
      sortOrder = { renovationScore: -1, publishedAt: -1 };
    } else {
      sortOrder = { askingPriceNum: 1 };
    }

    // Active, in-budget listings, split into the dashboard "deals" (strong
    // flips + pending) and the "moveinready" browse view. Only currently-
    // available listings are returned; anything that left Hemnet is handled by
    // the sold view. See api/listings-query.js.
    const view = ["moveinready", "newbuild", "sitting"].includes(req.query.view) ? req.query.view : "deals";
    // The SITTING_MIN_DAYS cutoff (listings published at least that long ago).
    // Computed here (not in the pure query builder) so the builder stays
    // deterministic/testable. The sitting view uses it to SELECT; move-in-ready
    // uses it to EXCLUDE sitting listings (so a renovated unit isn't in both).
    // Deals are exempt (an aged strong flip stays a deal) and newbuild ignores it.
    const sittingBefore = view === "newbuild"
      ? undefined
      : new Date(Date.now() - SITTING_MIN_DAYS * 24 * 60 * 60 * 1000);
    const filter = buildActiveFeedFilter({ view, maxPrice: settings.maxPrice, sittingBefore });

    const listings = await Listing.find(filter, { __v: 0 }).sort(sortOrder).lean();
    const soldListings = await SoldListing.find({}, { __v: 0 }).sort({ soldDate: -1 }).lean();

    const preferences = req.user ? await Preference.find({ userId: req.user.id }) : [];
    const prefMap = {};
    preferences.forEach((p) => (prefMap[p.listingId] = p.status));

    res.json({
      total: listings.length,
      listings: listings.map((l) => presentListingForFeed(listingWithBrfIntelligence(l, soldListings), prefMap[l.id] || null)),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch listings" });
  }
});

// BRF intelligence for one listing: BRF health + renovated-vs-unrenovated similar sold properties
app.get("/api/listings/:listingId/brf-intelligence", async (req, res) => {
  try {
    const listing = await Listing.findOne({ id: req.params.listingId }, { __v: 0 }).lean();
    if (!listing) return res.status(404).json({ error: "Listing not found" });
    const soldListings = await SoldListing.find({}, { __v: 0 }).sort({ soldDate: -1 }).lean();
    res.json({ brfIntelligence: buildBrfIntelligence(listing, soldListings) });
  } catch (err) {
    res.status(500).json({ error: "Failed to build BRF intelligence" });
  }
});

// Save preference
app.post("/api/preference", requireAuth, async (req, res) => {
  try {
    const { listingId, status } = req.body;
    if (!status) {
      await Preference.deleteOne({ userId: req.user.id, listingId });
    } else {
      await Preference.findOneAndUpdate(
        { userId: req.user.id, listingId },
        { status },
        { upsert: true }
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save preference" });
  }
});

// Saved listings
app.get("/api/favorites", requireAuth, async (req, res) => {
  try {
    const prefs = await Preference.find({ userId: req.user.id, status: "saved" });
    const ids = prefs.map((p) => p.listingId);
    const listings = await Listing.find({ id: { $in: ids } }, { __v: 0 }).lean();
    const soldListings = await SoldListing.find({}, { __v: 0 }).sort({ soldDate: -1 }).lean();
    res.json({ total: listings.length, listings: listings.map((l) => presentListingForFeed(listingWithBrfIntelligence(l, soldListings), "saved")) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch favorites" });
  }
});

// Sold listings
app.get("/api/sold", async (req, res) => {
  try {
    const listings = await Listing.find({ status: { $in: ["confirmed_sold", "sold"] } }, { __v: 0 }).sort({ soldDate: -1 });
    const avgDays = listings.length ? Math.round(listings.reduce((s, l) => s + (l.daysOnMarket || 0), 0) / listings.length) : 0;
    const avgPrice = listings.length ? Math.round(listings.reduce((s, l) => s + (l.askingPriceNum || 0), 0) / listings.length) : 0;
    res.json({
      total: listings.length,
      avgDaysOnMarket: avgDays,
      avgAskingPrice: avgPrice,
      listings: listings.map((l) => l.toObject()),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sold listings" });
  }
});

// ── Builder auth (magic link via token) ──
app.get("/auth/builder", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect("/builder/login");
  const builder = await Builder.findOne({ token });
  if (!builder) return res.redirect("/builder/login?error=invalid");
  builder.lastLoginAt = new Date();
  await builder.save();
  req.session.builderId = builder.id;
  res.redirect("/builder");
});

app.get("/auth/builder/logout", (req, res) => {
  delete req.session.builderId;
  res.redirect("/builder/login");
});

const requireBuilder = async (req, res, next) => {
  if (!req.session.builderId) return res.status(401).json({ error: "Not authenticated" });
  req.builder = await Builder.findById(req.session.builderId);
  if (!req.builder) return res.status(401).json({ error: "Builder not found" });
  next();
};

// ── Builder API (builder-facing) ──
app.get("/api/builder/me", requireBuilder, (req, res) => {
  const b = req.builder;
  res.json({ builder: { id: b.id, name: b.name, email: b.email, company: b.company } });
});

app.get("/api/builder/assignments", requireBuilder, async (req, res) => {
  try {
    const assignments = await Assignment.find({ builderId: req.builder.id }).sort({ assignedAt: -1 });
    const listingIds = assignments.map((a) => a.listingId);
    const listings = await Listing.find({ id: { $in: listingIds } }, { __v: 0 });
    const listingMap = {};
    listings.forEach((l) => (listingMap[l.id] = l.toObject()));

    const proposals = await Proposal.find({ builderId: req.builder.id });
    const proposalMap = {};
    proposals.forEach((p) => (proposalMap[p.assignmentId.toString()] = p.toObject()));

    res.json({
      assignments: assignments.map((a) => ({
        ...a.toObject(),
        listing: listingMap[a.listingId] || null,
        proposal: proposalMap[a.id] || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch assignments" });
  }
});

app.post("/api/builder/proposal", requireBuilder, async (req, res) => {
  try {
    const { assignmentId, estimatedCostSEK, costBreakdown, timelineWeeks, bufferWeeks, startDate, notes } = req.body;
    const assignment = await Assignment.findOne({ _id: assignmentId, builderId: req.builder.id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    await Proposal.findOneAndUpdate(
      { assignmentId: assignment.id },
      { builderId: req.builder.id, listingId: assignment.listingId, estimatedCostSEK, costBreakdown, timelineWeeks, bufferWeeks: bufferWeeks || 4, startDate, notes, submittedAt: new Date() },
      { upsert: true }
    );
    assignment.status = "proposed";
    await assignment.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to submit proposal" });
  }
});

// ── Admin API (Claire-facing) ──
app.get("/api/admin/builders", requireAuth, async (req, res) => {
  try {
    const builders = await Builder.find({}, { token: 0, __v: 0 }).sort({ invitedAt: -1 });
    res.json({ builders });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch builders" });
  }
});

app.post("/api/admin/builders", requireAuth, async (req, res) => {
  try {
    const { name, email, company, phone } = req.body;
    const builder = await Builder.create({ name, email, company, phone });
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    res.json({ builder: { id: builder.id, name, email, company, phone }, inviteLink: `${baseUrl}/auth/builder?token=${builder.token}` });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: "Builder with this email already exists" });
    res.status(500).json({ error: "Failed to invite builder" });
  }
});

app.delete("/api/admin/builders/:id", requireAuth, async (req, res) => {
  try {
    await Assignment.deleteMany({ builderId: req.params.id });
    await Proposal.deleteMany({ builderId: req.params.id });
    await Builder.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to remove builder" });
  }
});

app.post("/api/admin/assign", requireAuth, async (req, res) => {
  try {
    const { listingId, builderIds, note } = req.body;
    const results = [];
    for (const builderId of builderIds) {
      const assignment = await Assignment.findOneAndUpdate(
        { listingId, builderId },
        { note, assignedAt: new Date(), status: "pending" },
        { upsert: true, new: true }
      );
      results.push(assignment);
    }
    res.json({ ok: true, assignments: results });
  } catch (err) {
    res.status(500).json({ error: "Failed to assign listing" });
  }
});

app.get("/api/admin/proposals", requireAuth, async (req, res) => {
  try {
    const { listingId } = req.query;
    const filter = listingId ? { listingId } : {};
    const proposals = await Proposal.find(filter).populate("builderId", "name email company").sort({ submittedAt: -1 });
    res.json({ proposals });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch proposals" });
  }
});

app.patch("/api/admin/assignments/:id", requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["accepted", "declined"].includes(status)) return res.status(400).json({ error: "Invalid status" });
    await Assignment.findByIdAndUpdate(req.params.id, { status });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update assignment" });
  }
});

app.get("/api/admin/assignments", requireAuth, async (req, res) => {
  try {
    const assignments = await Assignment.find().populate("builderId", "name email company").sort({ assignedAt: -1 });
    const listingIds = [...new Set(assignments.map((a) => a.listingId))];
    const listings = await Listing.find({ id: { $in: listingIds } }, { __v: 0 });
    const listingMap = {};
    listings.forEach((l) => (listingMap[l.id] = l.toObject()));

    const proposals = await Proposal.find();
    const proposalMap = {};
    proposals.forEach((p) => (proposalMap[p.assignmentId.toString()] = p.toObject()));

    res.json({
      assignments: assignments.map((a) => ({
        ...a.toObject(),
        listing: listingMap[a.listingId] || null,
        proposal: proposalMap[a.id] || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch assignments" });
  }
});

// ── Investor API ──

// Get investable listings (builder-accepted only) with funding status
app.get("/api/invest/listings", async (req, res) => {
  try {
    const accepted = await Assignment.find({ status: "accepted" });
    const listingIds = [...new Set(accepted.map((a) => a.listingId))];
    if (!listingIds.length) return res.json({ listings: [] });

    const listings = await Listing.find({ id: { $in: listingIds } }, { __v: 0 }).lean();
    const soldListings = await SoldListing.find({}, { __v: 0 }).sort({ soldDate: -1 }).lean();
    const proposals = await Proposal.find({ listingId: { $in: listingIds } });
    const proposalMap = {};
    for (const p of proposals) {
      const a = accepted.find((a) => a._id.toString() === p.assignmentId.toString() && a.status === "accepted");
      if (a) proposalMap[p.listingId] = p.toObject();
    }

    const investments = await Investment.find({ listingId: { $in: listingIds } });
    const fundingMap = {};
    investments.forEach((inv) => {
      if (!fundingMap[inv.listingId]) fundingMap[inv.listingId] = { total: 0, investors: [] };
      fundingMap[inv.listingId].total += inv.amountSEK;
      fundingMap[inv.listingId].investors.push({ userId: inv.userId, amount: inv.amountSEK });
    });

    const result = listings.map((l) => {
      const lo = listingWithBrfIntelligence(l, soldListings);
      const proposal = proposalMap[l.id];
      const deposit = Math.round((lo.askingPriceNum || 0) * 0.1);
      const renoCost = proposal?.estimatedCostSEK || lo.totalEstimatedCostSEK || 0;
      const fee = lo.fee ? parseInt(lo.fee.replace(/\D/g, ""), 10) || 0 : 0;
      const timelineMonths = proposal ? Math.ceil((proposal.timelineWeeks + (proposal.bufferWeeks || 4)) / 4.33) : 6;
      const carryingCost = fee * timelineMonths;
      const totalNeeded = deposit + renoCost + carryingCost;
      const funding = fundingMap[l.id] || { total: 0, investors: [] };
      const userInvestment = req.user ? funding.investors.find((i) => i.userId.toString() === req.user.id) : null;

      return {
        ...lo,
        proposal: proposal ? { estimatedCostSEK: proposal.estimatedCostSEK, costBreakdown: proposal.costBreakdown, timelineWeeks: proposal.timelineWeeks, bufferWeeks: proposal.bufferWeeks, startDate: proposal.startDate } : null,
        funding: { deposit, renoCost, carryingCost, totalNeeded, funded: funding.total, percent: totalNeeded > 0 ? Math.min(100, Math.round((funding.total / totalNeeded) * 100)) : 0, investorCount: funding.investors.length, myInvestment: userInvestment?.amount || 0 },
      };
    });

    res.json({ listings: result });
  } catch (err) {
    console.error("Invest listings error:", err);
    res.status(500).json({ error: "Failed to fetch listings" });
  }
});

// Get single listing detail for investor view
app.get("/api/invest/listing/:listingId", async (req, res) => {
  try {
    const listing = await Listing.findOne({ id: req.params.listingId }, { __v: 0 }).lean();
    if (!listing) return res.status(404).json({ error: "Listing not found" });

    const assignment = await Assignment.findOne({ listingId: req.params.listingId, status: "accepted" });
    const proposal = assignment ? await Proposal.findOne({ assignmentId: assignment._id }) : null;
    const builder = assignment ? await Builder.findById(assignment.builderId, "name company") : null;

    const investments = await Investment.find({ listingId: req.params.listingId }).populate("userId", "name");
    const soldListings = await SoldListing.find({}, { __v: 0 }).sort({ soldDate: -1 }).lean();
    const lo = listingWithBrfIntelligence(listing, soldListings);
    const deposit = Math.round((lo.askingPriceNum || 0) * 0.1);
    const renoCost = proposal?.estimatedCostSEK || lo.totalEstimatedCostSEK || 0;
    const fee = lo.fee ? parseInt(lo.fee.replace(/\D/g, ""), 10) || 0 : 0;
    const timelineMonths = proposal ? Math.ceil((proposal.timelineWeeks + (proposal.bufferWeeks || 4)) / 4.33) : 6;
    const carryingCost = fee * timelineMonths;
    const totalNeeded = deposit + renoCost + carryingCost;
    const funded = investments.reduce((s, i) => s + i.amountSEK, 0);
    const userInvestment = req.user ? investments.filter((i) => i.userId._id.toString() === req.user.id).reduce((s, i) => s + i.amountSEK, 0) : 0;

    res.json({
      listing: lo,
      proposal: proposal ? { estimatedCostSEK: proposal.estimatedCostSEK, costBreakdown: proposal.costBreakdown, timelineWeeks: proposal.timelineWeeks, bufferWeeks: proposal.bufferWeeks, startDate: proposal.startDate, notes: proposal.notes } : null,
      builder: builder ? { name: builder.name, company: builder.company } : null,
      funding: { deposit, renoCost, carryingCost, totalNeeded, funded, percent: totalNeeded > 0 ? Math.min(100, Math.round((funded / totalNeeded) * 100)) : 0, investorCount: investments.length, myInvestment: userInvestment, investors: investments.map((i) => ({ name: i.userId.name, amount: i.amountSEK, date: i.investedAt })) },
    });
  } catch (err) {
    console.error("Listing detail error:", err);
    res.status(500).json({ error: "Failed to fetch listing" });
  }
});

// Make an investment
app.post("/api/invest", requireAuth, async (req, res) => {
  try {
    const { listingId, amountSEK } = req.body;
    if (!listingId || !amountSEK || amountSEK <= 0) return res.status(400).json({ error: "Invalid investment" });

    const accepted = await Assignment.findOne({ listingId, status: "accepted" });
    if (!accepted) return res.status(400).json({ error: "This listing is not available for investment" });

    await Investment.create({ listingId, userId: req.user.id, amountSEK });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to invest" });
  }
});

// Scrape trigger
// Human label for an active-scrape run, given its query — matches the wording of
// the DAILY_SCRAPES schedule so the run log and the schedule list read alike.
function activeScrapeLabel(query = {}) {
  if (query.batch != null && query.batch !== "") {
    const total = process.env.ACTIVE_SCRAPE_BATCHES || 3;
    return `Active listings — batch ${query.batch} of ${total}`;
  }
  if (query.areas != null && query.areas !== "") return `Active listings — ${query.areas}`;
  return "Active listings — all areas";
}

app.get("/api/scrape", requireRefreshToken, async (req, res) => {
  // Hold the shared job lock so the coverage sweep / nightly run defer to this
  // scrape. If another heavy job is mid-flight, 409 quickly; GitHub Actions retries.
  if (!jobLock.acquire("http-scrape")) {
    return res.status(409).json({ error: "Busy", detail: `Another job is running: ${jobLock.currentJob()}` });
  }
  const startedAt = new Date();
  const label = activeScrapeLabel(req.query);
  try {
    const result = await scrape(buildActiveScrapeOptions(req.query));
    await recordScrapeRun({ job: "active-scrape", label, status: result.partial ? "partial" : "success", startedAt, result });
    res.json({ message: "Scrape complete", ...result });
  } catch (err) {
    console.error("❌ Scrape error:", err);
    await recordScrapeRun({ job: "active-scrape", label, status: "failed", startedAt, error: err.message });
    const status = /Hemnet bot protection|missing __NEXT_DATA__|Refusing to persist zero active listings/.test(err.message) ? 502 : 500;
    res.status(status).json({ error: "Scraping failed", detail: err.message });
  } finally {
    jobLock.release("http-scrape");
  }
});

// Reconcile disappeared listings against scraped sold listings
app.all("/api/reconcile-sold", requireRefreshToken, async (req, res) => {
  try {
    const result = await reconcileSoldListings({ Listing, SoldListing });
    res.json({ message: "Sold reconciliation complete", ...result });
  } catch (err) {
    console.error("❌ Sold reconciliation error:", err);
    res.status(500).json({ error: "Sold reconciliation failed" });
  }
});

// Scrape sold (slutpriser)
app.get("/api/scrape-sold", requireRefreshToken, async (req, res) => {
  const startedAt = new Date();
  const label = req.query.area ? `Sold prices — ${req.query.area}` : "Sold prices (slutpriser)";
  try {
    const result = await scrapeSold(buildSoldScrapeOptions(req.query));
    await recordScrapeRun({ job: "sold-scrape", label, status: "success", startedAt, result });
    res.json({ message: "Sold scrape complete", ...result });
  } catch (err) {
    console.error("❌ Sold scrape error:", err);
    await recordScrapeRun({ job: "sold-scrape", label, status: "failed", startedAt, error: err.message });
    const status = /Hemnet bot protection|missing __NEXT_DATA__|Unknown sold scrape area/.test(err.message) ? 502 : 500;
    res.status(status).json({ error: "Sold scraping failed", detail: err.message });
  }
});

// Analyse already-scraped listing photos separately from Hemnet scraping.
app.get("/api/analyze-images", requireRefreshToken, async (req, res) => {
  // Share the job lock with scrapes and the coverage sweep — one Puppeteer job at
  // a time on the single instance. 409 if busy; GitHub Actions retries.
  if (!jobLock.acquire("http-analyze")) {
    return res.status(409).json({ error: "Busy", detail: `Another job is running: ${jobLock.currentJob()}` });
  }
  const startedAt = new Date();
  try {
    const result = await analyzeListingImagesRefresh(buildImageAnalysisOptions(req.query));
    await recordScrapeRun({ job: "image-analysis", label: "Photo analysis & scoring", status: "success", startedAt, result });
    res.json({ message: "Image analysis complete", ...result });
  } catch (err) {
    console.error("❌ Image analysis refresh error:", err);
    await recordScrapeRun({ job: "image-analysis", label: "Photo analysis & scoring", status: "failed", startedAt, error: err.message });
    res.status(500).json({ error: "Image analysis failed", detail: err.message });
  } finally {
    jobLock.release("http-analyze");
  }
});

// Build/version marker — confirm which commit is live after a deploy. No auth: non-secret.
app.get("/api/version", (req, res) => {
  res.json(buildVersionInfo(process.env, { startedAt: STARTED_AT, uptimeSeconds: process.uptime() }));
});

// Scrape health: tells the UI/operator whether active listings and market sales are stale.
app.get("/api/scrape-health", async (req, res) => {
  try {
    const activeListings = await Listing.find({}, { scrapeDate: 1, lastSeenAt: 1 }).lean();
    const soldListings = await SoldListing.find({}, { scrapedAt: 1, soldDate: 1 }).lean();
    const recentRuns = await getRecentScrapeRuns(20);
    res.json({
      ...buildScrapeHealth({ activeListings, soldListings }),
      recentRuns,
      coverageSweep: {
        enabled: process.env.ENABLE_COVERAGE_SWEEP === "true" || process.env.ENABLE_COVERAGE_SWEEP === "1",
        config: getCoverageSweepConfig(),
        lastRun: getCoverageSweepStatus(),
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch scrape health" });
  }
});

// The canonical list of live areas (names only) so the frontend area picker and
// areas page can render from the server's LOCATION_IDS instead of a hardcoded
// copy that drifts every time an area is added. No auth: non-secret.
app.get("/api/areas", (req, res) => {
  res.json({ areas: AREA_NAMES });
});

// Daily digest: what changed in the last N hours (default 24) — new deals, new
// move-in-ready, new builds (by firstSeenAt), and listings that disappeared (by
// disappearedAt). Categories reuse buildActiveFeedFilter so they match the
// dashboard's views exactly. No maxPrice cap here — the digest reports everything
// found, not just in-budget listings.
app.get("/api/daily-digest", async (req, res) => {
  try {
    const hours = Number(req.query.hours) > 0 ? Number(req.query.hours) : 24;
    const since = new Date(Date.now() - hours * 3600000);
    // "Found in the window" = newly inserted (firstSeenAt, the precise signal going
    // forward) OR — for listings that predate the firstSeenAt field — newly
    // published on Hemnet (publishedAt). The fallback makes the digest show real
    // numbers immediately instead of all-zeros until firstSeenAt populates.
    const freshClause = { $or: [
      { firstSeenAt: { $gte: since } },
      { firstSeenAt: null, publishedAt: { $gte: since } },
      { firstSeenAt: { $exists: false }, publishedAt: { $gte: since } },
    ] };
    const project = (l) => ({
      id: l.id, address: l.streetAddress, area: l.area, price: l.askingPrice,
      rooms: l.rooms, size: l.size, score: l.renovationScore, slug: l.slug, link: l.link,
    });
    // "Newly sitting" = crossed the SITTING_MIN_DAYS on-market threshold within the
    // window (was not sitting `hours` ago, is now). Based on publishedAt, so it
    // works immediately without firstSeenAt.
    const sittingThreshold = new Date(Date.now() - SITTING_MIN_DAYS * 86400000);
    // Pass the cutoff to the flip views too, so a freshly-seen listing that's
    // already been on-market past the threshold is counted as sitting only.
    const findFresh = (view) =>
      Listing.find({ $and: [
        buildActiveFeedFilter({ view, sittingBefore: view === "newbuild" ? undefined : sittingThreshold }),
        freshClause,
      ] }).sort({ firstSeenAt: -1, publishedAt: -1 }).lean();

    const sittingWindowStart = new Date(sittingThreshold.getTime() - hours * 3600000);
    const sittingFilter = buildActiveFeedFilter({ view: "sitting", sittingBefore: sittingThreshold });
    sittingFilter.publishedAt = { $gt: sittingWindowStart, $lte: sittingThreshold, $ne: null };

    // Disappeared reuses the same buyability gates as the feed (area exclusions +
    // per-area price caps), just with status "disappeared" — so a listing that
    // was never buyable (e.g. an over-cap 18M Östermalm unit) doesn't surface
    // here when it leaves Hemnet, matching that it never showed in any section.
    // view "sitting" = real apartments, any score (the union of the buyable
    // views); no sittingBefore, so no publishedAt bound is added.
    const disappearedFilter = buildActiveFeedFilter({ view: "sitting", status: "disappeared" });
    disappearedFilter.disappearedAt = { $gte: since };

    const [deals, moveInReady, newBuilds, sitting, disappeared] = await Promise.all([
      findFresh("deals"),
      findFresh("moveinready"),
      findFresh("newbuild"),
      Listing.find(sittingFilter).sort({ publishedAt: 1 }).lean(),
      Listing.find(disappearedFilter).sort({ disappearedAt: -1 }).lean(),
    ]);

    const pack = (arr) => ({ count: arr.length, listings: arr.map(project) });
    res.json({
      since: since.toISOString(),
      hours,
      deals: pack(deals),
      moveInReady: pack(moveInReady),
      newBuilds: pack(newBuilds),
      sitting: pack(sitting),
      disappeared: pack(disappeared),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to build daily digest" });
  }
});

// Market snapshot: aggregates over ALL active listings (not the deals feed). The
// areas-page snapshot used to compute these from /api/listings, which defaults to
// the ~10-listing deals view — so it reported "10 active / 10 high reno". This
// counts the real active market instead.
app.get("/api/market-stats", async (req, res) => {
  try {
    const actives = await Listing.find(
      { status: "active" },
      { askingPriceNum: 1, renovationScore: 1, squareMeterPrice: 1, publishedAt: 1 }
    ).lean();
    const total = actives.length;
    const prices = actives.map((l) => l.askingPriceNum).filter(Boolean);
    const avgAskingPrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
    const highReno = actives.filter((l) => (l.renovationScore ?? 0) >= 7).length;
    const sqm = actives
      .map((l) => (l.squareMeterPrice ? parseInt(String(l.squareMeterPrice).replace(/\D/g, ""), 10) : null))
      .filter((n) => n > 0);
    const avgSqmPrice = sqm.length ? Math.round(sqm.reduce((a, b) => a + b, 0) / sqm.length) : 0;
    const now = Date.now();
    const newThisWeek = actives.filter((l) => l.publishedAt && now - new Date(l.publishedAt).getTime() < 7 * 864e5).length;
    const newThisMonth = actives.filter((l) => l.publishedAt && now - new Date(l.publishedAt).getTime() < 30 * 864e5).length;
    res.json({ total, avgAskingPrice, highReno, avgSqmPrice, newThisWeek, newThisMonth });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch market stats" });
  }
});

// Sold data API with stats
app.get("/api/sold/stats", async (req, res) => {
  try {
    const all = await SoldListing.find().sort({ soldDate: -1 });
    const areas = {};
    all.forEach((l) => {
      const area = l.area || "Unknown";
      if (!areas[area]) areas[area] = { total: 0, prices: [], sqmPrices: [], daysOnMarket: [], priceChanges: [] };
      areas[area].total++;
      if (l.soldPrice) areas[area].prices.push(l.soldPrice);
      if (l.soldPriceSqm) areas[area].sqmPrices.push(l.soldPriceSqm);
      if (l.daysOnMarket) areas[area].daysOnMarket.push(l.daysOnMarket);
      if (l.priceChange != null) areas[area].priceChanges.push(l.priceChange);
    });

    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    const areaStats = Object.entries(areas).map(([name, d]) => ({
      area: name,
      totalSold: d.total,
      avgSoldPrice: avg(d.prices),
      avgSoldSqm: avg(d.sqmPrices),
      avgDaysOnMarket: avg(d.daysOnMarket),
      avgPriceChange: d.priceChanges.length ? Math.round(d.priceChanges.reduce((a, b) => a + b, 0) / d.priceChanges.length * 10) / 10 : null,
    }));

    res.json({
      total: all.length,
      areaStats,
      listings: all.map((l) => l.toObject()),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sold stats" });
  }
});

// Per-area price trend from scraped sold comps — direction (last 90d vs prior
// 90d) + a monthly kr/m² series for sparklines. Powers the Areas page monitor.
app.get("/api/sold/trends", async (req, res) => {
  try {
    const all = await SoldListing.find({}, { area: 1, soldDate: 1, soldPriceSqm: 1 }).lean();
    res.json({ trends: buildAreaTrends(all) });
  } catch (err) {
    res.status(500).json({ error: "Failed to build sold trends" });
  }
});

// Deep per-area intelligence from our own slutpriser: renovated-vs-unrenovated
// kr/m² spread, liquidity (days on market, sold-vs-asking), and new-build
// sell-through. Answers "is this area's discount a trap or an opportunity" from
// our data. ?area=Kista returns one area; omit it for a map of all areas.
app.get("/api/sold/area-intel", async (req, res) => {
  try {
    const area = req.query.area;
    const fields = { area: 1, soldDate: 1, soldPriceSqm: 1, daysOnMarket: 1, priceChange: 1, conditionLabel: 1, buildYear: 1 };
    const listings = await SoldListing.find(area ? { area } : {}, fields).lean();
    if (area) {
      res.json({ area, intelligence: buildAreaIntelligence(listings) });
    } else {
      res.json({ areas: buildAllAreaIntelligence(listings) });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to build area intelligence" });
  }
});

app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "login.html")));
app.get("/invest", (req, res) => res.sendFile(path.join(__dirname, "investor.html")));
app.get("/invest/:listingId", (req, res) => res.sendFile(path.join(__dirname, "listing-detail.html")));
app.get("/favorites", (req, res) => res.sendFile(path.join(__dirname, "favorites.html")));
app.get("/areas", (req, res) => res.sendFile(path.join(__dirname, "areas.html")));
app.get("/sold", (req, res) => res.sendFile(path.join(__dirname, "sold.html")));
app.get("/glossary", (req, res) => res.sendFile(path.join(__dirname, "glossary.html")));
app.get("/methodology", (req, res) => res.sendFile(path.join(__dirname, "methodology.html")));
app.get("/account", (req, res) => res.sendFile(path.join(__dirname, "account.html")));
app.get("/market", (req, res) => res.sendFile(path.join(__dirname, "market.html")));
app.get("/market-sales", (req, res) => res.sendFile(path.join(__dirname, "market-sales.html")));
app.get("/builders", (req, res) => res.sendFile(path.join(__dirname, "builders.html")));
app.get("/builder/login", (req, res) => res.sendFile(path.join(__dirname, "builder-login.html")));
app.get("/builder", (req, res) => res.sendFile(path.join(__dirname, "builder-portal.html")));
app.get("/{*splat}", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => {
  console.log(`🚀 Running at http://localhost:${PORT}`);
  // Nightly scrape + analysis (incl. self-heal) on the always-on service.
  // No-op unless ENABLE_SCHEDULER=true, so it never fires in dev/tests.
  startScheduler({ scrape, analyze: analyzeListingImagesRefresh });
  startCoverageSweep({ analyze: analyzeListingImagesRefresh });
});
