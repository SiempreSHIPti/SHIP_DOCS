// src/routes/draftLocalRegistration.js
const express = require("express");
const { upload, validateUploadedFiles } = require("../middleware/upload");
const { getJob, setJob } = require("../services/jobStore");
const {
  FILE_FIELDS,
  saveLocalDraft,
  loadLocalDraft,
  normalizeCurp,
} = require("../services/localDraftStore");

const router = express.Router();

const uploadFields = upload.fields(FILE_FIELDS.map((name) => ({ name, maxCount: 1 })));

function hasBoundary(req) {
  const ct = req.headers["content-type"];
  return typeof ct === "string" && ct.includes("multipart/form-data") && ct.includes("boundary=");
}

function processUploadMiddleware(req, res, next) {
  const ct = req.headers["content-type"];
  if (typeof ct === "string" && ct.includes("multipart/form-data") && !hasBoundary(req)) {
    return res.status(400).json({ ok: false, error: "multipart/form-data inválido" });
  }

  uploadFields(req, res, (err) => {
    if (err) {
      console.error("[/api/registration/save-draft-local] Multer error:", err);
      return res.status(400).json({ ok: false, error: `Error leyendo archivos: ${err.message}` });
    }
    validateUploadedFiles(req, res, next);
  });
}

router.post("/api/registration/save-draft-local", processUploadMiddleware, async (req, res) => {
  const jobId = String(req.body.jobId || "").trim();
  if (!jobId) return res.status(400).json({ ok: false, error: "Falta jobId." });

  const job = getJob(jobId) || {};
  const finalReview = job.data?.finalReview || null;

  if (!finalReview?.summary) {
    return res.status(400).json({
      ok: false,
      error: "Primero ejecuta la revisión IA final para detectar la CURP del documento.",
    });
  }

  try {
    const result = await saveLocalDraft({
      jobId,
      body: req.body,
      files: req.files,
      reviewPayload: finalReview,
    });

    setJob(jobId, {
      state: "draft_saved_local",
      message: `Avance guardado. Para continuar después, usa la CURP ${result.curp}.`,
      localDraft: result,
    });

    return res.json({
      ok: true,
      message: `Avance guardado. Para continuar después, usa la CURP ${result.curp}.`,
      ...result,
    });
  } catch (err) {
    const message = err?.message || "No fue posible guardar el avance.";
    return res.status(422).json({
      ok: false,
      error: message,
      code: err?.code || "DRAFT_SAVE_ERROR",
    });
  }
});

router.get("/api/registration/draft-local/:curp", async (req, res) => {
  const curp = normalizeCurp(req.params.curp);
  if (!curp || curp.length < 18) {
    return res.status(400).json({ ok: false, error: "CURP inválida." });
  }

  const draft = await loadLocalDraft(curp);
  if (!draft) {
    return res.status(404).json({
      ok: false,
      error: "No se encontró avance local para esa CURP.",
    });
  }

  return res.json({
    ok: true,
    draft,
  });
});

module.exports = { draftLocalRegistrationRouter: router };
