"use strict";

const RFC_RE = /^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/;
const CURP_RE = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/;
const NSS_RE = /^\d{11}$/;

function stripAccents(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeName(value) {
  return stripAccents(value)
    .toUpperCase()
    .replace(/[^A-ZÑ\s]/g, " ")
    .replace(/\b(DE|DEL|LA|LAS|LOS|Y|DA|DAS|DOS)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameSimilarity(expected, found) {
  const expectedTokens = normalizeName(expected).split(" ").filter((token) => token.length > 2);
  const foundTokens = new Set(normalizeName(found).split(" ").filter((token) => token.length > 2));
  if (!expectedTokens.length || !foundTokens.size) return 0;
  const matches = expectedTokens.filter((token) => foundTokens.has(token)).length;
  return matches / expectedTokens.length;
}

function findReviewRow(reviewPayload, fieldName) {
  return (reviewPayload?.results || []).find((row) => row?.fieldName === fieldName) || null;
}

function isApproved(row) {
  if (!row) return false;
  const status = String(row.status || "").toLowerCase();
  const severity = String(row.severity || "").toLowerCase();
  return row.ok === true && status !== "rejected" && status !== "missing" && severity !== "error";
}

function detectedNames(row = {}) {
  const fields = row.fields || {};
  return [
    row.nameFound,
    row.nombreEncontrado,
    fields.nombre,
    fields.nombre_completo,
    fields.nombreCompleto,
    fields.full_name,
    fields.fullName,
    fields.titular,
    fields.propietario,
    fields.nombre_del_titular,
    fields.nombreTitular,
  ].filter(Boolean);
}

function isNameValidated(row, expectedName) {
  if (!isApproved(row)) return false;
  if (row.nameMatches === true || row.accentInsensitiveNameMatch === true || row.ownerMatchesDriver === true) return true;
  if (Number(row.nameSimilarity || 0) >= 0.68) return true;
  return detectedNames(row).some((candidate) => nameSimilarity(expectedName, candidate) >= 0.68);
}

function selfieIsValid(row) {
  if (!isApproved(row)) return false;
  const verification = row.selfieVerification || row.fields || {};
  if (verification.isRealPerson === false) return false;
  if (verification.isDirectCameraCapture === false) return false;
  if (verification.isScreenRecapture === true) return false;
  if (verification.isPrintedPhoto === true) return false;
  if (verification.isPhotoOfPhoto === true) return false;
  if (verification.screenOrDeviceDetected === true) return false;
  if (Number.isFinite(Number(verification.faceCount)) && Number(verification.faceCount) !== 1) return false;
  return true;
}

function normalizeCredentialData(bodyData = {}) {
  return {
    nombre: normalizeName(bodyData.nombre),
    nss: String(bodyData.nssNum || bodyData.nss_num || bodyData.nss || "").replace(/\D/g, "").slice(0, 11),
    rfc: String(bodyData.rfc || bodyData.rfcTxt || bodyData.rfc_txt || "").toUpperCase().replace(/[^A-Z0-9&Ñ]/g, "").slice(0, 13),
    curp: String(bodyData.curpTxt || bodyData.curp_txt || bodyData.curp || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 18),
  };
}

function evaluateCredentialEligibility({ bodyData = {}, reviewPayload = {}, filePaths = {} } = {}) {
  const data = normalizeCredentialData(bodyData);
  const reasons = [];

  const ineRow = findReviewRow(reviewPayload, "ine_frontal");
  const curpRow = findReviewRow(reviewPayload, "curp");
  const selfieRow = findReviewRow(reviewPayload, "selfie");

  if (!data.nombre) reasons.push("Falta nombre completo.");
  if (!NSS_RE.test(data.nss)) reasons.push("Falta NSS válido de 11 dígitos.");
  if (!RFC_RE.test(data.rfc)) reasons.push("Falta RFC válido.");
  if (!CURP_RE.test(data.curp)) reasons.push("Falta CURP válida.");

  if (!isNameValidated(ineRow, data.nombre)) {
    reasons.push("El nombre no quedó validado correctamente contra el INE frontal.");
  }

  if (!isNameValidated(curpRow, data.nombre)) {
    reasons.push("El nombre no quedó validado correctamente contra la constancia CURP.");
  }

  if (!filePaths?.selfie?.absolutePath) {
    reasons.push("Falta la foto personal para colocarla en la credencial.");
  } else if (!selfieIsValid(selfieRow)) {
    reasons.push("La foto personal no pasó la validación de persona real y captura directa.");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    data,
    evidence: {
      ineValidated: isNameValidated(ineRow, data.nombre),
      curpValidated: isNameValidated(curpRow, data.nombre),
      selfieValidated: selfieIsValid(selfieRow),
    },
  };
}

module.exports = {
  evaluateCredentialEligibility,
  normalizeCredentialData,
};
