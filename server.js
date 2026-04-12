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
app.get("/{*splat}", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => console.log(`🚀 Running at http://localhost:${PORT}`));
