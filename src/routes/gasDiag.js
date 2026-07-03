// src/routes/gasDiag.js
const express = require("express");
const { ENV } = require("../config/env");
const { callGAS_POST, callGAS_GET } = require("../services/gas");

const router = express.Router();

router.get("/api/diag-gas", async (req, res) => {
  try {
    const payload = {
      fn: "ejecutarExtraccionINE",
      secret: ENV.APPS_SCRIPT_SHARED_SECRET || "",
      payload: {
        telefono: "5512345678",
        nombre: "PRUEBA DIAG",
        spreadsheetId: ENV.SPREADSHEET_ID,
        sheetName: ENV.SHEET_NAME,
      }
    };
    const postR = await callGAS_POST(payload);
    const getR  = await callGAS_GET(payload);

    res.json({
      ok: true,
      post: {
        status: postR.status,
        ctype: postR.headers["content-type"] || postR.headers["Content-Type"],
        body: typeof postR.data === "string" ? postR.data : JSON.stringify(postR.data || {}),
      },
      get: {
        status: getR.status,
        ctype: getR.headers["content-type"] || getR.headers["Content-Type"],
        body: typeof getR.data === "string" ? getR.data : JSON.stringify(getR.data || {}),
      },
      env: {
        url: (ENV.APPS_SCRIPT_WEBAPP_URL || "").slice(0, 80) + "…",
        hasSecret: !!ENV.APPS_SCRIPT_SHARED_SECRET
      }
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

module.exports = { gasDiagRouter: router };
