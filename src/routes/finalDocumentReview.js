// src/routes/finalDocumentReview.js
const express = require("express");
const { upload, validateUploadedFiles } = require("../middleware/upload");
const { setJob, getJob } = require("../services/jobStore");
const { validateDocument, DOC_RULES } = require("../services/documentValidation");
const { toUpperClean, digitsOnly } = require("../utils/strings");
const { getDraftFile, getCurpFromReview, findCompletedRegistration } = require("../services/localDraftStore");
const { ENV } = require("../config/env");
const { findFinalRegistrationByCurp } = require("../services/googleArchive");
const { friendlyPayload, friendlyValidationIssue } = require("../utils/friendlyErrors");

const router = express.Router();
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



function duplicateCurpPayload(curp, duplicate) {
  return friendlyPayload(
    Object.assign(new Error(`La CURP ${curp} ya tiene un registro final. No se puede registrar de nuevo.`), { code: "DUPLICATE_CURP" }),
    "Esta CURP ya tiene un registro final.",
    { duplicateRegistered: true, duplicate }
  );
}

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
    ok: false,
    status: "rejected",
    severity: "error",
    recommendation: "fix_required",
    fileName,
    issues: [
      `No se pudo validar porque el archivo excede el peso permitido de 5 MB${sizeText}. Sube otro archivo menor a 5 MB.`
    ],
    warnings: [],
    summary: "No se pudo validar porque excede el peso permitido. Sube otro archivo menor a 5 MB.",
    skippedByWeight: true,
    blocking,
    validatedAt: new Date().toISOString(),
  };
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
    return res.status(400).json(friendlyPayload(new Error("multipart/form-data inválido"), "No se recibieron los archivos."));
  }

  uploadFields(req, res, (err) => {
    if (err) {
      console.error("[/api/registration/final-review] Multer error:", err);
      return res.status(400).json(friendlyPayload(err, "No pudimos leer los archivos enviados."));
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

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function validationMapFromReviewPayload(reviewPayload, body = {}) {
  const rows = filterResultsForSummary(Array.isArray(reviewPayload?.results) ? reviewPayload.results : [], body);
  return rows.reduce((acc, row) => {
    if (row?.fieldName && FILE_FIELDS.includes(row.fieldName)) acc[row.fieldName] = row;
    return acc;
  }, {});
}

function clientSeedValidation(body = {}) {
  const payload = parseJsonObject(body.clientReviewPayload || body.existingReviewPayload || body.latestReviewPayload);
  return validationMapFromReviewPayload(payload, body);
}

function finalReviewFromValidationMap(body = {}, validationMap = {}, source = "partial_reviews_merged") {
  const results = buildFinalResultsFromStoredValidation(body, validationMap);
  const summary = summarize(results);
  return {
    summary,
    results,
    reviewedAt: new Date().toISOString(),
    source,
  };
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
  const label = FIELD_LABELS[fieldName] || fieldName;
  const message = friendlyValidationIssue("Documento faltante. Debes subir este archivo para completar el registro.", label);
  return {
    fieldName,
    label,
    ok: false,
    status: "missing",
    severity: "error",
    recommendation: "reject",
    issues: [message],
    summary: message,
    missing: true,
    userMessage: message,
  };
}

function buildErrorResult(fieldName, err) {
  const label = FIELD_LABELS[fieldName] || fieldName;
  const payload = friendlyPayload(err, `No se pudo validar ${label}.`);
  const message = payload.userMessage || payload.error;

  return {
    fieldName,
    label,
    ok: false,
    status: "rejected",
    severity: "error",
    recommendation: "reject",
    issues: [message],
    summary: message,
    userMessage: message,
    errorCode: payload.code,
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

function issueTextOf(row = {}) {
  return [
    row.summary,
    ...(Array.isArray(row.issues) ? row.issues : []),
    ...(Array.isArray(row.warnings) ? row.warnings : []),
  ]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function fieldValueText(row = {}, ...keys) {
  const fields = row.fields || {};
  for (const key of keys) {
    const value = fields[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function hasCriticalDocumentIssue(row = {}) {
  const text = issueTextOf(row);
  return (
    text.includes("no parece ser") ||
    text.includes("no corresponde") ||
    text.includes("otro documento") ||
    text.includes("documento incorrecto") ||
    text.includes("no es el documento esperado") ||
    text.includes("no es legible") ||
    text.includes("ilegible") ||
    text.includes("borroso") ||
    text.includes("no se pudo validar con gemini") ||
    text.includes("falta gemini_api_key") ||
    text.includes("error validando")
  );
}

function canSoftenManualReview(row = {}, fieldName) {
  if (!row || row.ok === true) return false;
  if (row.missing || row.skippedByWeight || row.blocking === true) return false;
  if (String(row.recommendation || "").toLowerCase() !== "manual_review") return false;
  if (row.isExpectedDocument === false || row.isLegible === false) return false;
  if (hasCriticalDocumentIssue(row)) return false;

  const confidence = Number(row.confidence || 0);
  if (Number.isFinite(confidence) && confidence > 0 && confidence < 0.55) return false;

  // INE frontal, CURP, NSS y estado de cuenta siguen siendo estrictos porque de ahí
  // salen datos críticos para identidad, CURP, NSS y CLABE.
  if (["ine_frontal", "curp", "nss_file", "estado_cuenta"].includes(fieldName)) return false;

  if (fieldName === "constancia") {
    const rfc = fieldValueText(row, "rfc", "RFC", "registro_federal_contribuyentes", "tax_id")
      .toUpperCase()
      .replace(/[^A-ZÑ&0-9]/g, "");
    return /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc);
  }

  // INE reverso y licencia pueden quedar en amarillo si la IA ve el documento real
  // pero no alcanza aprobación automática por un dato parcial como vigencia/MRZ/QR.
  if (["ine_reverso", "licencia", "tarjeta", "poliza", "comprobante", "selfie", "acta"].includes(fieldName)) {
    return true;
  }

  return false;
}

function softenManualReviewResult(row = {}, fieldName) {
  if (!canSoftenManualReview(row, fieldName)) return row;

  const issues = Array.isArray(row.issues) ? row.issues.filter(Boolean) : [];
  const warnings = Array.isArray(row.warnings) ? row.warnings.filter(Boolean) : [];

  return {
    ...row,
    ok: true,
    status: "warning",
    severity: "warning",
    recommendation: "manual_review",
    blocking: false,
    issues: [],
    warnings: [
      ...warnings,
      ...(issues.length ? issues : ["Documento válido, pero requiere revisión operativa."])
    ],
    summary: `${row.label || fieldName}: documento válido con observación no bloqueante.`,
    softenedManualReview: true,
  };
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


router.post("/api/registration/final-review", processUploadMiddleware, async (req, res) => {
  const jobId = String(req.body.jobId || "").trim();
  if (!jobId) return res.status(400).json(friendlyPayload(new Error("Falta jobId."), "No se pudo continuar con el formulario."));

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
  const seededValidation = clientSeedValidation(body);

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
      ...seededValidation,
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
          return res.status(409).json(duplicateCurpPayload(detectedCurp, localDuplicate));
        }
      }

      if (useGoogleArchiveAsRegistry()) {
        const googleDuplicate = await findFinalRegistrationByCurp(detectedCurp);
        if (googleDuplicate) {
          return res.status(409).json(duplicateCurpPayload(detectedCurp, googleDuplicate));
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
          const finalOperationalResult = softenManualReviewResult(operationalResult, fieldName);

          const status = finalOperationalResult.severity === "warning" || finalOperationalResult.status === "warning"
            ? "warning"
            : finalOperationalResult.ok
              ? "approved"
              : "rejected";

          return {
            ...finalOperationalResult,
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
        return res.status(409).json(duplicateCurpPayload(detectedCurp, localDuplicate));
      }
    }

    if (useGoogleArchiveAsRegistry()) {
      const googleDuplicate = await findFinalRegistrationByCurp(detectedCurp);
      if (googleDuplicate) {
        return res.status(409).json(duplicateCurpPayload(detectedCurp, googleDuplicate));
      }
    }
  }

  const previousValidation = {
    ...seededValidation,
    ...(getJob(jobId)?.data?.documentValidation || {}),
  };
  const mergedValidation = {
    ...previousValidation,
    ...results.reduce((acc, row) => {
      acc[row.fieldName] = row;
      return acc;
    }, {}),
  };

  const mergedFinalReview = partialReview
    ? finalReviewFromValidationMap(body, mergedValidation)
    : null;
  const effectiveSummary = partialReview ? mergedFinalReview.summary : summary;
  const effectiveResults = partialReview ? mergedFinalReview.results : results;

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
  } else {
    jobDataUpdate.finalReview = mergedFinalReview;
  }

  setJob(jobId, {
    ok: effectiveSummary.canContinue,
    state: partialReview ? "ai_partial_review_completed" : "ai_review_completed",
    message: effectiveSummary.canContinue
      ? (effectiveSummary.warnings ? "Documentos válidos con observaciones no bloqueantes." : "Documentos aprobados por IA.")
      : "La IA detectó documentos faltantes o con errores bloqueantes.",
    data: jobDataUpdate,
    validationErrors: effectiveResults.filter((x) => x.ok === false),
    validationWarnings: effectiveResults.filter((x) => x.status === "warning" || x.severity === "warning"),
    finalReviewSummary: effectiveSummary,
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
