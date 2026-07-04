// src/services/googleArchive.js
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const { ENV, assertGoogleArchiveConfig } = require("../config/env");
const { getClients } = require("../lib/google");

const GOOGLE_FILE_FIELDS = [
  ["selfie", "Foto personal"],
  ["estado_cuenta", "Estado de cuenta"],
  ["ine_frontal", "INE frontal"],
  ["ine_reverso", "INE reverso"],
  ["curp", "CURP"],
  ["nss_file", "Documento NSS"],
  ["constancia", "Constancia fiscal"],
  ["acta", "Acta nacimiento"],
  ["comprobante", "Comprobante domicilio"],
  ["licencia", "Licencia"],
  ["tarjeta", "Tarjeta circulación"],
  ["poliza", "Póliza seguro"],
];

const SHEETS_HEADERS = [
  "Fecha registro",
  "Job ID",
  "ID credencial",
  "Nombre completo",
  "Teléfono",
  "Dirección",
  "Banco",
  "CLABE",
  "NSS",
  "RFC",
  "CURP",
  "Estado revisión IA",
  "Docs aprobados",
  "Docs rechazados",
  "Docs con observación",
  "Docs faltantes",
  "Docs omitidos",
  "Carpeta Drive",
  "Credencial PDF",
  "Foto personal",
  "Estado de cuenta",
  "INE frontal",
  "INE reverso",
  "CURP archivo",
  "Documento NSS",
  "Constancia fiscal",
  "Acta nacimiento",
  "Comprobante domicilio",
  "Licencia",
  "Tarjeta circulación",
  "Póliza seguro",
  "Resumen revisión IA JSON",
];

function isEnabled() {
  return ENV.GOOGLE_ARCHIVE_ENABLED === true || ENV.GOOGLE_ARCHIVE_ENABLED === "true";
}

function normalizeCurpForLookup(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 18);
}

function safeName(value, fallback = "SIN_NOMBRE") {
  const clean = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  return clean || fallback;
}

function nowMxIsoLike() {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date()).replace(",", "");
  } catch {
    return new Date().toISOString();
  }
}

function driveWebViewUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

function driveFolderUrl(folderId) {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

async function findOrCreateFolder(drive, { name, parentId }) {
  const escaped = name.replace(/'/g, "\\'");
  const q = [
    "mimeType = 'application/vnd.google-apps.folder'",
    `name = '${escaped}'`,
    `'${parentId}' in parents`,
    "trashed = false",
  ].join(" and ");

  const found = await drive.files.list({
    q,
    fields: "files(id,name,webViewLink)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (found.data.files?.[0]) {
    return found.data.files[0];
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id,name,webViewLink",
    supportsAllDrives: true,
  });

  return created.data;
}

async function uploadFileToDrive(drive, { parentId, localPath, name, mimeType }) {
  if (!localPath || !fs.existsSync(localPath)) return null;

  const detectedMime = mimeType || mime.lookup(localPath) || "application/octet-stream";

  const uploaded = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId],
    },
    media: {
      mimeType: detectedMime,
      body: fs.createReadStream(localPath),
    },
    fields: "id,name,mimeType,webViewLink,webContentLink",
    supportsAllDrives: true,
  });

  return {
    ...uploaded.data,
    webViewLink: uploaded.data.webViewLink || driveWebViewUrl(uploaded.data.id),
  };
}


function sheetTitle() {
  return String(ENV.SHEET_NAME || "Documentos").trim() || "Documentos";
}

function a1SheetName(name) {
  // Siempre entre comillas para evitar errores de parseo si el tab tiene espacios,
  // acentos o caracteres especiales. En A1 notation, las comillas simples internas
  // se duplican.
  return `'${String(name || "Documentos").replace(/'/g, "''")}'`;
}

async function ensureSheetTabExists(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });

  const existing = meta.data.sheets || [];
  const found = existing.find((s) => s?.properties?.title === sheetName);
  if (found) return found.properties;

  const created = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: sheetName,
            },
          },
        },
      ],
    },
  });

  return created.data.replies?.[0]?.addSheet?.properties || { title: sheetName };
}

async function ensureSheetHeader(sheets) {
  const spreadsheetId = ENV.SPREADSHEET_ID;
  const sheetName = sheetTitle();
  const quotedSheet = a1SheetName(sheetName);

  await ensureSheetTabExists(sheets, spreadsheetId, sheetName);

  const current = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quotedSheet}!A1:AF1`,
  }).catch((err) => {
    // Si el rango aún no está disponible por consistencia eventual,
    // continuamos y escribimos encabezados.
    if (err?.code === 400) return null;
    throw err;
  });

  const hasHeader = Array.isArray(current?.data?.values?.[0]) && current.data.values[0].length > 0;
  if (hasHeader) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quotedSheet}!A1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [SHEETS_HEADERS],
    },
  });
}


function buildSheetRow({ localResult, googleFiles, driverFolder, bodyData, reviewPayload, rowStatus }) {
  const summary = reviewPayload?.summary || {};
  const fileLink = (fieldName) => googleFiles[fieldName]?.webViewLink || "";
  const status = rowStatus || (summary.canContinue ? (summary.warnings ? "APROBADO_CON_OBSERVACIONES" : "APROBADO") : "CON_ERRORES");

  return [
    nowMxIsoLike(),
    localResult.jobId || "",
    localResult.credentialId || "",
    bodyData.nombre || "",
    bodyData.telefono || "",
    bodyData.direccion || "",
    bodyData.banco || "",
    bodyData.clabeTxt || "",
    bodyData.nssNum || "",
    bodyData.rfc || "",
    bodyData.curpTxt || localResult.curp || "",
    status,
    summary.approved || 0,
    summary.rejected || 0,
    summary.warnings || 0,
    summary.missing || 0,
    summary.skipped || 0,
    driverFolder.webViewLink || driveFolderUrl(driverFolder.id),
    googleFiles.credentialPdf?.webViewLink || "",
    fileLink("selfie"),
    fileLink("estado_cuenta"),
    fileLink("ine_frontal"),
    fileLink("ine_reverso"),
    fileLink("curp"),
    fileLink("nss_file"),
    fileLink("constancia"),
    fileLink("acta"),
    fileLink("comprobante"),
    fileLink("licencia"),
    fileLink("tarjeta"),
    fileLink("poliza"),
    JSON.stringify(reviewPayload || {}),
  ];
}

async function appendToSheet(sheets, row) {
  const spreadsheetId = ENV.SPREADSHEET_ID;
  const sheetName = sheetTitle();
  const quotedSheet = a1SheetName(sheetName);

  await ensureSheetHeader(sheets);

  const appended = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${quotedSheet}!A:AF`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [row],
    },
  });

  return appended.data;
}



async function findFinalRegistrationByCurp(curpRaw) {
  if (!isEnabled()) return null;

  const curp = normalizeCurpForLookup(curpRaw);
  if (!curp || curp.length < 18) return null;

  assertGoogleArchiveConfig();

  const { sheets } = await getClients();
  const spreadsheetId = ENV.SPREADSHEET_ID;
  const sheetName = sheetTitle();
  const quotedSheet = a1SheetName(sheetName);

  await ensureSheetHeader(sheets);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quotedSheet}!A:L`,
  }).catch((err) => {
    if (err?.code === 400 || err?.code === 404) return { data: { values: [] } };
    throw err;
  });

  const rows = response.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const rowCurp = normalizeCurpForLookup(row[10] || "");
    const status = String(row[11] || "").toUpperCase();

    if (rowCurp === curp && !["BORRADOR", "AVANCE_GUARDADO", "DRAFT"].includes(status)) {
      return {
        rowNumber: i + 1,
        curp,
        status,
        nombre: row[3] || "",
        credentialId: row[2] || "",
        folderLink: row[17] || "",
        credentialLink: row[18] || "",
      };
    }
  }

  return null;
}

async function assertNoDuplicateFinalRegistration(curpRaw) {
  const found = await findFinalRegistrationByCurp(curpRaw);
  if (found) {
    const err = new Error(`La CURP ${found.curp} ya tiene un registro final. No se puede registrar de nuevo.`);
    err.code = "DUPLICATE_CURP";
    err.duplicate = found;
    throw err;
  }
  return true;
}

async function archiveDraftToGoogle({ draftResult, bodyData, reviewPayload }) {
  if (!isEnabled()) {
    return {
      ok: false,
      skipped: true,
      reason: "GOOGLE_ARCHIVE_ENABLED=false",
    };
  }

  assertGoogleArchiveConfig();

  const parentId = ENV.GOOGLE_DRIVE_PARENT_FOLDER_ID || ENV.DRIVE_PARENT_FOLDER_ID;
  const { drive, sheets } = await getClients();

  const curp = normalizeCurpForLookup(draftResult.curp || bodyData.curpTxt || "");
  const folderName = `${safeName(bodyData.nombre)}_${safeName(curp || draftResult.jobId || "BORRADOR")}`;
  const driverFolder = await findOrCreateFolder(drive, {
    name: folderName,
    parentId,
  });

  const googleFiles = {};
  for (const [fieldName, label] of GOOGLE_FILE_FIELDS) {
    const info = draftResult.filePaths?.[fieldName];
    const localPath = info?.absolutePath || (info?.relativePath ? path.resolve(process.cwd(), info.relativePath) : "");
    if (!localPath || !fs.existsSync(localPath)) continue;

    const ext = path.extname(info.originalName || localPath) || path.extname(localPath);
    googleFiles[fieldName] = await uploadFileToDrive(drive, {
      parentId: driverFolder.id,
      localPath,
      name: `${label}${ext}`,
      mimeType: info.mimeType,
    });
  }

  const manifestPath = path.join(path.dirname(Object.values(draftResult.filePaths || {})[0]?.absolutePath || path.join(process.cwd(), "draft.json")), "draft_manifest.json");
  try {
    fs.writeFileSync(manifestPath, JSON.stringify({
      type: "BORRADOR_REGISTRO_SHIP",
      savedAt: draftResult.savedAt,
      curp,
      bodyData,
      reviewPayload,
      fileCount: Object.keys(draftResult.filePaths || {}).length,
    }, null, 2), "utf8");

    googleFiles.draftManifest = await uploadFileToDrive(drive, {
      parentId: driverFolder.id,
      localPath: manifestPath,
      name: "draft_manifest.json",
      mimeType: "application/json",
    });
  } catch (err) {
    console.warn("[googleArchive] No se pudo guardar manifest de borrador:", err?.message || err);
  }

  const row = buildSheetRow({
    localResult: {
      jobId: draftResult.jobId,
      credentialId: "",
      curp,
    },
    googleFiles,
    driverFolder,
    bodyData: {
      ...bodyData,
      curpTxt: bodyData.curpTxt || curp,
    },
    reviewPayload,
    rowStatus: "BORRADOR",
  });

  const sheetAppend = await appendToSheet(sheets, row);

  return {
    ok: true,
    draft: true,
    curp,
    driverFolder: {
      id: driverFolder.id,
      name: driverFolder.name,
      webViewLink: driverFolder.webViewLink || driveFolderUrl(driverFolder.id),
    },
    googleFiles,
    sheetName: sheetTitle(),
    sheetAppend,
  };
}

async function archiveRegistrationToGoogle({ localResult, bodyData, reviewPayload }) {
  if (!isEnabled()) {
    return {
      ok: false,
      skipped: true,
      reason: "GOOGLE_ARCHIVE_ENABLED=false",
    };
  }

  assertGoogleArchiveConfig();

  const parentId = ENV.GOOGLE_DRIVE_PARENT_FOLDER_ID || ENV.DRIVE_PARENT_FOLDER_ID;
  if (!parentId || parentId.startsWith("disabled-")) {
    throw new Error("Falta GOOGLE_DRIVE_PARENT_FOLDER_ID o DRIVE_PARENT_FOLDER_ID.");
  }

  if (!ENV.SPREADSHEET_ID || ENV.SPREADSHEET_ID.startsWith("disabled-")) {
    throw new Error("Falta SPREADSHEET_ID para registrar en Google Sheets.");
  }

  const { drive, sheets } = await getClients();

  const folderName = `${safeName(bodyData.nombre)}_${safeName(bodyData.curpTxt || localResult.credentialId)}`;
  const driverFolder = await findOrCreateFolder(drive, {
    name: folderName,
    parentId,
  });

  const googleFiles = {};

  for (const [fieldName, label] of GOOGLE_FILE_FIELDS) {
    const info = localResult.filePaths?.[fieldName];
    if (!info?.absolutePath) continue;

    const ext = path.extname(info.originalName || info.absolutePath) || path.extname(info.absolutePath);
    googleFiles[fieldName] = await uploadFileToDrive(drive, {
      parentId: driverFolder.id,
      localPath: info.absolutePath,
      name: `${label}${ext}`,
      mimeType: info.mimeType,
    });
  }

  if (localResult.credentialPdf?.absolutePath) {
    googleFiles.credentialPdf = await uploadFileToDrive(drive, {
      parentId: driverFolder.id,
      localPath: localResult.credentialPdf.absolutePath,
      name: `Credencial_${safeName(bodyData.nombre)}.pdf`,
      mimeType: "application/pdf",
    });
  }

  const row = buildSheetRow({
    localResult,
    googleFiles,
    driverFolder,
    bodyData,
    reviewPayload,
  });

  const sheetAppend = await appendToSheet(sheets, row);

  return {
    ok: true,
    driverFolder: {
      id: driverFolder.id,
      name: driverFolder.name,
      webViewLink: driverFolder.webViewLink || driveFolderUrl(driverFolder.id),
    },
    googleFiles,
    sheetName: sheetTitle(),
    sheetAppend,
  };
}

module.exports = {
  archiveRegistrationToGoogle,
  archiveDraftToGoogle,
  findFinalRegistrationByCurp,
  assertNoDuplicateFinalRegistration,
};
