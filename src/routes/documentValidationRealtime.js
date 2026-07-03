// src/routes/documentValidationRealtime.js
const express = require("express");
const { upload, validateUploadedFiles } = require("../middleware/upload");
const { setJob, getJob } = require("../services/jobStore");
const { validateDocument, DOC_RULES } = require("../services/documentValidation");
const { toUpperClean, digitsOnly } = require("../utils/strings");

const router = express.Router();

const uploadFields = upload.fields([
  { name: "document", maxCount: 1 },
  { name: "ine_frontal", maxCount: 1 },
  { name: "ine_reverso", maxCount: 1 },
  { name: "curp", maxCount: 1 },
  { name: "nss_file", maxCount: 1 },
  { name: "constancia", maxCount: 1 },
  { name: "acta", maxCount: 1 },
  { name: "comprobante", maxCount: 1 },
  { name: "licencia", maxCount: 1 },
  { name: "tarjeta", maxCount: 1 },
  { name: "poliza", maxCount: 1 },
  { name: "selfie", maxCount: 1 },
  { name: "estado_cuenta", maxCount: 1 },
]);

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
      console.error("[/api/document-validation/realtime] Multer error:", err);
      return res.status(400).json({ ok: false, error: `Error leyendo archivo: ${err.message}` });
    }
    validateUploadedFiles(req, res, next);
  });
}

function getUploadedFile(req, fieldName) {
  return (req.files?.[fieldName] || req.files?.document || [])[0] || null;
}

router.post("/api/document-validation/realtime", processUploadMiddleware, async (req, res) => {
  const jobId = String(req.body.jobId || "").trim();
  const fieldName = String(req.body.fieldName || "").trim();
  const nombre = toUpperClean(req.body.nombre);
  const telefono = digitsOnly(req.body.telefono).slice(0, 10);

  if (!jobId) return res.status(400).json({ ok: false, error: "Falta jobId." });
  if (!fieldName) return res.status(400).json({ ok: false, error: "Falta fieldName." });
  if (!DOC_RULES[fieldName]) return res.status(400).json({ ok: false, error: `Documento no soportado: ${fieldName}` });

  const file = getUploadedFile(req, fieldName);
  if (!file?.buffer) return res.status(400).json({ ok: false, error: "No se recibió archivo para validar." });

  const currentJob = getJob(jobId) || {};
  const currentData = currentJob.data || {};
  const previousValidation = currentData.documentValidation || {};

  const pendingResult = {
    fieldName,
    label: DOC_RULES[fieldName].label,
    ok: null,
    status: "validating",
    recommendation: "pending",
    issues: [],
    summary: "Validación en curso…"
  };

  setJob(jobId, {
    ok: true,
    state: "validating_document",
    message: `Validando con IA: ${DOC_RULES[fieldName].label}`,
    data: {
      ...currentData,
      nombre: nombre || currentData.nombre,
      telefono: telefono || currentData.telefono,
      documentValidation: {
        ...previousValidation,
        [fieldName]: pendingResult
      }
    }
  });

  try {
    const result = await validateDocument({
      jobId,
      fieldName,
      file,
      expectedName: nombre || currentData.nombre || "SIN_NOMBRE",
    });

    const freshJob = getJob(jobId) || {};
    const freshData = freshJob.data || {};
    const freshValidation = freshData.documentValidation || {};

    const finalResult = {
      ...result,
      status: result.ok ? "approved" : "rejected",
      validatedAt: new Date().toISOString()
    };

    setJob(jobId, {
      ok: result.ok !== false,
      state: result.ok ? "waiting" : "validation_failed",
      message: result.ok
        ? `${DOC_RULES[fieldName].label} aprobado por IA.`
        : `${DOC_RULES[fieldName].label} no aprobado por IA.`,
      validationErrors: result.ok ? null : [finalResult],
      data: {
        ...freshData,
        nombre: nombre || freshData.nombre,
        telefono: telefono || freshData.telefono,
        documentValidation: {
          ...freshValidation,
          [fieldName]: finalResult
        }
      }
    });

    return res.status(result.ok ? 200 : 422).json({
      ok: result.ok === true,
      jobId,
      fieldName,
      result: finalResult
    });
  } catch (err) {
    const message = err?.response?.data?.error?.message || err?.message || "Error validando documento con IA.";

    const errorResult = {
      fieldName,
      label: DOC_RULES[fieldName].label,
      ok: false,
      status: "rejected",
      recommendation: "reject",
      issues: [message],
      summary: "No se pudo validar el documento con IA.",
      validatedAt: new Date().toISOString()
    };

    const freshJob = getJob(jobId) || {};
    const freshData = freshJob.data || {};
    const freshValidation = freshData.documentValidation || {};

    setJob(jobId, {
      ok: false,
      state: "validation_failed",
      message,
      validationErrors: [errorResult],
      data: {
        ...freshData,
        nombre: nombre || freshData.nombre,
        telefono: telefono || freshData.telefono,
        documentValidation: {
          ...freshValidation,
          [fieldName]: errorResult
        }
      }
    });

    return res.status(422).json({
      ok: false,
      jobId,
      fieldName,
      result: errorResult,
      error: message
    });
  }
});

module.exports = { documentValidationRealtimeRouter: router };
