// src/routes/finalDocumentReview.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const { execFile } = require("child_process");
const { upload, validateUploadedFiles, detectMagic } = require("../middleware/upload");
const { setJob, getJob } = require("../services/jobStore");
const { validateDocument, DOC_RULES } = require("../services/documentValidation");
const { toUpperClean, digitsOnly } = require("../utils/strings");
const { getDraftFile, getCurpFromReview, findCompletedRegistration } = require("../services/localDraftStore");
const { ENV } = require("../config/env");
const { findFinalRegistrationByCurp } = require("../services/googleArchive");

const router = express.Router();
const execFileAsync = promisify(execFile);
const AI_VALIDATION_MAX_FILE_BYTES = 5 * 1024 * 1024;

function useGoogleArchiveAsRegistry() {
  return ENV.GOOGLE_ARCHIVE_ENABLED === true || ENV.GOOGLE_ARCHIVE_ENABLED === "true";
}


const FILE_FIELDS = [
  "selfie",
  "estado_cuenta",
  "ine_frontal",
  "ine_reverso",
  "curp",
  "nss_file",
  "constancia",
  "acta",
  "comprobante",
  "licencia",
  "tarjeta",
  "poliza",
];

const FIELD_LABELS = {
  selfie: "Foto personal / selfie",
  estado_cuenta: "Estado de cuenta bancario",
  ine_frontal: "INE frontal",
  ine_reverso: "INE reverso",
  curp: "CURP",
  nss_file: "Documento NSS",
  constancia: "Constancia de situación fiscal",
  acta: "Acta de nacimiento",
  comprobante: "Comprobante de domicilio",
  licencia: "Licencia de conducir",
  tarjeta: "Tarjeta de circulación",
  poliza: "Póliza de seguro",
};


function parseHeavySkippedFiles(value) {
  if (!value) return new Map();
  try {
    const rows = JSON.parse(String(value));
    if (!Array.isArray(rows)) return new Map();
    return new Map(rows
      .filter((row) => row && row.fieldName)
      .map((row) => [String(row.fieldName), {
        fieldName: String(row.fieldName),
        fileName: row.fileName ? String(row.fileName) : null,
        size: Number(row.size || 0) || 0,
      }]));
  } catch (_) {
    return new Map();
  }
}

function formatMb(bytes) {
  const n = Number(bytes || 0);
  if (!n) return "";
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isOptionalNonBlockingFieldForVacancy(fieldName, body = {}) {
  const vacancyType = normalizeVacancyType(body?.tipo_vacante || body?.tipoVacante || body?.vacante || "driver");

  if (vacancyType === "driver" && ["tarjeta", "poliza", "acta"].includes(fieldName)) return true;
  if (vacancyType === "chofer" && ["tarjeta", "poliza"].includes(fieldName)) return true;
  if (vacancyType === "ayudante" && ["licencia", "tarjeta", "poliza"].includes(fieldName)) return true;

  return false;
}

function isBlockingWarningResult(row = {}) {
  return row?.blocking === true || row?.skippedByWeight === true;
}

function buildHeavyFileSkippedResult(fieldName, heavyInfo = {}, body = {}) {
  const sizeText = heavyInfo.size ? ` (${formatMb(heavyInfo.size)})` : "";
  const fileName = heavyInfo.fileName || null;
  const blocking = !isOptionalNonBlockingFieldForVacancy(fieldName, body);

  return {
    fieldName,
    label: FIELD_LABELS[fieldName] || fieldName,
    ok: true,
    status: "warning",
    severity: "warning",
    recommendation: blocking ? "fix_required" : "manual_review",
    fileName,
    issues: [],
    warnings: [
      blocking
        ? `No se validó con IA porque el archivo excede 5 MB${sizeText}. Debe corregirse para guardar el registro final.`
        : `No se validó con IA porque el archivo excede 5 MB${sizeText}. Documento opcional; no bloquea si decides no usarlo.`
    ],
    summary: blocking
      ? "No se validó con IA porque excede el peso permitido para revisión automática. Intenta comprimirlo o sube otro archivo más ligero."
      : "Documento opcional cargado, pero no validado por peso. No bloquea el registro si no es requerido.",
    skippedByWeight: true,
    blocking,
    validatedAt: new Date().toISOString(),
  };
}


function compressionScriptPath() {
  return path.resolve(process.cwd(), "scripts", "compress_document.py");
}

function tempCompressionPath(file, ext = "") {
  const tmpDir = path.join("/tmp", "ship-ai-compression");
  fs.mkdirSync(tmpDir, { recursive: true });
  const safeExt = ext || path.extname(file.originalname || "") || ".bin";
  return path.join(tmpDir, `${Date.now()}_${Math.random().toString(16).slice(2)}${safeExt}`);
}

async function compressFileForAi(file) {
  const originalSize = Number(file?.size || file?.buffer?.length || 0);

  if (!file?.buffer?.length) {
    return { ok: false, reason: "No se recibió archivo para comprimir." };
  }

  const inputExt = path.extname(file.originalname || "") || (String(file.mimetype || "").includes("pdf") ? ".pdf" : ".bin");
  const outputExt = String(file.mimetype || "").startsWith("image/") ? ".jpg" : inputExt;
  const inputPath = tempCompressionPath(file, inputExt);
  const outputPath = tempCompressionPath(file, outputExt);

  try {
    fs.writeFileSync(inputPath, file.buffer);

    const { stdout } = await execFileAsync("python3", [
      compressionScriptPath(),
      inputPath,
      outputPath,
      "--mime",
      file.mimetype || "application/octet-stream",
      "--target-bytes",
      String(AI_VALIDATION_MAX_FILE_BYTES),
    ], {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });

    const info = JSON.parse(String(stdout || "{}"));
    const compressedBuffer = fs.existsSync(outputPath) ? fs.readFileSync(outputPath) : null;

    if (!compressedBuffer?.length) {
      return {
        ok: false,
        reason: info.reason || "El script de compresión no generó archivo de salida.",
        originalSize,
        compressedSize: Number(info.compressed_size || 0) || null,
      };
    }

    const isImage = String(file.mimetype || "").startsWith("image/");
    const mimetype = isImage ? "image/jpeg" : file.mimetype;
    const suffix = isImage ? "_comprimido.jpg" : "_comprimido.pdf";
    const originalBase = String(file.originalname || file.fieldname || "documento").replace(/\.[^.]+$/, "");

    return {
      ok: true,
      file: {
        buffer: compressedBuffer,
        mimetype,
        originalname: `${originalBase}${suffix}`,
        size: compressedBuffer.length,
      },
      originalSize,
      compressedSize: compressedBuffer.length,
      improved: compressedBuffer.length < originalSize,
      scriptInfo: info,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.message || "No se pudo ejecutar el script Python de compresión.",
      originalSize,
      compressedSize: null,
    };
  } finally {
    try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch (_) {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
  }
}


function mergeReviewResultIntoPayload({ jobId, body, fieldName, result }) {
  const job = getJob(jobId) || {};
  const previousValidation = job.data?.documentValidation || {};
  const mergedValidation = {
    ...previousValidation,
    [fieldName]: result,
  };

  const results = buildFinalResultsFromStoredValidation(body, mergedValidation);
  const summary = summarize(results);

  const finalReview = {
    summary,
    results,
    reviewedAt: new Date().toISOString(),
    source: "compressed_target_validation",
  };

  setJob(jobId, {
    ok: summary.canContinue,
    state: "ai_review_completed",
    message: summary.canContinue
      ? "Resumen actualizado con archivo comprimido."
      : "Resumen actualizado; aún hay documentos por revisar.",
    data: {
      ...(job.data || {}),
      documentValidation: mergedValidation,
      finalReview,
    },
    validationErrors: results.filter((x) => x.ok === false),
    validationWarnings: results.filter((x) => x.status === "warning" || x.severity === "warning"),
    finalReviewSummary: summary,
    saved: false,
  });

  return finalReview;
}

function parsePartialFields(value) {
  if (!value) return new Set();
  return new Set(
    String(value)
      .split(",")
      .map((x) => x.trim())
      .filter((x) => FILE_FIELDS.includes(x))
  );
}

function isPartialReview(body) {
  return String(body.reviewMode || "").toLowerCase() === "partial" || parsePartialFields(body.partialFields).size > 0;
}

function isFinalizeFromPartials(body) {
  return String(body.finalizeFromPartials || "") === "1";
}

function buildFinalResultsFromStoredValidation(body, storedValidation = {}) {
  const heavySkippedFiles = parseHeavySkippedFiles(body?.aiSkippedHeavyFiles);
  return FILE_FIELDS.map((fieldName) => {
    const heavyInfo = heavySkippedFiles.get(fieldName);
    if (heavyInfo) {
      return buildHeavyFileSkippedResult(fieldName, heavyInfo, body);
    }

    const existing = storedValidation[fieldName];
    if (existing) {
      return shouldOmitDocumentFromSummary(fieldName, body, existing) ? null : existing;
    }

    if (shouldOmitDocumentFromSummary(fieldName, body, null)) return null;

    const required = isFileRequired(fieldName, body);
    if (!required) {
      return buildSkippedResult(
        fieldName,
        fieldName === "tarjeta"
          ? "Tarjeta de circulación no cargada. Documento opcional; no bloquea el registro."
          : fieldName === "poliza"
            ? "Póliza de seguro no cargada. Documento opcional; no bloquea el registro."
            : "Documento no requerido para este registro."
      );
    }

    return buildMissingResult(fieldName);
  }).filter(Boolean);
}


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
      console.error("[/api/registration/final-review] Multer error:", err);
      return res.status(400).json({ ok: false, error: `Error leyendo archivos: ${err.message}` });
    }
    validateUploadedFiles(req, res, next);
  });
}

async function getFile(req, fieldName) {
  const uploaded = (req.files?.[fieldName] || [])[0] || null;
  if (uploaded) return uploaded;

  const useDraftFiles = String(req.body?.useDraftFiles || "") === "1";
  const draftCurp = req.body?.draftCurp || req.body?.curp || "";

  if (useDraftFiles && draftCurp) {
    return await getDraftFile(draftCurp, fieldName);
  }

  return null;
}

function normalizeVacancyType(value) {
  const raw = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

  if (raw.includes("ayudante")) return "ayudante";
  if (raw.includes("chofer")) return "chofer";
  if (raw.includes("driver")) return "driver";
  return "driver";
}

function isVehicleField(fieldName) {
  return ["licencia", "tarjeta", "poliza"].includes(fieldName);
}

function shouldOmitDocumentFromSummary(fieldName, body, row = null) {
  const vacancyType = normalizeVacancyType(body?.tipo_vacante || body?.tipoVacante || body?.vacante || "driver");
  const status = String(row?.status || "").toLowerCase();
  const hasUploadedFile = !!(row?.fileName || row?.validatedAt);

  // Driver: póliza, tarjeta de circulación y acta de nacimiento son opcionales.
  // Si no se cargan, no deben aparecer como faltantes ni como omitidos.
  if (vacancyType === "driver" && ["tarjeta", "poliza", "acta"].includes(fieldName)) {
    return !hasUploadedFile || status === "skipped" || status === "missing";
  }

  if (!isVehicleField(fieldName)) return false;

  // Ayudante no requiere paso vehicular; no se muestran esos documentos en el resumen.
  if (vacancyType === "ayudante") return true;

  // Chofer sólo requiere licencia; tarjeta y póliza no se solicitan.
  if (vacancyType === "chofer" && (fieldName === "tarjeta" || fieldName === "poliza")) {
    return true;
  }

  return false;
}

function filterResultsForSummary(results = [], body = {}) {
  return (results || []).filter((row) => !shouldOmitDocumentFromSummary(row?.fieldName, body, row));
}

function isFileRequired(fieldName, body) {
  const vacancyType = normalizeVacancyType(body?.tipo_vacante || body?.tipoVacante || body?.vacante || "driver");

  if (vacancyType === "driver" && fieldName === "acta") {
    return false; // Driver: acta de nacimiento opcional.
  }

  if (isVehicleField(fieldName)) {
    if (vacancyType === "driver") return fieldName === "licencia"; // Driver: licencia obligatoria; tarjeta/póliza opcionales.
    if (vacancyType === "chofer") return fieldName === "licencia"; // Chofer: sólo licencia obligatoria.
    if (vacancyType === "ayudante") return false; // Ayudante: paso vehicular no obligatorio.
  }

  if (fieldName === "estado_cuenta") {
    return true; // Estado de cuenta siempre requerido; ya no existe captura manual de CLABE/banco.
  }

  if (fieldName === "nss_file") {
    return String(body.nss_mode || "").toLowerCase() === "archivo";
  }

  return true;
}

function poolLimit(limit) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();

    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        active--;
        next();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

function buildSkippedResult(fieldName, reason) {
  return {
    fieldName,
    label: FIELD_LABELS[fieldName] || fieldName,
    ok: true,
    status: "skipped",
    recommendation: "accept",
    issues: [],
    summary: reason,
    skipped: true,
  };
}

function buildMissingResult(fieldName) {
  return {
    fieldName,
    label: FIELD_LABELS[fieldName] || fieldName,
    ok: false,
    status: "missing",
    recommendation: "reject",
    issues: ["Documento faltante. Debes subir este archivo para completar el registro."],
    summary: "No se recibió archivo.",
    missing: true,
  };
}

function buildErrorResult(fieldName, err) {
  const message =
    err?.response?.data?.error?.message ||
    err?.message ||
    "Error validando documento con IA.";

  return {
    fieldName,
    label: FIELD_LABELS[fieldName] || fieldName,
    ok: false,
    status: "rejected",
    recommendation: "reject",
    issues: [message],
    summary: "No se pudo validar el documento con IA.",
  };
}


function normalizeDriverNameForValidation(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-ZÑ\s]/gi, " ")
    .toUpperCase()
    .replace(/\b(DE|DEL|LA|LAS|LOS|Y|DA|DAS|DOS)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePersonName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-ZÑ\s]/gi, " ")
    .toUpperCase()
    .replace(/\b(DE|DEL|LA|LAS|LOS|Y|DA|DAS|DOS)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function personNameSimilarity(expected, found) {
  const expectedTokens = normalizePersonName(expected).split(" ").filter((token) => token.length > 2);
  const foundTokens = new Set(normalizePersonName(found).split(" ").filter((token) => token.length > 2));

  if (!expectedTokens.length || !foundTokens.size) return 0;

  const hits = expectedTokens.filter((token) => foundTokens.has(token)).length;
  return hits / expectedTokens.length;
}

function textOfResult(result) {
  return [
    result?.summary,
    result?.nameFound,
    ...(result?.issues || []),
    ...(result?.warnings || []),
  ]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isAccentOrExactNameOnlyText(text) {
  return (
    text.includes("acent") ||
    text.includes("diferencia en acentos") ||
    text.includes("debido a ausencia de acentos") ||
    text.includes("difiere en acentos") ||
    text.includes("coincide en caracteres base") ||
    text.includes("coinciden en caracteres base") ||
    text.includes("interpretacion ocr") ||
    text.includes("no coincide exactamente") ||
    text.includes("exactamente con el nombre")
  );
}

function isNssRfcOnlyText(fieldName, text) {
  return fieldName === "nss_file" && text.includes("rfc");
}

function isOwnershipObservationText(text) {
  return (
    text.includes("propietario") ||
    text.includes("asegurado") ||
    text.includes("titular") ||
    text.includes("no coincide con el nombre esperado") ||
    text.includes("no requiere coincidencia de nombre") ||
    text.includes("no requerir coincidencia")
  );
}

function clearNameAccentIssues(result, expectedName) {
  const similarity = personNameSimilarity(expectedName, result.nameFound);
  const allText = textOfResult(result);
  const nameMatches = similarity >= 0.68;

  if (!nameMatches) return result;

  const cleanIssues = (result.issues || []).filter((issue) => {
    const text = String(issue || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

    if (isAccentOrExactNameOnlyText(text)) return false;
    if (text.includes("no coincide") && text.includes("nombre")) return false;
    if (text.includes("nombre detectado no coincide")) return false;

    return true;
  });

  const cleanSummary = isAccentOrExactNameOnlyText(allText)
    ? `${result.label || result.fieldName}: nombre validado correctamente ignorando acentos.`
    : result.summary;

  return {
    ...result,
    issues: cleanIssues,
    summary: cleanSummary,
    nameSimilarity: similarity,
    accentInsensitiveNameMatch: true,
  };
}

function applyOperationalRules(result, fieldName, expectedName) {
  let next = {
    ...result,
    issues: Array.isArray(result.issues) ? [...result.issues] : [],
    warnings: Array.isArray(result.warnings) ? [...result.warnings] : [],
  };

  const normalizedExpected = normalizeDriverNameForValidation(expectedName);
  const normalizedFound = normalizeDriverNameForValidation(next.nameFound);
  const nameSimilarity = personNameSimilarity(normalizedExpected, normalizedFound);
  const nameMatchesNormalized = Boolean(normalizedExpected && normalizedFound && nameSimilarity >= 0.68);

  const isDocumentValid =
    next.isExpectedDocument !== false &&
    next.isLegible !== false &&
    Number(next.confidence || 0) >= 0.60;

  const officialDocs = new Set(["curp", "nss_file", "acta", "licencia", "ine_frontal", "constancia", "estado_cuenta"]);
  const optionalOwnerDocs = new Set(["tarjeta", "poliza"]);
  const realDocumentNoOwnerMatchRequired = new Set(["comprobante"]);

  if (realDocumentNoOwnerMatchRequired.has(fieldName)) {
    if (isDocumentValid) {
      return {
        ...next,
        ok: true,
        status: "approved",
        severity: "success",
        recommendation: "accept",
        ownerCheckApplies: false,
        ownerMatchesDriver: null,
        ownerStatus: "not_required",
        issues: [],
        warnings: [],
        summary: `${next.label || fieldName}: comprobante válido. La coincidencia de nombre no es requisito para este documento.`,
      };
    }

    return {
      ...next,
      ok: false,
      status: "rejected",
      severity: "error",
      recommendation: "reject",
    };
  }

  if (officialDocs.has(fieldName)) {
    next = clearNameAccentIssues(next, normalizedExpected);

    next.issues = (next.issues || []).filter((issue) => {
      const text = String(issue || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      if (isNssRfcOnlyText(fieldName, text)) return false;
      if (nameMatchesNormalized && isAccentOrExactNameOnlyText(text)) return false;
      if (nameMatchesNormalized && text.includes("no coincide") && text.includes("nombre")) return false;

      return true;
    });

    if (isDocumentValid && nameMatchesNormalized && (next.issues || []).length === 0) {
      next.ok = true;
      next.status = "approved";
      next.severity = "success";
      next.recommendation = "accept";
      next.nameSimilarity = nameSimilarity;
      next.accentInsensitiveNameMatch = true;
      next.summary = `${next.label || fieldName}: documento válido; el nombre coincide al normalizar acentos.`;
    }

    return next;
  }

  if (optionalOwnerDocs.has(fieldName)) {
    if (!isDocumentValid) {
      return {
        ...next,
        ok: false,
        status: "rejected",
        severity: "error",
        recommendation: "reject",
      };
    }

    if (nameMatchesNormalized) {
      return {
        ...next,
        ok: true,
        status: "approved",
        severity: "success",
        recommendation: "accept",
        ownerCheckApplies: true,
        ownerMatchesDriver: true,
        ownerStatus: "matches_driver",
        nameSimilarity,
        accentInsensitiveNameMatch: true,
        issues: [],
        warnings: [],
        summary: `${next.label || fieldName}: documento válido y a nombre del driver.`,
      };
    }

    return {
      ...next,
      ok: true,
      status: "warning",
      severity: "warning",
      recommendation: "manual_review",
      ownerCheckApplies: true,
      ownerMatchesDriver: false,
      ownerStatus: next.nameFound ? "different_owner" : "owner_not_detected",
      nameSimilarity,
      issues: [],
      warnings: [
        next.nameFound
          ? `Documento válido, pero está a nombre de otra persona. Detectado: ${next.nameFound}`
          : "Documento válido, pero no se pudo confirmar titular/propietario."
      ],
      summary: `${next.label || fieldName}: documento válido con observación no bloqueante.`,
    };
  }

  return next;
}

function summarize(results) {
  const total = results.length;
  const warnings = results.filter((x) => x.status === "warning" || x.severity === "warning").length;
  const approved = results.filter((x) => x.ok === true && x.status !== "skipped" && x.status !== "warning" && x.severity !== "warning").length;
  const skipped = results.filter((x) => x.status === "skipped").length;
  const rejected = results.filter((x) => x.ok === false && x.status === "rejected").length;
  const missing = results.filter((x) => x.status === "missing").length;
  const blockingWarnings = results.filter((x) => isBlockingWarningResult(x)).length;
  const pendingFix = rejected + missing + blockingWarnings;

  return {
    total,
    approved,
    warnings,
    skipped,
    rejected,
    missing,
    blockingWarnings,
    pendingFix,
    canContinue: pendingFix === 0,
  };
}


function processSingleDocumentUpload(req, res, next) {
  const ct = req.headers["content-type"];
  if (typeof ct === "string" && ct.includes("multipart/form-data") && !hasBoundary(req)) {
    return res.status(400).json({ ok: false, error: "multipart/form-data inválido" });
  }

  upload.single("document")(req, res, (err) => {
    if (err) {
      console.error("[/api/registration/compress-and-validate-document] Multer error:", err);
      return res.status(400).json({ ok: false, error: `Error leyendo archivo: ${err.message}` });
    }

    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, error: "Falta archivo para comprimir." });
    }

    const detected = detectMagic(req.file.buffer);
    const declared = String(req.file.mimetype || "");
    const allowed = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

    if (!allowed.has(detected)) {
      return res.status(400).json({ ok: false, error: "El archivo no parece ser PDF/imagen válida." });
    }

    if (detected !== declared && !(declared === "image/jpeg" && detected === "image/jpeg")) {
      return res.status(400).json({ ok: false, error: "El archivo no coincide con su tipo declarado." });
    }

    next();
  });
}

router.post("/api/registration/compress-and-validate-document", processSingleDocumentUpload, async (req, res) => {
  const jobId = String(req.body.jobId || "").trim();
  const fieldName = String(req.body.fieldName || "").trim();
  const expectedName = normalizeDriverNameForValidation(req.body.nombre || req.body.expectedName || "SIN_NOMBRE");

  if (!jobId) return res.status(400).json({ ok: false, error: "Falta jobId." });
  if (!FILE_FIELDS.includes(fieldName)) return res.status(400).json({ ok: false, error: "Documento no soportado." });

  const originalFile = req.file;
  const compressed = await compressFileForAi(originalFile);

  if (!compressed.ok) {
    const result = {
      ...buildHeavyFileSkippedResult(fieldName, {
        fileName: originalFile.originalname,
        size: originalFile.size || originalFile.buffer?.length || 0,
      }, req.body),
      compressionAttempted: true,
      compressionSufficient: false,
      originalSize: originalFile.size || originalFile.buffer?.length || 0,
      compressedSize: null,
      warnings: [
        `Se intentó comprimir el archivo con el compresor del sistema, pero no fue posible: ${compressed.reason}. Sube otro archivo con menor peso.`,
      ],
      summary: "Se intentó reducir el tamaño del archivo, pero no fue posible. Sube otro archivo con menor peso para validarlo con IA.",
    };

    const finalReview = mergeReviewResultIntoPayload({ jobId, body: req.body, fieldName, result });

    return res.json({
      ok: true,
      compressed: false,
      canValidate: false,
      result,
      summary: finalReview.summary,
      results: finalReview.results,
      message: "No se pudo comprimir el archivo para validarlo con IA.",
    });
  }

  if ((compressed.file.size || compressed.file.buffer?.length || 0) > AI_VALIDATION_MAX_FILE_BYTES) {
    const result = {
      ...buildHeavyFileSkippedResult(fieldName, {
        fileName: compressed.file.originalname || originalFile.originalname,
        size: compressed.file.size || compressed.file.buffer?.length || 0,
      }, req.body),
      compressed: true,
      compressionAttempted: true,
      compressionSufficient: false,
      originalSize: compressed.originalSize,
      compressedSize: compressed.compressedSize,
      warnings: [
        `Se intentó reducir el archivo de ${formatMb(compressed.originalSize)} a ${formatMb(compressed.compressedSize)}, pero aún excede 5 MB. Sube otro archivo con menor peso.`,
      ],
      summary: "Se intentó reducir su tamaño, pero no fue suficiente para validarlo con IA. Sube otro archivo con menor peso.",
    };

    const finalReview = mergeReviewResultIntoPayload({ jobId, body: req.body, fieldName, result });

    return res.json({
      ok: true,
      compressed: true,
      canValidate: false,
      result,
      summary: finalReview.summary,
      results: finalReview.results,
      message: "Se intentó comprimir el archivo, pero aún excede 5 MB. Sube otro archivo con menor peso.",
    });
  }

  try {
    const validation = await validateDocument({
      jobId,
      fieldName,
      file: compressed.file,
      expectedName: expectedName || "SIN_NOMBRE",
    });

    const operationalResult = applyOperationalRules(validation, fieldName, expectedName || "SIN_NOMBRE");

    const status = operationalResult.severity === "warning" || operationalResult.status === "warning"
      ? "warning"
      : operationalResult.ok
        ? "approved"
        : "rejected";

    const result = {
      ...operationalResult,
      status,
      fileName: compressed.file.originalname,
      originalFileName: originalFile.originalname,
      compressed: true,
      compressionAttempted: true,
      compressionSufficient: true,
      originalSize: compressed.originalSize,
      compressedSize: compressed.compressedSize,
      validatedAt: new Date().toISOString(),
    };

    const finalReview = mergeReviewResultIntoPayload({ jobId, body: req.body, fieldName, result });

    return res.json({
      ok: true,
      compressed: true,
      canValidate: true,
      result,
      summary: finalReview.summary,
      results: finalReview.results,
      message: "Archivo comprimido y validado correctamente.",
    });
  } catch (err) {
    const result = {
      ...buildErrorResult(fieldName, err),
      fileName: compressed.file.originalname || originalFile.originalname,
      compressed: true,
      compressionAttempted: true,
      compressionSufficient: true,
      originalSize: compressed.originalSize,
      compressedSize: compressed.compressedSize,
      validatedAt: new Date().toISOString(),
    };

    const finalReview = mergeReviewResultIntoPayload({ jobId, body: req.body, fieldName, result });

    return res.json({
      ok: true,
      compressed: true,
      canValidate: false,
      result,
      summary: finalReview.summary,
      results: finalReview.results,
      message: "El archivo se comprimió, pero no pudo validarse con IA.",
    });
  }
});

router.post("/api/registration/final-review", processUploadMiddleware, async (req, res) => {
  const jobId = String(req.body.jobId || "").trim();
  if (!jobId) return res.status(400).json({ ok: false, error: "Falta jobId." });

  const body = req.body || {};
  const nombreOriginal = toUpperClean(body.nombre);
  const nombreValidacion = normalizeDriverNameForValidation(nombreOriginal);
  const nombre = nombreValidacion || nombreOriginal;
  const telefono = digitsOnly(body.telefono).slice(0, 10);
  const curpTxt = toUpperClean(body.curp_txt || body.curpText || body.curp_persona || "");

  const partialReview = isPartialReview(body);
  const partialFields = parsePartialFields(body.partialFields);
  const finalizeFromPartials = isFinalizeFromPartials(body);
  const heavySkippedFiles = parseHeavySkippedFiles(body.aiSkippedHeavyFiles);

  setJob(jobId, {
    ok: true,
    state: finalizeFromPartials ? "ai_review_finalizing_from_partials" : partialReview ? "ai_partial_review" : "ai_final_review",
    message: finalizeFromPartials
      ? "Preparando resumen final con validaciones previas…"
      : partialReview
        ? "Validando esta sección con IA…"
        : "Validando todos los documentos con IA. Esto puede tardar unos segundos…",
    data: {
      ...(getJob(jobId)?.data || {}),
      nombre,
      nombreOriginal,
      nombreValidacion,
      telefono,
      curpTxt,
    },
  });

  if (finalizeFromPartials) {
    const storedValidation = {
      ...(getJob(jobId)?.data?.documentValidation || {}),
      ...Object.fromEntries(Array.from(heavySkippedFiles.entries()).map(([fieldName, info]) => [
        fieldName,
        buildHeavyFileSkippedResult(fieldName, info, body),
      ])),
    };
    const results = buildFinalResultsFromStoredValidation(body, storedValidation);
    const summary = summarize(results);
    const detectedCurp = getCurpFromReview({ results });

    if (detectedCurp) {
      if (!useGoogleArchiveAsRegistry()) {
        const localDuplicate = await findCompletedRegistration(detectedCurp);
        if (localDuplicate) {
          return res.status(409).json({
            ok: false,
            duplicateRegistered: true,
            code: "DUPLICATE_CURP",
            error: `La CURP ${detectedCurp} ya tiene un registro final. No se puede registrar de nuevo.`,
            duplicate: localDuplicate,
          });
        }
      }

      if (useGoogleArchiveAsRegistry()) {
        const googleDuplicate = await findFinalRegistrationByCurp(detectedCurp);
        if (googleDuplicate) {
          return res.status(409).json({
            ok: false,
            duplicateRegistered: true,
            code: "DUPLICATE_CURP",
            error: `La CURP ${detectedCurp} ya tiene un registro final. No se puede registrar de nuevo.`,
            duplicate: googleDuplicate,
          });
        }
      }
    }

    setJob(jobId, {
      ok: summary.canContinue,
      state: "ai_review_completed",
      message: summary.canContinue
        ? (summary.warnings ? "Documentos válidos con observaciones no bloqueantes." : "Todos los documentos fueron aprobados por IA.")
        : "La IA detectó documentos faltantes o con errores bloqueantes.",
      data: {
        ...(getJob(jobId)?.data || {}),
        nombre,
        nombreOriginal,
        nombreValidacion,
        telefono,
        curpTxt,
        finalReview: {
          summary,
          results,
          reviewedAt: new Date().toISOString(),
          source: "partial_reviews",
        },
        documentValidation: results.reduce((acc, row) => {
          acc[row.fieldName] = row;
          return acc;
        }, {}),
      },
      validationErrors: results.filter((x) => x.ok === false),
      validationWarnings: results.filter((x) => x.status === "warning" || x.severity === "warning"),
      finalReviewSummary: summary,
      saved: false,
    });

    return res.json({
      ok: true,
      jobId,
      state: "ai_review_completed",
      summary,
      results,
      canContinue: summary.canContinue,
      finalizedFromPartials: true,
      message: summary.canContinue
        ? (summary.warnings ? "Hay documentos válidos con observaciones no bloqueantes." : "Todos los documentos fueron aprobados.")
        : "Hay documentos por corregir o cargar.",
    });
  }

  const limiter = poolLimit(2);

  const fieldsToValidate = partialReview ? FILE_FIELDS.filter((fieldName) => partialFields.has(fieldName)) : FILE_FIELDS;

  const rawResults = await Promise.all(
    fieldsToValidate.map((fieldName) =>
      limiter(async () => {
        const required = isFileRequired(fieldName, body);
        const file = await getFile(req, fieldName);
        const heavyInfo = heavySkippedFiles.get(fieldName);

        if (heavyInfo && !file) {
          return buildHeavyFileSkippedResult(fieldName, heavyInfo, body);
        }

        if (!required && !file) {
          return buildSkippedResult(
            fieldName,
            fieldName === "estado_cuenta"
              ? "CLABE capturada manualmente; no se validó estado de cuenta."
              : fieldName === "tarjeta"
                ? "Tarjeta de circulación no cargada. Documento opcional; no bloquea el registro."
                : fieldName === "poliza"
                  ? "Póliza de seguro no cargada. Documento opcional; no bloquea el registro."
                  : "NSS capturado manualmente; no se validó documento NSS."
          );
        }

        if (!file) return buildMissingResult(fieldName);

        try {
          const result = await validateDocument({
            jobId,
            fieldName,
            file,
            expectedName: nombreValidacion || nombre || "SIN_NOMBRE",
          });

          const operationalResult = applyOperationalRules(result, fieldName, nombreValidacion || nombre || "SIN_NOMBRE");

          const status = operationalResult.severity === "warning" || operationalResult.status === "warning"
            ? "warning"
            : operationalResult.ok
              ? "approved"
              : "rejected";

          return {
            ...operationalResult,
            status,
            fileName: file.originalname,
            validatedAt: new Date().toISOString(),
          };
        } catch (err) {
          return {
            ...buildErrorResult(fieldName, err),
            fileName: file?.originalname || null,
            validatedAt: new Date().toISOString(),
          };
        }
      })
    )
  );

  const results = filterResultsForSummary(rawResults, body);
  const summary = summarize(results);
  const detectedCurp = getCurpFromReview({ results });

  if (detectedCurp) {
    if (!useGoogleArchiveAsRegistry()) {
      const localDuplicate = await findCompletedRegistration(detectedCurp);
      if (localDuplicate) {
        return res.status(409).json({
          ok: false,
          duplicateRegistered: true,
          code: "DUPLICATE_CURP",
          error: `La CURP ${detectedCurp} ya tiene un registro final. No se puede registrar de nuevo.`,
          duplicate: localDuplicate,
        });
      }
    }

    if (useGoogleArchiveAsRegistry()) {
      const googleDuplicate = await findFinalRegistrationByCurp(detectedCurp);
      if (googleDuplicate) {
        return res.status(409).json({
          ok: false,
          duplicateRegistered: true,
          code: "DUPLICATE_CURP",
          error: `La CURP ${detectedCurp} ya tiene un registro final. No se puede registrar de nuevo.`,
          duplicate: googleDuplicate,
        });
      }
    }
  }

  const previousValidation = getJob(jobId)?.data?.documentValidation || {};
  const mergedValidation = {
    ...previousValidation,
    ...results.reduce((acc, row) => {
      acc[row.fieldName] = row;
      return acc;
    }, {}),
  };

  const jobDataUpdate = {
    ...(getJob(jobId)?.data || {}),
    nombre,
    nombreOriginal,
    nombreValidacion,
    telefono,
    curpTxt,
    documentValidation: mergedValidation,
  };

  if (!partialReview) {
    jobDataUpdate.finalReview = {
      summary,
      results,
      reviewedAt: new Date().toISOString(),
      source: "full_review",
    };
  }

  setJob(jobId, {
    ok: summary.canContinue,
    state: partialReview ? "ai_partial_review_completed" : "ai_review_completed",
    message: summary.canContinue
      ? (summary.warnings ? "Documentos válidos con observaciones no bloqueantes." : "Documentos aprobados por IA.")
      : "La IA detectó documentos faltantes o con errores bloqueantes.",
    data: jobDataUpdate,
    validationErrors: results.filter((x) => x.ok === false),
    validationWarnings: results.filter((x) => x.status === "warning" || x.severity === "warning"),
    finalReviewSummary: partialReview ? null : summary,
    saved: false,
  });

  return res.json({
    ok: true,
    jobId,
    state: "ai_review_completed",
    summary,
    results,
    canContinue: summary.canContinue,
    partialReview,
    partialFields: Array.from(partialFields),
    message: summary.canContinue
      ? (summary.warnings ? "Hay documentos válidos con observaciones no bloqueantes." : "Todos los documentos fueron aprobados.")
      : "Hay documentos por corregir o cargar.",
  });
});

module.exports = { finalDocumentReviewRouter: router };
