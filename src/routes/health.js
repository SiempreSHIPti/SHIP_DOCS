// src/routes/health.js
const express = require("express");
const router = express.Router();
router.get("/api/health", (_, res) => res.json({ ok:true }));
module.exports = { healthRouter: router };
