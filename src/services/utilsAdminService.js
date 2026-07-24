// src/services/utilsAdminService.js
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const mime = require("mime-types");

const { ENV, assertGoogleArchiveConfig } = require("../config/env");
const { getClients } = require("../lib/google");
const { validateDocument } = require("./documentValidation");
const { createCredentialPdf } = require("./localExcelArchive");
const { generateCredentialPdfFromRow } = require("./credential");
const { normalizeClabe, isValidClabe, resolveBankName } = require("../utils/clabe");

const DOCUMENTS = {
  selfie: { header: "Foto personal", label: "Foto personal / selfie" },
  estado_cuenta: { header: "Estado de cuenta", label: "Estado de cuenta / comprobante bancario" },
  ine_frontal: { header: "INE frontal", label: "INE frontal" },
  ine_reverso: { header: "INE reverso", label: "INE reverso" },
  curp: { header: "CURP archivo", label: "CURP" },
  nss_file: { header: "Documento NSS", label: "Documento NSS" },
  constancia: { header: "Constancia fiscal", label: "Constancia de situación fiscal" },
  acta: { header: "Acta nacimiento", label: "Acta de nacimiento" },
  comprobante: { header: "Comprobante domicilio", label: "Comprobante de domicilio" },
  licencia: { header: "Licencia", label: "Licencia de conducir" },
  tarjeta: { header: "Tarjeta circulación", label: "Tarjeta / permiso de circulación" },
  poliza: { header: "Póliza seguro", label: "Póliza de seguro" },
};

const EDITABLE_FIELDS = {
  tipoVacante: "Tipo de vacante",
  nombre: "Nombre completo",
  telefono: "Teléfono",
  direccion: "Dirección",
  banco: "Banco",
  clabe: "CLABE",
  nss: "NSS",
  rfc: "RFC",
  curp: "CURP",
};

function sheetTitle() {
  return String(ENV.SHEET_NAME || "Registros").trim() || "Registros";
}

function quotedSheetName(name) {
  return `'${String(name || "Registros").replace(/'/g, "''")}'`;
}

function colA1(n) {
  let s = "";
  let value = Number(n);
  while (value > 0) {
    const m = (value - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    value = Math.floor((value - 1) / 26);
  }
  return s || "A";
}

function cleanCell(value) {
  return String(value ?? "").replace(/^'+/, "").trim();
}

function safeText(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function safeName(value, fallback = "driver") {
  const clean = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return clean || fallback;
}

function extractDriveFileId(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const m = s.match(pattern);
    if (m?.[1]) return m[1];
  }
  return /^[a-zA-Z0-9_-]{15,}$/.test(s) ? s : "";
}

function driveFolderUrl(id) {
  return `https://drive.google.com/drive/folders/${id}`;
}

function driveFileUrl(id) {
  return `https://drive.google.com/file/d/${id}/view`;
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function parseReview(value) {
  if (!value) return { summary: {}, results: [] };
  try {
    const parsed = typeof value === "object" ? value : JSON.parse(String(value));
    return {
      ...parsed,
      summary: parsed?.summary || {},
      results: Array.isArray(parsed?.results) ? parsed.results : [],
    };
  } catch (_) {
    return { summary: {}, results: [] };
  }
}

function rowToObject(headers, row, rowNumber) {
  const obj = { __rowNumber: rowNumber };
  for (let i = 0; i < headers.length; i++) {
    obj[headers[i]] = row?.[i] == null ? "" : String(row[i]);
  }
  return obj;
}

async function readSheetSnapshot() {
  assertGoogleArchiveConfig();
  const { sheets } = await getClients();
  const spreadsheetId = ENV.SPREADSHEET_ID;
  const title = sheetTitle();
  const quoted = quotedSheetName(title);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoted}!A1:ZZ`,
    majorDimension: "ROWS",
  });

  const values = response.data.values || [];
  const headers = (values[0] || []).map((v) => String(v || "").trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    if (!row.some((cell) => String(cell || "").trim())) continue;
    rows.push(rowToObject(headers, row, i + 1));
  }

  return { sheets, spreadsheetId, title, quoted, headers, rows };
}

function ensureHeader(snapshot, header) {
  const index = snapshot.headers.findIndex((h) => normalizeHeader(h) === normalizeHeader(header));
  if (index < 0) throw new Error(`No existe la columna "${header}" en el Sheet.`);
  return { index, col: colA1(index + 1), actual: snapshot.headers[index] };
}

async function updateHeaders(snapshot, rowNumber, changes) {
  const data = [];
  for (const [header, value] of Object.entries(changes || {})) {
    const found = ensureHeader(snapshot, header);
    data.push({
      range: `${snapshot.quoted}!${found.col}${rowNumber}`,
      values: [[value == null ? "" : String(value)]],
    });
  }
  if (!data.length) return { updated: 0 };

  await snapshot.sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: snapshot.spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data,
    },
  });
  return { updated: data.length };
}

function getRow(snapshot, rowNumber) {
  const n = Number(rowNumber);
  if (!Number.isInteger(n) || n < 2) throw new Error("Fila inválida.");
  const row = snapshot.rows.find((item) => item.__rowNumber === n);
  if (!row) throw new Error(`No se encontró la fila ${n}.`);
  return row;
}

function documentStatusFromReview(review, fieldName, row) {
  const result = (review.results || []).find((item) => item?.fieldName === fieldName);
  if (result) {
    let status = String(result.status || "").toLowerCase();
    if (!status) {
      status = result.severity === "warning" ? "warning" : result.ok === true ? "approved" : "rejected";
    }
    return { status, result };
  }

  const label = DOCUMENTS[fieldName]?.label || fieldName;
  const rejected = String(row["Documentos rechazados"] || "").toLowerCase();
  const observed = String(row["Documentos con observación"] || "").toLowerCase();
  const token = label.toLowerCase().split("/")[0].trim();

  if (rejected.includes(token)) return { status: "rejected", result: null };
  if (observed.includes(token)) return { status: "warning", result: null };
  return { status: row[DOCUMENTS[fieldName]?.header] ? "uploaded" : "missing", result: null };
}

function buildDocuments(row) {
  const review = parseReview(row["Resumen revisión IA JSON"]);
  return Object.entries(DOCUMENTS).map(([fieldName, meta]) => {
    const { status, result } = documentStatusFromReview(review, fieldName, row);
    return {
      fieldName,
      label: meta.label,
      header: meta.header,
      link: String(row[meta.header] || ""),
      status,
      fileName: result?.fileName || "",
      summary: result?.summary || "",
      issues: Array.isArray(result?.issues) ? result.issues : [],
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
      confidence: result?.confidence ?? null,
      validatedAt: result?.validatedAt || "",
    };
  });
}

function buildDriverSummary(row) {
  return {
    rowNumber: row.__rowNumber,
    fechaRegistro: row["Fecha registro"] || "",
    jobId: row["Job ID"] || "",
    credentialId: row["ID credencial"] || "",
    tipoVacante: row["Tipo de vacante"] || "",
    nombre: row["Nombre completo"] || "",
    telefono: cleanCell(row["Teléfono"] || ""),
    curp: cleanCell(row["CURP"] || ""),
    rfc: cleanCell(row["RFC"] || ""),
    nss: cleanCell(row["NSS"] || ""),
    banco: row["Banco"] || "",
    clabe: cleanCell(row["CLABE"] || ""),
    estado: row["Estado revisión IA"] || "",
    rechazados: row["Documentos rechazados"] || "",
    observaciones: row["Documentos con observación"] || "",
    faltantes: Number(row["Docs faltantes"] || 0) || 0,
    carpetaDrive: row["Carpeta Drive"] || "",
    credencialPdf: row["Credencial PDF"] || "",
  };
}

function buildDriverDetail(row) {
  const review = parseReview(row["Resumen revisión IA JSON"]);
  return {
    ...buildDriverSummary(row),
    direccion: row["Dirección"] || "",
    aprobados: Number(row["Docs aprobados"] || 0) || 0,
    omitidos: Number(row["Docs omitidos"] || 0) || 0,
    detalleRechazados: row["Detalle documentos rechazados"] || "",
    detalleObservaciones: row["Detalle documentos con observación"] || "",
    review,
    documents: buildDocuments(row),
  };
}

async function listDrivers({ search = "", status = "", offset = 0, limit = 100 } = {}) {
  const snapshot = await readSheetSnapshot();
  const q = String(search || "").trim().toLowerCase();
  const statusNorm = String(status || "").trim().toLowerCase();

  let items = snapshot.rows.map(buildDriverSummary);
  if (q) {
    items = items.filter((item) => [
      item.nombre, item.curp, item.rfc, item.telefono, item.credentialId, item.jobId, item.banco
    ].some((value) => String(value || "").toLowerCase().includes(q)));
  }
  if (statusNorm) {
    items = items.filter((item) => String(item.estado || "").toLowerCase() === statusNorm);
  }

  items.sort((a, b) => b.rowNumber - a.rowNumber);
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
  return {
    total: items.length,
    offset: safeOffset,
    limit: safeLimit,
    items: items.slice(safeOffset, safeOffset + safeLimit),
  };
}

async function getDriverDetail(rowNumber) {
  const snapshot = await readSheetSnapshot();
  return buildDriverDetail(getRow(snapshot, rowNumber));
}

function addAdminAudit(review, entry) {
  const audit = Array.isArray(review.adminAudit) ? review.adminAudit.slice(-49) : [];
  audit.push({
    at: new Date().toISOString(),
    ...entry,
  });
  review.adminAudit = audit;
  return review;
}

function validateMetadataPatch(input) {
  const out = {};
  for (const key of Object.keys(EDITABLE_FIELDS)) {
    if (!(key in (input || {}))) continue;
    out[key] = safeText(input[key], key === "direccion" ? 1000 : 200);
  }

  if ("tipoVacante" in out) {
    const raw = out.tipoVacante.toLowerCase();
    if (raw.includes("ayudante")) out.tipoVacante = "Ayudante";
    else if (raw.includes("chofer")) out.tipoVacante = "Chofer";
    else if (raw.includes("driver")) out.tipoVacante = "Driver";
    else if (out.tipoVacante) throw new Error("Tipo de vacante inválido. Usa Driver, Chofer o Ayudante.");
  }

  if ("curp" in out && out.curp) {
    out.curp = out.curp.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 18);
    if (out.curp.length !== 18) throw new Error("La CURP debe contener 18 caracteres.");
  }

  if ("rfc" in out && out.rfc) {
    out.rfc = out.rfc.toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(out.rfc)) {
      throw new Error("RFC inválido.");
    }
  }

  if ("nss" in out && out.nss) {
    out.nss = out.nss.replace(/\D/g, "");
    if (out.nss.length !== 11) throw new Error("El NSS debe contener 11 dígitos.");
  }

  if ("clabe" in out && out.clabe) {
    out.clabe = normalizeClabe(out.clabe);
    if (!isValidClabe(out.clabe)) throw new Error("La CLABE no es válida.");
  }

  return out;
}

async function updateDriverMetadata(rowNumber, input, actor) {
  const snapshot = await readSheetSnapshot();
  const row = getRow(snapshot, rowNumber);
  const patch = validateMetadataPatch(input);
  const changes = {};

  for (const [key, header] of Object.entries(EDITABLE_FIELDS)) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (["clabe", "nss"].includes(key) && value) value = `'${value}`;
    changes[header] = value;
  }

  if (patch.clabe) {
    const resolution = resolveBankName({
      clabe: patch.clabe,
      candidates: [patch.banco, row["Banco"]],
    });
    if (resolution.name) changes["Banco"] = resolution.name;
  }

  const review = addAdminAudit(parseReview(row["Resumen revisión IA JSON"]), {
    actor: actor?.username || "utils",
    action: "metadata_update",
    fields: Object.keys(changes),
  });
  changes["Resumen revisión IA JSON"] = JSON.stringify(review);

  await updateHeaders(snapshot, Number(rowNumber), changes);
  return getDriverDetail(rowNumber);
}

function summarizeResults(results = []) {
  const normalized = Array.isArray(results) ? results : [];
  const warnings = normalized.filter((x) => x?.status === "warning" || x?.severity === "warning").length;
  const approved = normalized.filter(
    (x) => x?.ok === true && x?.status !== "skipped" && x?.status !== "warning" && x?.severity !== "warning"
  ).length;
  const skipped = normalized.filter((x) => x?.status === "skipped").length;
  const rejected = normalized.filter((x) => x?.ok === false && x?.status === "rejected").length;
  const missing = normalized.filter((x) => x?.status === "missing").length;
  const blockingWarnings = normalized.filter((x) => x?.blocking === true || x?.skippedByWeight === true).length;
  const pendingFix = rejected + missing + blockingWarnings;
  return {
    total: normalized.length,
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

function resultLabel(row = {}) {
  return row.label || DOCUMENTS[row.fieldName]?.label || row.fieldName || "Documento";
}

function resultReason(row = {}) {
  const values = [
    row.summary,
    ...(Array.isArray(row.issues) ? row.issues : []),
    ...(Array.isArray(row.warnings) ? row.warnings : []),
  ].filter(Boolean).map((v) => String(v).replace(/\s+/g, " ").trim());
  return [...new Set(values)].slice(0, 2).join(" | ");
}

function docsByStatus(results, kind) {
  return [...new Set((results || []).filter((row) => {
    if (kind === "rejected") return row?.ok === false || row?.status === "rejected" || row?.status === "missing" || row?.severity === "error";
    return row?.status === "warning" || row?.severity === "warning";
  }).map(resultLabel))].join(", ");
}

function detailsByStatus(results, kind) {
  return (results || []).filter((row) => {
    if (kind === "rejected") return row?.ok === false || row?.status === "rejected" || row?.status === "missing" || row?.severity === "error";
    return row?.status === "warning" || row?.severity === "warning";
  }).map((row) => {
    const reason = resultReason(row);
    return reason ? `${resultLabel(row)}: ${reason}` : resultLabel(row);
  }).join("\n");
}

function validationStatus(result) {
  if (result?.severity === "warning" || result?.status === "warning") return "warning";
  return result?.ok === true ? "approved" : "rejected";
}

async function ensureDriverFolder(snapshot, row) {
  const existingId = extractDriveFileId(row["Carpeta Drive"]);
  const { drive } = await getClients();

  if (existingId) {
    try {
      const meta = await drive.files.get({
        fileId: existingId,
        fields: "id,name,mimeType,webViewLink,trashed",
        supportsAllDrives: true,
      });
      if (meta.data?.mimeType === "application/vnd.google-apps.folder" && !meta.data?.trashed) {
        return {
          drive,
          folderId: existingId,
          folderLink: meta.data.webViewLink || driveFolderUrl(existingId),
        };
      }
    } catch (_) {}
  }

  const parentId = ENV.GOOGLE_DRIVE_PARENT_FOLDER_ID || ENV.DRIVE_PARENT_FOLDER_ID;
  if (!parentId) throw new Error("El driver no tiene Carpeta Drive y no está configurada la carpeta padre.");

  const folderName = `${safeName(row["Nombre completo"])}_${safeName(cleanCell(row["CURP"]) || `FILA_${row.__rowNumber}`)}`;
  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      parents: [parentId],
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id,name,webViewLink",
    supportsAllDrives: true,
  });

  const folderId = created.data.id;
  const folderLink = created.data.webViewLink || driveFolderUrl(folderId);
  await updateHeaders(snapshot, row.__rowNumber, { "Carpeta Drive": folderLink });
  row["Carpeta Drive"] = folderLink;

  return { drive, folderId, folderLink };
}

async function uploadBufferToDrive(drive, folderId, file, label) {
  const ext = mime.extension(file.mimetype) || path.extname(file.originalname || "").replace(".", "") || "bin";
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const name = `${safeName(label, "Documento")}_${stamp}.${ext}`;
  const created = await drive.files.create({
    requestBody: {
      name,
      parents: [folderId],
      mimeType: file.mimetype,
    },
    media: {
      mimeType: file.mimetype,
      body: Readable.from(file.buffer),
    },
    fields: "id,name,webViewLink,mimeType",
    supportsAllDrives: true,
  });

  return {
    id: created.data.id,
    name: created.data.name || name,
    webViewLink: created.data.webViewLink || driveFileUrl(created.data.id),
    mimeType: created.data.mimeType || file.mimetype,
  };
}

async function trashDriveFile(drive, link) {
  const fileId = extractDriveFileId(link);
  if (!fileId) return;
  try {
    await drive.files.update({
      fileId,
      requestBody: { trashed: true },
      fields: "id,trashed",
      supportsAllDrives: true,
    });
  } catch (err) {
    console.warn("[utils] No se pudo enviar a papelera el archivo anterior:", err?.message || err);
  }
}

function detectedField(result, keys = []) {
  const fields = result?.fields || {};
  for (const key of keys) {
    const value = fields[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

async function replaceDriverDocument(rowNumber, fieldName, file, actor) {
  const meta = DOCUMENTS[fieldName];
  if (!meta) throw new Error("Tipo documental no permitido.");
  if (!file?.buffer?.length) throw new Error("No se recibió archivo.");
  if (file.size > 5 * 1024 * 1024) {
    throw new Error("Para revalidación automática desde /utils el archivo debe pesar máximo 5 MB.");
  }

  const snapshot = await readSheetSnapshot();
  const row = getRow(snapshot, rowNumber);
  const expectedName = safeText(row["Nombre completo"] || "SIN_NOMBRE", 200);

  const validation = await validateDocument({
    jobId: `utils-${rowNumber}-${Date.now()}`,
    fieldName,
    file,
    expectedName,
  });

  const review = parseReview(row["Resumen revisión IA JSON"]);
  const hadReviewContext = Array.isArray(review.results) && review.results.length > 0;
  const normalizedValidation = {
    ...validation,
    fieldName,
    label: meta.label,
    status: validationStatus(validation),
    fileName: file.originalname,
    validatedAt: new Date().toISOString(),
    source: "utils_admin",
  };

  const results = [...(review.results || [])];
  const index = results.findIndex((item) => item?.fieldName === fieldName);
  if (index >= 0) results[index] = normalizedValidation;
  else results.push(normalizedValidation);

  review.results = results;
  review.summary = summarizeResults(results);
  review.reviewedAt = new Date().toISOString();
  review.source = "utils_admin_document_replace";
  addAdminAudit(review, {
    actor: actor?.username || "utils",
    action: "document_replace",
    fieldName,
    fileName: file.originalname,
    result: normalizedValidation.status,
  });

  const folder = await ensureDriverFolder(snapshot, row);
  const uploaded = await uploadBufferToDrive(folder.drive, folder.folderId, file, meta.label);
  const previousLink = row[meta.header] || "";

  const credentialExists = Boolean(String(row["Credencial PDF"] || "").trim());
  const summary = review.summary;
  const state = hadReviewContext
    ? summary.canContinue
      ? credentialExists
        ? (summary.warnings ? "APROBADO_CON_OBSERVACIONES" : "APROBADO")
        : "PENDIENTE_CREDENCIAL"
      : "CON_ERRORES"
    : (String(row["Estado revisión IA"] || "").trim() || "REQUIERE_REVISION_MANUAL");

  const changes = {
    [meta.header]: uploaded.webViewLink,
    "Estado revisión IA": state,
    "Docs aprobados": summary.approved || 0,
    "Documentos rechazados": docsByStatus(results, "rejected"),
    "Documentos con observación": docsByStatus(results, "warning"),
    "Docs faltantes": summary.missing || 0,
    "Docs omitidos": summary.skipped || 0,
    "Detalle documentos rechazados": detailsByStatus(results, "rejected"),
    "Detalle documentos con observación": detailsByStatus(results, "warning"),
    "Resumen revisión IA JSON": JSON.stringify(review),
  };

  if (fieldName === "estado_cuenta") {
    const rawClabe = detectedField(validation, ["clabe", "clabe_interbancaria", "clabeInterbancaria", "cuenta_clabe"]);
    const clabe = normalizeClabe(rawClabe);
    if (isValidClabe(clabe)) {
      const visualBank = detectedField(validation, ["banco", "bank", "institucion", "institucion_bancaria", "entidad_financiera"]);
      const resolution = resolveBankName({ clabe, candidates: [visualBank] });
      changes["CLABE"] = `'${clabe}`;
      if (resolution.name || visualBank) changes["Banco"] = resolution.name || visualBank;
    }
  }

  if (fieldName === "nss_file") {
    const nss = detectedField(validation, ["nss", "numero_nss", "numeroNss", "numero_seguro_social"]).replace(/\D/g, "");
    if (nss.length === 11) changes["NSS"] = `'${nss}`;
  }

  if (fieldName === "constancia") {
    const rfc = detectedField(validation, ["rfc", "RFC"]).toUpperCase().replace(/\s+/g, "");
    if (/^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) changes["RFC"] = rfc;
  }

  if (fieldName === "curp") {
    const curp = detectedField(validation, ["curp", "CURP"]).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (curp.length === 18) changes["CURP"] = curp;
  }

  try {
    await updateHeaders(snapshot, Number(rowNumber), changes);
  } catch (err) {
    await trashDriveFile(folder.drive, uploaded.webViewLink);
    throw err;
  }

  if (previousLink && previousLink !== uploaded.webViewLink) {
    await trashDriveFile(folder.drive, previousLink);
  }

  return {
    document: {
      fieldName,
      link: uploaded.webViewLink,
      validation: normalizedValidation,
    },
    driver: await getDriverDetail(rowNumber),
  };
}

async function downloadDriveFile(drive, link, targetPath) {
  const fileId = extractDriveFileId(link);
  if (!fileId) throw new Error("No se pudo obtener el ID del archivo en Drive.");
  const meta = await drive.files.get({
    fileId,
    fields: "id,name,mimeType",
    supportsAllDrives: true,
  });
  const data = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fsp.writeFile(targetPath, Buffer.from(data.data));
  return {
    id: fileId,
    name: meta.data?.name || path.basename(targetPath),
    mimeType: meta.data?.mimeType || "application/octet-stream",
  };
}

async function createDriverCredential(rowNumber, actor) {
  const snapshot = await readSheetSnapshot();
  const row = getRow(snapshot, rowNumber);
  const folder = await ensureDriverFolder(snapshot, row);
  const { drive, slides } = await getClients();

  const nombre = safeText(row["Nombre completo"], 200);
  const nss = cleanCell(row["NSS"]).replace(/\D/g, "");
  const rfc = cleanCell(row["RFC"]).toUpperCase();
  const curp = cleanCell(row["CURP"]).toUpperCase();
  const selfieLink = String(row["Foto personal"] || "").trim();
  const puesto = safeText(row["Tipo de vacante"] || ENV.PUESTO_DEFAULT || "OPERADOR", 80);
  const errors = [];

  if (!nombre) errors.push("Nombre completo");
  if (nss.length !== 11) errors.push("NSS de 11 dígitos");
  if (!/^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) errors.push("RFC válido");
  if (curp.length !== 18) errors.push("CURP válida");
  if (!extractDriveFileId(selfieLink)) errors.push("Foto personal en Drive");
  if (errors.length) throw new Error(`No se puede generar la credencial. Faltan: ${errors.join(", ")}.`);

  let credentialLink = "";
  let credentialId = cleanCell(row["ID credencial"]);
  if (!credentialId) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    credentialId = `SEZA-${date}-R${rowNumber}`;
  }

  let generatedMode = "slides";
  let slideError = null;
  const canUseSlides = Boolean(ENV.TEMPLATE_PRESENTATION_ID && ENV.OUTPUT_FOLDER_ID && ENV.CRED_TMP_FOLDER_ID);

  if (canUseSlides) {
    try {
      const generated = await generateCredentialPdfFromRow({
        row: { nombre, puesto, rfc, curp, nss, selfieLink },
        drive,
        slides,
      });
      if (generated?.ok && generated.pdfLink) {
        credentialLink = generated.pdfLink;
      } else {
        slideError = new Error(generated?.reason || (generated?.errors || []).join(", ") || "No se generó credencial con Slides.");
      }
    } catch (err) {
      slideError = err;
    }
  }

  let localPdf = null;
  if (!credentialLink) {
    generatedMode = "local_pdf";
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `seza-utils-${rowNumber}-`));
    try {
      const selfiePath = path.join(tmpDir, "selfie.bin");
      const selfieMeta = await downloadDriveFile(drive, selfieLink, selfiePath);
      const review = parseReview(row["Resumen revisión IA JSON"]);

      localPdf = await createCredentialPdf({
        jobId: `utils-${rowNumber}`,
        credentialId,
        bodyData: {
          nombre,
          tipoVacante: puesto,
          nssNum: nss,
          rfc,
          curpTxt: curp,
        },
        filePaths: {
          selfie: {
            absolutePath: selfiePath,
            originalName: selfieMeta.name,
            mimeType: selfieMeta.mimeType,
          },
        },
        reviewSummary: review.summary || {},
      });

      const buffer = await fsp.readFile(localPdf.absolutePath);
      const uploaded = await uploadBufferToDrive(
        drive,
        folder.folderId,
        {
          buffer,
          size: buffer.length,
          mimetype: "application/pdf",
          originalname: "Credencial SEZA.pdf",
        },
        "Credencial SEZA"
      );
      credentialLink = uploaded.webViewLink;
      if (localPdf?.absolutePath) {
        await fsp.rm(localPdf.absolutePath, { force: true }).catch(() => {});
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (!credentialLink) {
    throw slideError || new Error("No se pudo generar la credencial.");
  }

  const previousCredential = String(row["Credencial PDF"] || "");
  const review = addAdminAudit(parseReview(row["Resumen revisión IA JSON"]), {
    actor: actor?.username || "utils",
    action: "credential_generate",
    mode: generatedMode,
    credentialId,
  });
  const summary = review.summary || {};
  const currentState = String(row["Estado revisión IA"] || "").trim();
  const finalState = summary.canContinue === true
    ? (Number(summary.warnings || 0) > 0 ? "APROBADO_CON_OBSERVACIONES" : "APROBADO")
    : summary.canContinue === false
      ? "CON_ERRORES"
      : currentState || "PENDIENTE_CREDENCIAL";

  await updateHeaders(snapshot, Number(rowNumber), {
    "ID credencial": credentialId,
    "Credencial PDF": credentialLink,
    "Estado revisión IA": finalState,
    "Resumen revisión IA JSON": JSON.stringify(review),
  });

  if (generatedMode === "local_pdf" && previousCredential && previousCredential !== credentialLink) {
    await trashDriveFile(drive, previousCredential);
  }

  return {
    ok: true,
    mode: generatedMode,
    credentialId,
    credentialLink,
    slideFallbackReason: slideError?.message || "",
    driver: await getDriverDetail(rowNumber),
  };
}

module.exports = {
  DOCUMENTS,
  EDITABLE_FIELDS,
  listDrivers,
  getDriverDetail,
  updateDriverMetadata,
  replaceDriverDocument,
  createDriverCredential,
};
