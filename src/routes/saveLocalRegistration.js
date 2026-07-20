// src/routes/saveLocalRegistration.js
const express = require("express");
const { upload, validateUploadedFiles } = require("../middleware/upload");
const { setJob, getJob } = require("../services/jobStore");
const { saveRegistrationToLocalExcel, FILE_FIELDS } = require("../services/localExcelArchive");
const { mergeDraftFilesWithUploads, getCurpFromReview, findCompletedRegistration, markCurpCompleted, deleteLocalDraft } = require("../services/localDraftStore");
const { archiveRegistrationToGoogle, assertNoDuplicateFinalRegistration } = require("../services/googleArchive");
const { ENV } = require("../config/env");
const { friendlyPayload } = require("../utils/friendlyErrors");

const router = express.Router();

function useGoogleArchiveAsRegistry() {
  return ENV.GOOGLE_ARCHIVE_ENABLED === true || ENV.GOOGLE_ARCHIVE_ENABLED === "true";
}


const uploadFields = upload.fields(FILE_FIELDS.map((name) => ({ name, maxCount: 1 })));

function hasBoundary(req) {
  const ct = req.headers["content-type"];
  return typeof ct === "string" && ct.includes("multipart/form-data") && ct.includes("boundary=");
}



function duplicateCurpPayload(curp, duplicate) {
  return friendlyPayload(
    Object.assign(new Error(`La CURP ${curp} ya tiene un registro final. No se puede registrar de nuevo.`), { code: "DUPLICATE_CURP" }),
    "Esta CURP ya tiene un registro final.",
    { duplicateRegistered: true, duplicate }
  );
}

function parseClientReviewPayload(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed?.summary || !Array.isArray(parsed?.results)) return null;
    return {
      summary: parsed.summary,
      results: parsed.results,
      reviewedAt: parsed.reviewedAt || new Date().toISOString(),
      source: parsed.source || "client_review_payload",
    };
  } catch (_) {
    return null;
  }
}

function processUploadMiddleware(req, res, next) {
  const ct = req.headers["content-type"];
  if (typeof ct === "string" && ct.includes("multipart/form-data") && !hasBoundary(req)) {
    return res.status(400).json(friendlyPayload(new Error("multipart/form-data inválido"), "No se recibieron los archivos."));
  }

  uploadFields(req, res, (err) => {
    if (err) {
      console.error("[/api/registration/save-local] Multer error:", err);
      return res.status(400).json(friendlyPayload(err, "No pudimos leer los archivos enviados."));
    }
    validateUploadedFiles(req, res, next);
  });
}

router.post("/api/registration/save-local", processUploadMiddleware, async (req, res) => {
  const jobId = String(req.body.jobId || "").trim();
  if (!jobId) return res.status(400).json(friendlyPayload(new Error("Falta jobId."), "No se pudo continuar con el formulario."));

  const job = getJob(jobId) || {};
  const finalReview = job.data?.finalReview || parseClientReviewPayload(req.body.clientReviewPayload) || null;

  if (!finalReview?.summary) {
    return res.status(400).json(friendlyPayload(
      new Error("Primero ejecuta la revisión IA final antes de guardar el registro."),
      "No se puede guardar el registro todavía."
    ));
  }

  if (!finalReview.summary.canContinue) {
    return res.status(422).json(friendlyPayload(
      new Error("No se puede guardar como completo porque existen documentos faltantes, rechazados o pendientes de validar."),
      "No se puede guardar el registro como completo.",
      { summary: finalReview.summary, validationErrors: job.validationErrors || [] }
    ));
  }

  try {
    const curpDetected = getCurpFromReview(finalReview);
    if (curpDetected) {
      if (!useGoogleArchiveAsRegistry()) {
        const localDuplicate = await findCompletedRegistration(curpDetected);
        if (localDuplicate) {
          return res.status(409).json(duplicateCurpPayload(curpDetected, localDuplicate));
        }
      }

      if (useGoogleArchiveAsRegistry()) {
        await assertNoDuplicateFinalRegistration(curpDetected);
      }
    }

    setJob(jobId, {
      state: "saving_local_excel",
      message: "Guardando registro…",
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

    const completedCurp = getCurpFromReview(finalReview);
    await markCurpCompleted({
      curp: completedCurp,
      credentialId: result.credentialId,
      jobId,
      googleArchive,
      localArchive: result,
    });

    await deleteLocalDraft(completedCurp);

    setJob(jobId, {
      ok: true,
      state: "saved_local_excel",
      message: "Registro enviado correctamente.",
      saved: true,
      localArchive: result,
      googleArchive,
    });

    return res.json({
      ok: true,
      message: "Registro enviado correctamente.",
      ...result,
      googleArchive,
    });
  } catch (err) {
    console.error("❌ Error guardando registro local:", err);
    const payload = friendlyPayload(err, "No fue posible guardar el registro.", {
      duplicateRegistered: err?.code === "DUPLICATE_CURP",
      code: err?.code || "SAVE_LOCAL_ERROR",
      duplicate: err?.duplicate || null,
    });

    setJob(jobId, {
      ok: false,
      state: "save_local_error",
      message: payload.userMessage || payload.error,
    });

    const status = err?.code === "DUPLICATE_CURP" ? 409 : 500;
    return res.status(status).json(payload);
  }
});

module.exports = { saveLocalRegistrationRouter: router };
