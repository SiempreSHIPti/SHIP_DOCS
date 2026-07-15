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
const { archiveDraftToGoogle, findFinalRegistrationByCurp, loadGoogleDraftAsLocal } = require("../services/googleArchive");

const router = express.Router();

function useGoogleArchiveAsRegistry() {
  return ENV.GOOGLE_ARCHIVE_ENABLED === true || ENV.GOOGLE_ARCHIVE_ENABLED === "true";
}


const uploadFields = upload.fields(FILE_FIELDS.map((name) => ({ name, maxCount: 1 })));

function hasBoundary(req) {
  const ct = req.headers["content-type"];
  return typeof ct === "string" && ct.includes("multipart/form-data") && ct.includes("boundary=");
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
  const finalReview = job.data?.finalReview || parseClientReviewPayload(req.body.clientReviewPayload) || null;

  if (!finalReview?.summary) {
    return res.status(400).json({
      ok: false,
      error: "Primero ejecuta la revisión IA final para detectar la CURP del documento.",
    });
  }

  try {
    const curpDetected = getCurpFromReview(finalReview);
    if (curpDetected) {
      if (!useGoogleArchiveAsRegistry()) {
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
      }

      if (useGoogleArchiveAsRegistry()) {
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
    if (useGoogleArchiveAsRegistry()) {
      googleDraft = await archiveDraftToGoogle({
        draftResult: result,
        bodyData: result.data,
        reviewPayload: finalReview,
      });
    }

    const credentialGenerated = Boolean(googleDraft?.googleFiles?.credentialPdf?.webViewLink);
    const message = credentialGenerated
      ? `Avance guardado correctamente y credencial generada. Para continuar después, usa la CURP ${result.curp}.`
      : `Avance guardado correctamente. Para continuar después, usa la CURP ${result.curp}.`;

    setJob(jobId, {
      state: "draft_saved_local",
      message,
      localDraft: result,
      googleDraft,
      credentialGenerated,
    });

    return res.json({
      ok: true,
      message,
      credentialGenerated,
      credentialLink: googleDraft?.googleFiles?.credentialPdf?.webViewLink || "",
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

  if (!useGoogleArchiveAsRegistry()) {
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
  }

  if (useGoogleArchiveAsRegistry()) {
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

  let draft = await loadLocalDraft(curp);

  if (!draft && useGoogleArchiveAsRegistry()) {
    draft = await loadGoogleDraftAsLocal(curp);
  }

  if (!draft) {
    return res.status(404).json({
      ok: false,
      error: "No se encontró avance para esa CURP.",
    });
  }

  return res.json({
    ok: true,
    draft,
  });
});

module.exports = { draftLocalRegistrationRouter: router };
