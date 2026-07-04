// src/routes/draftLocalRegistration.js
const express = require("express");
const { upload, validateUploadedFiles } = require("../middleware/upload");
const { getJob, setJob } = require("../services/jobStore");
const {
  FILE_FIELDS,
  saveLocalDraft,
  loadLocalDraft,
  normalizeCurp,
  getCurpFromReview,
  findCompletedRegistration,
} = require("../services/localDraftStore");
const { ENV } = require("../config/env");
const { archiveDraftToGoogle, findFinalRegistrationByCurp } = require("../services/googleArchive");

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
    const curpDetected = getCurpFromReview(finalReview);
    if (curpDetected) {
      const localDuplicate = await findCompletedRegistration(curpDetected);
      if (localDuplicate) {
        return res.status(409).json({
          ok: false,
          duplicateRegistered: true,
          code: "DUPLICATE_CURP",
          error: `La CURP ${curpDetected} ya tiene un registro final. No se puede registrar de nuevo.`,
          duplicate: localDuplicate,
        });
      }

      if (ENV.GOOGLE_ARCHIVE_ENABLED) {
        const googleDuplicate = await findFinalRegistrationByCurp(curpDetected);
        if (googleDuplicate) {
          return res.status(409).json({
            ok: false,
            duplicateRegistered: true,
            code: "DUPLICATE_CURP",
            error: `La CURP ${curpDetected} ya tiene un registro final. No se puede registrar de nuevo.`,
            duplicate: googleDuplicate,
          });
        }
      }
    }

    const result = await saveLocalDraft({
      jobId,
      body: req.body,
      files: req.files,
      reviewPayload: finalReview,
    });

    let googleDraft = null;
    if (ENV.GOOGLE_ARCHIVE_ENABLED) {
      googleDraft = await archiveDraftToGoogle({
        draftResult: result,
        bodyData: result.data,
        reviewPayload: finalReview,
      });
    }

    setJob(jobId, {
      state: "draft_saved_local",
      message: `Avance guardado. Para continuar después, usa la CURP ${result.curp}.`,
      localDraft: result,
      googleDraft,
    });

    return res.json({
      ok: true,
      message: `Avance guardado. Para continuar después, usa la CURP ${result.curp}.`,
      ...result,
      googleDraft,
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

  const localDuplicate = await findCompletedRegistration(curp);
  if (localDuplicate) {
    return res.status(409).json({
      ok: false,
      duplicateRegistered: true,
      code: "DUPLICATE_CURP",
      error: `La CURP ${curp} ya tiene un registro final. No se puede registrar de nuevo.`,
      duplicate: localDuplicate,
    });
  }

  if (ENV.GOOGLE_ARCHIVE_ENABLED) {
    const googleDuplicate = await findFinalRegistrationByCurp(curp);
    if (googleDuplicate) {
      return res.status(409).json({
        ok: false,
        duplicateRegistered: true,
        code: "DUPLICATE_CURP",
        error: `La CURP ${curp} ya tiene un registro final. No se puede registrar de nuevo.`,
        duplicate: googleDuplicate,
      });
    }
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
