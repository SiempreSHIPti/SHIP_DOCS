// src/routes/utilsAdmin.js
"use strict";

const express = require("express");
const { upload, validateUploadedFiles } = require("../middleware/upload");
const { rateLimit } = require("../middleware/security");
const {
  authenticate,
  buildSessionToken,
  requireUtilsAuth,
  requireUtilsWriteHeader,
  setSessionCookie,
  clearSessionCookie,
} = require("../middleware/utilsAuth");
const {
  DOCUMENTS,
  listDrivers,
  getDriverDetail,
  updateDriverMetadata,
  replaceDriverDocument,
  createDriverCredential,
} = require("../services/utilsAdminService");

const router = express.Router();

router.use("/utils/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  next();
});

router.post(
  "/utils/api/login",
  rateLimit({ windowMs: 15 * 60_000, max: 12, keyPrefix: "utils-login" }),
  (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    const user = authenticate(username, password);
    if (!user) {
      return res.status(401).json({ ok: false, error: "Usuario o contraseña incorrectos." });
    }

    const token = buildSessionToken(user);
    setSessionCookie(res, token);
    return res.json({
      ok: true,
      user: {
        username: user.username,
        name: user.name || user.username,
      },
    });
  }
);

router.post("/utils/api/logout", requireUtilsAuth, requireUtilsWriteHeader, (_req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
});

router.get("/utils/api/session", (req, res, next) => {
  requireUtilsAuth(req, res, () => {
    res.json({ ok: true, user: req.utilsUser });
  });
});

router.get("/utils/api/document-types", requireUtilsAuth, (_req, res) => {
  res.json({
    ok: true,
    items: Object.entries(DOCUMENTS).map(([fieldName, meta]) => ({
      fieldName,
      label: meta.label,
      header: meta.header,
    })),
  });
});

router.get("/utils/api/drivers", requireUtilsAuth, async (req, res, next) => {
  try {
    const result = await listDrivers({
      search: req.query.search,
      status: req.query.status,
      offset: req.query.offset,
      limit: req.query.limit,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.get("/utils/api/drivers/:rowNumber", requireUtilsAuth, async (req, res, next) => {
  try {
    const driver = await getDriverDetail(req.params.rowNumber);
    res.json({ ok: true, driver });
  } catch (err) {
    next(err);
  }
});

router.patch(
  "/utils/api/drivers/:rowNumber",
  requireUtilsAuth,
  requireUtilsWriteHeader,
  async (req, res, next) => {
    try {
      const driver = await updateDriverMetadata(req.params.rowNumber, req.body || {}, req.utilsUser);
      res.json({ ok: true, driver });
    } catch (err) {
      next(err);
    }
  }
);

function uploadSingle(req, res, next) {
  upload.fields([{ name: "file", maxCount: 1 }])(req, res, (err) => {
    if (err) return next(err);
    req.file = (req.files?.file || [])[0] || null;
    validateUploadedFiles(req, res, next);
  });
}

router.post(
  "/utils/api/drivers/:rowNumber/documents/:fieldName",
  requireUtilsAuth,
  requireUtilsWriteHeader,
  uploadSingle,
  async (req, res, next) => {
    try {
      const result = await replaceDriverDocument(
        req.params.rowNumber,
        req.params.fieldName,
        req.file,
        req.utilsUser
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/utils/api/drivers/:rowNumber/credential",
  requireUtilsAuth,
  requireUtilsWriteHeader,
  async (req, res, next) => {
    try {
      const result = await createDriverCredential(req.params.rowNumber, req.utilsUser);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = { utilsAdminRouter: router };
