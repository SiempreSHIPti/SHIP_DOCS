// src/routes/cronCredenciales.js
const express = require("express");
const { ENV } = require("../config/env");
const { runCredentialCronOnce } = require("../jobs/credentialCron");

const router = express.Router();

function requireCronSecret(req, res, next) {
  const sent = String(req.headers["x-cron-secret"] || "").trim();
  const ok = ENV.CRON_SECRET && sent && sent === ENV.CRON_SECRET;
  if (!ok) return res.status(401).json({ ok: false, error: "No autorizado (cron secret)." });
  next();
}

function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

function getCronLimits() {
  const def = toInt(ENV.CRON_DEFAULT_LIMIT || 100, 100);
  const max = toInt(ENV.CRON_MAX_LIMIT || 100, 100);
  return {
    def: Math.max(1, def),
    max: Math.max(1, max),
  };
}

router.get("/api/cron/credenciales", requireCronSecret, async (req, res) => {
  try {
    const { def, max } = getCronLimits();
    const q = toInt(req.query.limit, def);
    const limit = Math.max(1, Math.min(max, q));

    const result = await runCredentialCronOnce({ limit });
    return res.json({ ok: true, limit, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = { cronCredencialesRouter: router };
