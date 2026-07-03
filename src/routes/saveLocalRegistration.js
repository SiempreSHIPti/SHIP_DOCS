// src/routes/saveLocalRegistration.js
const express = require("express");
const { upload, validateUploadedFiles } = require("../middleware/upload");
const { setJob, getJob } = require("../services/jobStore");
const { saveRegistrationToLocalExcel, FILE_FIELDS } = require("../services/localExcelArchive");
const { mergeDraftFilesWithUploads } = require("../services/localDraftStore");
const { archiveRegistrationToGoogle } = require("../services/googleArchive");
const { ENV } = require("../config/env");

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
      console.error("[/api/registration/save-local] Multer error:", err);
      return res.status(400).json({ ok: false, error: `Error leyendo archivos: ${err.message}` });
    }
    validateUploadedFiles(req, res, next);
  });
}

router.post("/api/registration/save-local", processUploadMiddleware, async (req, res) => {
  const jobId = String(req.body.jobId || "").trim();
  if (!jobId) return res.status(400).json({ ok: false, error: "Falta jobId." });

  const job = getJob(jobId) || {};
  const finalReview = job.data?.finalReview || null;

  if (!finalReview?.summary) {
    return res.status(400).json({
      ok: false,
      error: "Primero ejecuta la revisión IA final antes de guardar el registro.",
    });
  }

  if (!finalReview.summary.canContinue) {
    return res.status(422).json({
      ok: false,
      error: "No se puede guardar como completo porque existen documentos faltantes o rechazados por IA.",
      summary: finalReview.summary,
      validationErrors: job.validationErrors || [],
    });
  }

  try {
    setJob(jobId, {
      state: "saving_local_excel",
      message: "Guardando archivos, Excel local y generando credencial…",
    });

    const filesForSave = String(req.body.useDraftFiles || "") === "1" && req.body.draftCurp
      ? await mergeDraftFilesWithUploads({ files: req.files, curp: req.body.draftCurp })
      : req.files;

    const result = await saveRegistrationToLocalExcel({
      jobId,
      body: req.body,
      files: filesForSave,
      reviewPayload: finalReview,
    });

    let googleArchive = null;
    if (ENV.GOOGLE_ARCHIVE_ENABLED) {
      googleArchive = await archiveRegistrationToGoogle({
        localResult: result,
        bodyData: result.bodyData,
        reviewPayload: finalReview,
      });
    }

    setJob(jobId, {
      ok: true,
      state: "saved_local_excel",
      message: "Registro guardado en Excel local y credencial generada.",
      saved: true,
      localArchive: result,
      googleArchive,
    });

    return res.json({
      ok: true,
      message: "Registro guardado en Excel local y credencial generada.",
      ...result,
      googleArchive,
    });
  } catch (err) {
    console.error("❌ Error guardando registro local:", err);
    const message = err?.message || "Error guardando registro en Excel local.";

    setJob(jobId, {
      ok: false,
      state: "save_local_error",
      message,
    });

    return res.status(500).json({
      ok: false,
      error: message,
    });
  }
});

module.exports = { saveLocalRegistrationRouter: router };
