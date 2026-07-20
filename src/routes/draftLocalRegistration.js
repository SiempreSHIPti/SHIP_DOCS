// src/routes/draftLocalRegistration.js
const express = require("express");
const { upload, validateUploadedFiles } = require("../middleware/upload");
const { getJob, setJob } = require("../services/jobStore");
const {
  FILE_FIELDS,
  saveLocalDraft,
  updateLocalDraftCredential,
  loadLocalDraft,
  normalizeCurp,
  getCurpFromReview,
  findCompletedRegistration,
} = require("../services/localDraftStore");
const { ENV } = require("../config/env");
const { createDraftCredentialIfEligible } = require("../services/localExcelArchive");
const { friendlyPayload } = require("../utils/friendlyErrors");
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
      console.error("[/api/registration/save-draft-local] Multer error:", err);
      return res.status(400).json(friendlyPayload(err, "No pudimos leer los archivos enviados."));
    }
    validateUploadedFiles(req, res, next);
  });
}

router.post("/api/registration/save-draft-local", processUploadMiddleware, async (req, res) => {
  const jobId = String(req.body.jobId || "").trim();
  if (!jobId) return res.status(400).json(friendlyPayload(new Error("Falta jobId."), "No se pudo continuar con el formulario."));

  const job = getJob(jobId) || {};
  const finalReview = job.data?.finalReview || parseClientReviewPayload(req.body.clientReviewPayload) || null;

  if (!finalReview?.summary) {
    return res.status(400).json(friendlyPayload(
      new Error("Primero ejecuta la revisión IA final para detectar la CURP del documento."),
      "No se puede guardar el avance todavía."
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
        const googleDuplicate = await findFinalRegistrationByCurp(curpDetected);
        if (googleDuplicate) {
          return res.status(409).json(duplicateCurpPayload(curpDetected, googleDuplicate));
        }
      }
    }

    const result = await saveLocalDraft({
      jobId,
      body: req.body,
      files: req.files,
      reviewPayload: finalReview,
    });

    let credential = {
      generated: false,
      credentialId: "",
      credentialPdf: null,
      eligibility: null,
    };

    try {
      credential = await createDraftCredentialIfEligible({
        jobId,
        body: result.data,
        filePaths: result.filePaths,
        reviewPayload: finalReview,
      });

      result.credentialGenerated = credential.generated === true;
      result.credentialId = credential.credentialId || "";
      result.credentialPdf = credential.credentialPdf || null;
      result.credentialEligibility = credential.eligibility || null;

      await updateLocalDraftCredential(result.curp, credential);
    } catch (credentialError) {
      console.error("[/api/registration/save-draft-local] No se pudo generar credencial:", credentialError);
      result.credentialGenerated = false;
      result.credentialGenerationError = credentialError?.message || "No se pudo generar la credencial.";
    }

    let googleDraft = null;
    if (useGoogleArchiveAsRegistry()) {
      googleDraft = await archiveDraftToGoogle({
        draftResult: result,
        bodyData: result.data,
        reviewPayload: finalReview,
      });
    }

    const credentialGenerated = result.credentialGenerated === true || Boolean(googleDraft?.googleFiles?.credentialPdf?.webViewLink);
    const pendingReasons = result.credentialEligibility?.reasons || [];
    const message = credentialGenerated
      ? `Avance guardado correctamente . Para continuar después, usa la CURP ${result.curp}.`
      : pendingReasons.length
        ? `Avance guardado correctamente.`
        : `Avance guardado correctamente. Para continuar después, usa la CURP ${result.curp}.`;

    setJob(jobId, {
      state: "draft_saved_local",
      message,
      localDraft: result,
      googleDraft,
      credentialGenerated,
      credential,
    });

    return res.json({
      ok: true,
      message,
      ...result,
      credentialGenerated,
      credentialPendingReasons: pendingReasons,
      credentialLink: googleDraft?.googleFiles?.credentialPdf?.webViewLink || result.credentialPdf?.url || "",
      googleDraft,
    });
  } catch (err) {
    const payload = friendlyPayload(err, "No fue posible guardar el avance.", { code: err?.code || "DRAFT_SAVE_ERROR" });
    return res.status(422).json(payload);
  }
});

router.get("/api/registration/draft-local/:curp", async (req, res) => {
  const curp = normalizeCurp(req.params.curp);
  if (!curp || curp.length < 18) {
    return res.status(400).json(friendlyPayload(new Error("CURP inválida."), "La CURP ingresada no es válida."));
  }

  if (!useGoogleArchiveAsRegistry()) {
    const localDuplicate = await findCompletedRegistration(curp);
    if (localDuplicate) {
      return res.status(409).json(duplicateCurpPayload(curp, localDuplicate));
    }
  }

  if (useGoogleArchiveAsRegistry()) {
    const googleDuplicate = await findFinalRegistrationByCurp(curp);
    if (googleDuplicate) {
      return res.status(409).json(duplicateCurpPayload(curp, googleDuplicate));
    }
  }

  let draft = await loadLocalDraft(curp);

  if (!draft && useGoogleArchiveAsRegistry()) {
    draft = await loadGoogleDraftAsLocal(curp);
  }

  if (!draft) {
    return res.status(404).json(friendlyPayload(
      new Error("No se encontró avance para esa CURP."),
      "No encontramos un avance para esa CURP."
    ));
  }

  return res.json({
    ok: true,
    draft,
  });
});

module.exports = { draftLocalRegistrationRouter: router };
