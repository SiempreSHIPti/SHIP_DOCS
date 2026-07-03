// src/routes/gasTest.js
const express = require("express");
const { ENV } = require("../config/env");
const { triggerAppsScriptWebApp } = require("../services/gas");

const router = express.Router();

router.post("/api/test-gas", async (req, res) => {
  try {
    await triggerAppsScriptWebApp({
      telefono: req.body?.telefono || "5512345678",
      nombre: String(req.body?.nombre || "PRUEBA BACKEND").toUpperCase(),
      spreadsheetId: ENV.SPREADSHEET_ID,
      sheetName: ENV.SHEET_NAME
    });
    res.json({ ok:true, message:"GAS respondió {ok:true}" });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

module.exports = { gasTestRouter: router };
