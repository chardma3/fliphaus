require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const path = require("path");

const scrape = require("./api/scrape");
const Listing = require("./api/listing.model");
const User = require("./models/user.model");
const Preference = require("./models/preference.model");
const Builder = require("./models/builder.model");
const Assignment = require("./models/assignment.model");
const Proposal = require("./models/proposal.model");

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

// Auth
app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => res.redirect("/")
);
app.get("/auth/logout", (req, res) => req.logout(() => res.redirect("/")));

// Current user
app.get("/api/me", (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: { name: req.user.name, email: req.user.email, avatar: req.user.avatar, settings: req.user.settings } });
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
      askingPriceNum: { $lte: settings.maxPrice },
      locationDescription: { $not: /husby|rinkeby|vällingby|akalla/i },
    };
    if (sortParam === "renovation") {
      filter.renovationScore = { $ne: null };
    }

    const listings = await Listing.find(filter, { __v: 0 }).sort(sortOrder);

    const preferences = req.user ? await Preference.find({ userId: req.user.id }) : [];
    const prefMap = {};
    preferences.forEach((p) => (prefMap[p.listingId] = p.status));

    res.json({
      total: listings.length,
      listings: listings.map((l) => ({ ...l.toObject(), status: prefMap[l.id] || null })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch listings" });
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
    res.json({ total: listings.length, listings: listings.map((l) => ({ ...l.toObject(), status: "saved" })) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch favorites" });
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

// Scrape trigger
app.get("/api/scrape", async (req, res) => {
  try {
    const result = await scrape();
    res.json({ message: "Scrape complete", ...result });
  } catch (err) {
    console.error("❌ Scrape error:", err);
    res.status(500).json({ error: "Scraping failed" });
  }
});

app.get("/favorites", (req, res) => res.sendFile(path.join(__dirname, "favorites.html")));
app.get("/areas", (req, res) => res.sendFile(path.join(__dirname, "areas.html")));
app.get("/methodology", (req, res) => res.sendFile(path.join(__dirname, "methodology.html")));
app.get("/account", (req, res) => res.sendFile(path.join(__dirname, "account.html")));
app.get("/market", (req, res) => res.sendFile(path.join(__dirname, "market.html")));
app.get("/builders", (req, res) => res.sendFile(path.join(__dirname, "builders.html")));
app.get("/builder/login", (req, res) => res.sendFile(path.join(__dirname, "builder-login.html")));
app.get("/builder", (req, res) => res.sendFile(path.join(__dirname, "builder-portal.html")));
app.get("/{*splat}", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => console.log(`🚀 Running at http://localhost:${PORT}`));
