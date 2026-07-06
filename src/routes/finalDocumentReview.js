// src/routes/finalDocumentReview.js
const express = require("express");
const { upload, validateUploadedFiles } = require("../middleware/upload");
const { setJob, getJob } = require("../services/jobStore");
const { validateDocument, DOC_RULES } = require("../services/documentValidation");
const { toUpperClean, digitsOnly } = require("../utils/strings");
const { getDraftFile, getCurpFromReview, findCompletedRegistration } = require("../services/localDraftStore");
const { ENV } = require("../config/env");
const { findFinalRegistrationByCurp } = require("../services/googleArchive");

const router = express.Router();

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

function isFileRequired(fieldName, body) {
  if (fieldName === "tarjeta" || fieldName === "poliza") {
    return false; // Tarjeta y póliza son opcionales: si se suben, se validan; si no, no bloquean.
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
  const pendingFix = rejected + missing;

  return {
    total,
    approved,
    warnings,
    skipped,
    rejected,
    missing,
    pendingFix,
    canContinue: pendingFix === 0,
  };
}

router.post("/api/registration/final-review", processUploadMiddleware, async (req, res) => {
  const jobId = String(req.body.jobId || "").trim();
  if (!jobId) return res.status(400).json({ ok: false, error: "Falta jobId." });

  const body = req.body || {};
  const nombreOriginal = toUpperClean(body.nombre);
  const nombreValidacion = normalizeDriverNameForValidation(nombreOriginal);
  const nombre = nombreValidacion || nombreOriginal;
  const telefono = digitsOnly(body.telefono).slice(0, 10);
  const curpTxt = toUpperClean(body.curp_txt || body.curpText || body.curp_persona || "");

  setJob(jobId, {
    ok: true,
    state: "ai_final_review",
    message: "Validando todos los documentos con IA. Esto puede tardar unos segundos…",
    data: {
      ...(getJob(jobId)?.data || {}),
      nombre,
      nombreOriginal,
      nombreValidacion,
      telefono,
      curpTxt,
    },
  });

  const limiter = poolLimit(2);

  const results = await Promise.all(
    FILE_FIELDS.map((fieldName) =>
      limiter(async () => {
        const required = isFileRequired(fieldName, body);
        const file = await getFile(req, fieldName);

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
    message: summary.canContinue
      ? (summary.warnings ? "Hay documentos válidos con observaciones no bloqueantes." : "Todos los documentos fueron aprobados.")
      : "Hay documentos por corregir o cargar.",
  });
});

module.exports = { finalDocumentReviewRouter: router };
