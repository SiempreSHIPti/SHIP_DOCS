// src/routes/submit.js
const express = require("express");
const { ENV } = require("../config/env");
const { upload, validateUploadedFiles } = require("../middleware/upload");
const { setJob, getJob } = require("../services/jobStore");
const { uploadStepFiles, finalizeSubmission } = require("../services/processSubmission");
const { toUpperClean, digitsOnly } = require("../utils/strings");

const router = express.Router();

const uploadFields = upload.fields([
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
  { name: "estado_cuenta", maxCount: 1 }, // CLABE
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
      console.error("[/submit] Multer error:", err);
      return res.status(400).json({ ok: false, error: `Error subiendo archivos: ${err.message}` });
    }
    validateUploadedFiles(req, res, next);
  });
}

function cryptoRandomId() {
  try {
    const crypto = require("crypto");
    return crypto.randomUUID();
  } catch (_) {
    return `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

// 1) /submit-step 
// Submits a single step. Uploads files asynchronously and stores links in jobStore
router.post("/submit-step", processUploadMiddleware, async (req, res) => {
  try {
    const jobId = String(req.body.jobId || "").trim() || cryptoRandomId();
    
    const b = req.body || {};
    // Extract everything safely
    const dataBatch = {
      nombre: toUpperClean(b.nombre),
      telefono: digitsOnly(b.telefono).slice(0, 10),
      direccion: String(b.direccion || "").trim(),
      banco: toUpperClean(b.banco),
      clabeTxt: digitsOnly(b.clabe).slice(0, 18),
      ref1Nombre: toUpperClean(b.ref1_nombre),
      ref1Tel: digitsOnly(b.ref1_tel).slice(0, 10),
      ref2Nombre: toUpperClean(b.ref2_nombre),
      ref2Tel: digitsOnly(b.ref2_tel).slice(0, 10),
      nssNum: digitsOnly(b.nss_num).slice(0, 11)
    };
    
    // Cleanup empty strings so they don't overwrite previous good values
    Object.keys(dataBatch).forEach(k => { if (!dataBatch[k]) delete dataBatch[k] });

    // Initialize or get Job Cache
    const currentJob = getJob(jobId) || {};
    const jobData = currentJob.data || {};
    const newJobData = { ...jobData, ...dataBatch };
    setJob(jobId, { ok: true, state: "uploading_step", data: newJobData, message: "Guardando info de este paso..." });

    // Return jobId immediately so frontend can sync
    res.json({ ok: true, jobId });

    const getF = (id) => (req.files?.[id] || [])[0];
    const incomingFiles = {
      ine_frontal: getF("ine_frontal"),
      ine_reverso: getF("ine_reverso"),
      curp: getF("curp"),
      nss_file: getF("nss_file"),
      constancia: getF("constancia"),
      acta: getF("acta"),
      comprobante: getF("comprobante"),
      licencia: getF("licencia"),
      tarjeta: getF("tarjeta"),
      poliza: getF("poliza"),
      selfie: getF("selfie"),
      estado_cuenta: getF("estado_cuenta")
    };

    // Process files in background if any are present
    const hasFiles = Object.values(incomingFiles).some(f => f?.buffer);
    if (hasFiles) {
        // We MUST rely on nombre & telefono existing (should be sent in step 1 and cached)
        const nameToUse = newJobData.nombre || "SIN_NOMBRE";
        const telToUse = newJobData.telefono || "0000000000";

        const uploadP = uploadStepFiles(jobId, nameToUse, telToUse, incomingFiles)
          .then(({ newLinks, documentValidation }) => {
            const freshJob = getJob(jobId) || {};
            const previousValidation = (freshJob.data || {}).documentValidation || {};
            const finalData = {
              ...(freshJob.data || {}),
              ...newLinks,
              documentValidation: { ...previousValidation, ...(documentValidation || {}) }
            };
            setJob(jobId, { data: finalData, state: "waiting", message: ENV.AI_REVIEW_ONLY_MODE ? "Documentos validados con IA. Modo sólo revisión: no se subieron ni guardaron archivos." : "Documentos validados y guardados. Esperando siguiente paso..." });
          })
          .catch(err => {
            console.error("Step upload failed:", err);
            const message = err.code === "DOCUMENT_VALIDATION_FAILED"
              ? err.message
              : `Fallo al subir archivos: ${err.message}`;
            setJob(jobId, { ok: false, state: "error", message, validationErrors: err.details || null });
          });
          
        const latestJob = getJob(jobId) || {};
        const pArr = latestJob.pendingUploads || [];
        pArr.push(uploadP);
        setJob(jobId, { pendingUploads: pArr });
    } else {
        setJob(jobId, { state: "waiting" });
    }

  } catch (err) {
    console.error("❌ Error /submit-step:", err);
    return res.status(500).json({ ok: false, error: "Error en el paso." });
  }
});

// 2) /submit-final
// Triggers the actual Google Sheet appending with all gathered data
router.post("/submit-final", processUploadMiddleware, async (req, res) => {
  try {
    const jobId = String(req.body.jobId || "");
    if (!jobId) return res.status(400).json({ ok: false, error: "Missing jobId" });

    // In case there's any final fallback data in this last request
    const b = req.body || {};
    const dataBatch = {
      nombre: toUpperClean(b.nombre),
      telefono: digitsOnly(b.telefono).slice(0, 10),
      direccion: String(b.direccion || "").trim(),
      banco: toUpperClean(b.banco),
      clabeTxt: digitsOnly(b.clabe).slice(0, 18),
      ref1Nombre: toUpperClean(b.ref1_nombre),
      ref1Tel: digitsOnly(b.ref1_tel).slice(0, 10),
      ref2Nombre: toUpperClean(b.ref2_nombre),
      ref2Tel: digitsOnly(b.ref2_tel).slice(0, 10),
      nssNum: digitsOnly(b.nss_num).slice(0, 11)
    };
    Object.keys(dataBatch).forEach(k => { if (!dataBatch[k]) delete dataBatch[k] });

    const job = getJob(jobId);
    if (!job || !job.data) {
       return res.status(400).json({ ok: false, error: "Sesion caducada o sin datos previos." });
    }
    
    // Process background process (writing to Sheets) once previous uploads are done
    setImmediate(() => {
       const pending = job.pendingUploads || [];
       setJob(jobId, { state: "processing", message: "Finalizando subida de archivos..." });
       
       Promise.allSettled(pending).then(() => {
          const freshJob = getJob(jobId);
          const finalData = { ...(freshJob.data || {}), ...dataBatch };
          
          if (!finalData.nombre || !finalData.telefono) {
             setJob(jobId, { ok: false, state: "error", error: "Faltan Nombre o Teléfono para finalizar." });
             return;
          }
          
          finalizeSubmission(jobId, finalData, { setJob });
       });
    });

    res.json({ ok: true, jobId });

  } catch (err) {
    console.error("❌ Error /submit-final:", err);
    return res.status(500).json({ ok: false, error: "Ocurrió un error guardando." });
  }
});

// 3) /status/:jobId
// Used by processing.html to show progress and get final success/error
router.get("/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);
  if (!job) {
    return res.json({ ok: false, state: "error", message: "Proceso no encontrado o caducado." });
  }
  res.json({
    ok: job.ok !== false,
    state: job.state || "processing",
    message: job.message || "",
    sheet: job.sheet || null,
    pdfUrl: job.pdfUrl || null,
    documentValidation: job.data?.documentValidation || null,
    validationErrors: job.validationErrors || null
  });
});

module.exports = { submitRouter: router };
