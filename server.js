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
const SoldListing = require("./models/sold.model");
const Listing = require("./api/listing.model");
const User = require("./models/user.model");
const Preference = require("./models/preference.model");
const Builder = require("./models/builder.model");
const Assignment = require("./models/assignment.model");
const Proposal = require("./models/proposal.model");
const Investment = require("./models/investment.model");
const { buildBrfIntelligence } = require("./api/brf-intelligence");
const { reconcileSoldListings } = require("./api/reconcile-sold");
const { buildScrapeHealth } = require("./api/scrape-health");
const { presentListingForFeed } = require("./api/listing-presenter");
const { buildActiveScrapeOptions } = require("./api/scrape-options");

const app = express();
const PORT = process.env.PORT || 3001;

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
  const lo = typeof listing.toObject === "function" ? listing.toObject() : listing;
  const sold = soldListings.map((l) => (typeof l.toObject === "function" ? l.toObject() : l));
  return {
    ...lo,
    brfIntelligence: buildBrfIntelligence(lo, sold),
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
      areas: ["Bromma","Blackeberg","Rissne","Kista","Sollentuna","Skarpnäck","Bagarmossen","Farsta","Enskede","Hökarängen"],
    };

    const sortParam = req.query.sort;
    const sortOrder = sortParam === "renovation"
      ? { renovationScore: -1, askingPriceNum: 1 }
      : { askingPriceNum: 1 };

    const filter = {
      status: { $nin: ["sold", "confirmed_sold"] },
      askingPriceNum: { $lte: settings.maxPrice },
      locationDescription: { $not: /husby|rinkeby|vällingby|akalla/i },
    };
    if (sortParam === "renovation") {
      filter.renovationScore = { $ne: null };
    }

    const listings = await Listing.find(filter, { __v: 0 }).sort(sortOrder);
    const soldListings = await SoldListing.find({}, { __v: 0 }).sort({ soldDate: -1 });

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
    const listing = await Listing.findOne({ id: req.params.listingId }, { __v: 0 });
    if (!listing) return res.status(404).json({ error: "Listing not found" });
    const soldListings = await SoldListing.find({}, { __v: 0 }).sort({ soldDate: -1 });
    res.json({ brfIntelligence: buildBrfIntelligence(listing.toObject(), soldListings.map((l) => l.toObject())) });
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
    const listings = await Listing.find({ id: { $in: ids } }, { __v: 0 });
    const soldListings = await SoldListing.find({}, { __v: 0 }).sort({ soldDate: -1 });
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

    const listings = await Listing.find({ id: { $in: listingIds } }, { __v: 0 });
    const soldListings = await SoldListing.find({}, { __v: 0 }).sort({ soldDate: -1 });
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
      const deposit = Math.round((lo.askingPriceNum || 0) * 0.15);
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
    const listing = await Listing.findOne({ id: req.params.listingId }, { __v: 0 });
    if (!listing) return res.status(404).json({ error: "Listing not found" });

    const assignment = await Assignment.findOne({ listingId: req.params.listingId, status: "accepted" });
    const proposal = assignment ? await Proposal.findOne({ assignmentId: assignment._id }) : null;
    const builder = assignment ? await Builder.findById(assignment.builderId, "name company") : null;

    const investments = await Investment.find({ listingId: req.params.listingId }).populate("userId", "name");
    const soldListings = await SoldListing.find({}, { __v: 0 }).sort({ soldDate: -1 });
    const lo = listingWithBrfIntelligence(listing, soldListings);
    const deposit = Math.round((lo.askingPriceNum || 0) * 0.15);
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
app.get("/api/scrape", requireRefreshToken, async (req, res) => {
  try {
    const result = await scrape(buildActiveScrapeOptions(req.query));
    res.json({ message: "Scrape complete", ...result });
  } catch (err) {
    console.error("❌ Scrape error:", err);
    const status = /Hemnet bot protection|missing __NEXT_DATA__|Refusing to persist zero active listings/.test(err.message) ? 502 : 500;
    res.status(status).json({ error: "Scraping failed", detail: err.message });
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
  try {
    const result = await scrapeSold({
      area: req.query.area,
      detailLimit: req.query.detailLimit,
      includeDetails: req.query.includeDetails !== "false",
    });
    res.json({ message: "Sold scrape complete", ...result });
  } catch (err) {
    console.error("❌ Sold scrape error:", err);
    const status = /Hemnet bot protection|missing __NEXT_DATA__|Unknown sold scrape area/.test(err.message) ? 502 : 500;
    res.status(status).json({ error: "Sold scraping failed", detail: err.message });
  }
});

// Scrape health: tells the UI/operator whether active listings and market sales are stale.
app.get("/api/scrape-health", async (req, res) => {
  try {
    const activeListings = await Listing.find({}, { scrapeDate: 1, lastSeenAt: 1 }).lean();
    const soldListings = await SoldListing.find({}, { scrapedAt: 1, soldDate: 1 }).lean();
    res.json(buildScrapeHealth({ activeListings, soldListings }));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch scrape health" });
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

app.listen(PORT, () => console.log(`🚀 Running at http://localhost:${PORT}`));
