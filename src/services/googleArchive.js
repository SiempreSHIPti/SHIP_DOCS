// src/services/googleArchive.js
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const sharp = require("sharp");
const { ENV, assertGoogleArchiveConfig } = require("../config/env");
const { getClients } = require("../lib/google");

const GOOGLE_FILE_FIELDS = [
  ["selfie", "Foto personal"],
  ["estado_cuenta", "Estado de cuenta"],
  ["ine_frontal", "INE frontal"],
  ["ine_reverso", "INE reverso"],
  ["curp", "CURP archivo"],
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
  "Tipo de vacante",
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


function reviewText(...values) {
  return values
    .flat(Infinity)
    .filter(Boolean)
    .map((v) => typeof v === "object" ? JSON.stringify(v) : String(v))
    .join(" ");
}

function normalizeVacancyType(value) {
  const raw = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

  if (raw.includes("ayudante")) return "Ayudante";
  if (raw.includes("chofer")) return "Chofer";
  if (raw.includes("driver")) return "Driver";
  return "";
}

function normalizeBankName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .slice(0, 80);
}

function extractClabeFromText(value) {
  const text = String(value || "");
  if (!text.trim()) return "";

  const contextual = text.match(/(?:CLABE|CLABE INTERBANCARIA|CUENTA CLABE|INTERBANCARIA)[^\d]*(\d[\d\s-]{16,34}\d)/i);
  if (contextual?.[1]) {
    const digits = contextual[1].replace(/\D/g, "");
    if (digits.length >= 18) return digits.slice(0, 18);
  }

  const contiguous = text.match(/\b\d{18}\b/);
  if (contiguous?.[0]) return contiguous[0];

  const compact = text.replace(/[^\d]/g, "");
  const mostlyDigits = text.replace(/[\d\s-]/g, "").trim().length <= 3;
  if (mostlyDigits && compact.length >= 18) return compact.slice(0, 18);

  return "";
}

function getEstadoCuentaRow(reviewPayload = {}) {
  const rows = reviewPayload?.results || [];
  return rows.find((row) => row?.fieldName === "estado_cuenta") || null;
}

function extractBankFromReview(reviewPayload = {}) {
  const row = getEstadoCuentaRow(reviewPayload);
  const fields = row?.fields || {};
  return normalizeBankName(
    fields.banco ||
    fields.bank ||
    fields.institucion ||
    fields.institucion_bancaria ||
    fields.entidad_financiera ||
    fields.emisor ||
    fields.banco_emisor ||
    ""
  );
}

function extractClabeFromReview(reviewPayload = {}) {
  const row = getEstadoCuentaRow(reviewPayload);
  const fields = row?.fields || {};
  const direct = [
    fields.clabe,
    fields.clabe_interbancaria,
    fields.clabeInterbancaria,
    fields.cuenta_clabe,
    fields.cuentaClabe,
    fields.clabe_o_cuenta,
    fields.cuenta,
    fields.numero_cuenta,
    fields.account,
  ];

  for (const candidate of direct) {
    const clabe = extractClabeFromText(candidate);
    if (clabe) return clabe;
  }

  return extractClabeFromText(reviewText(
    row?.summary,
    row?.nameFound,
    row?.documentTypeDetected,
    row?.fields,
    row?.issues,
    row?.warnings
  ));
}


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


function escapeDriveQueryValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function driveFileUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

function isImageMime(mimeType) {
  return /^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(String(mimeType || ""));
}

function extensionForUpload({ originalName, localPath, mimeType }) {
  if (isImageMime(mimeType)) return ".jpg";
  const ext = path.extname(originalName || localPath || "").toLowerCase();
  if (ext) return ext;
  const detected = mime.extension(mimeType || mime.lookup(localPath) || "");
  return detected ? `.${detected}` : ".bin";
}

function columnFileName(label, ext) {
  const cleanLabel = String(label || "Documento")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${cleanLabel}${ext || ""}`;
}

async function prepareFileForDrive({ localPath, originalName, mimeType, label }) {
  const detectedMime = mimeType || mime.lookup(localPath) || "application/octet-stream";
  const originalExt = extensionForUpload({ originalName, localPath, mimeType: detectedMime });
  const driveName = columnFileName(label, originalExt);

  if (!isImageMime(detectedMime)) {
    return {
      localPath,
      name: driveName,
      mimeType: detectedMime,
      temporary: false,
    };
  }

  const tmpDir = path.join("/tmp", "ship-drive-optimized");
  fs.mkdirSync(tmpDir, { recursive: true });

  const tmpPath = path.join(
    tmpDir,
    `${Date.now()}_${Math.random().toString(16).slice(2)}_${String(label || "documento").replace(/[^a-z0-9]+/gi, "_")}.jpg`
  );

  try {
    await sharp(localPath)
      .rotate()
      .resize({
        width: 1800,
        height: 1800,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 72,
        mozjpeg: true,
      })
      .toFile(tmpPath);

    const originalSize = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
    const optimizedSize = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;

    // Si por alguna razón la versión optimizada pesa más, usa el original.
    if (originalSize && optimizedSize && optimizedSize >= originalSize) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      return {
        localPath,
        name: driveName,
        mimeType: detectedMime,
        temporary: false,
      };
    }

    return {
      localPath: tmpPath,
      name: columnFileName(label, ".jpg"),
      mimeType: "image/jpeg",
      temporary: true,
      originalSize,
      optimizedSize,
    };
  } catch (err) {
    console.warn("[googleArchive] No se pudo comprimir imagen; se sube original:", err?.message || err);
    return {
      localPath,
      name: driveName,
      mimeType: detectedMime,
      temporary: false,
    };
  }
}

async function trashExistingFileByName(drive, { parentId, name }) {
  const escapedName = escapeDriveQueryValue(name);
  const q = [
    `'${parentId}' in parents`,
    `name = '${escapedName}'`,
    "trashed = false",
  ].join(" and ");

  const found = await drive.files.list({
    q,
    fields: "files(id,name)",
    pageSize: 20,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const files = found.data.files || [];
  for (const file of files) {
    try {
      await drive.files.update({
        fileId: file.id,
        requestBody: { trashed: true },
        supportsAllDrives: true,
      });
    } catch (err) {
      console.warn("[googleArchive] No se pudo reemplazar archivo previo:", file.name, err?.message || err);
    }
  }

  return files.length;
}

async function trashFileByNameIfExists(drive, { parentId, name }) {
  return trashExistingFileByName(drive, { parentId, name });
}

async function findOrCreateFolder(drive, { name, parentId }) {
  const escaped = escapeDriveQueryValue(name);
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

  await trashExistingFileByName(drive, { parentId, name });

  const uploaded = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId],
    },
    media: {
      mimeType: detectedMime,
      body: fs.createReadStream(localPath),
    },
    fields: "id,name,mimeType,size,webViewLink,webContentLink",
    supportsAllDrives: true,
  });

  return {
    ...uploaded.data,
    webViewLink: uploaded.data.webViewLink || driveWebViewUrl(uploaded.data.id),
  };
}

async function uploadPreparedFileToDrive(drive, { parentId, prepared }) {
  const uploaded = await uploadFileToDrive(drive, {
    parentId,
    localPath: prepared.localPath,
    name: prepared.name,
    mimeType: prepared.mimeType,
  });

  if (prepared.temporary) {
    try { fs.unlinkSync(prepared.localPath); } catch (_) {}
  }

  return {
    ...uploaded,
    optimized: prepared.temporary || false,
    originalSize: prepared.originalSize || null,
    optimizedSize: prepared.optimizedSize || null,
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

  const sheetProps = await ensureSheetTabExists(sheets, spreadsheetId, sheetName);

  const current = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quotedSheet}!A1:AG1`,
  }).catch((err) => {
    // Si el rango aún no está disponible por consistencia eventual,
    // continuamos y escribimos encabezados.
    if (err?.code === 400) return null;
    throw err;
  });

  const headerRow = current?.data?.values?.[0] || [];
  const hasHeader = Array.isArray(headerRow) && headerRow.length > 0;

  // Migración ligera: si el Sheet existe con el formato anterior,
  // insertamos "Tipo de vacante" antes de "Nombre completo" para no desalinear datos históricos.
  if (hasHeader && headerRow[3] !== "Tipo de vacante" && headerRow.includes("Nombre completo")) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          insertDimension: {
            range: {
              sheetId: sheetProps.sheetId,
              dimension: "COLUMNS",
              startIndex: 3,
              endIndex: 4,
            },
            inheritFromBefore: true,
          },
        }],
      },
    });
  }

  if (!hasHeader || headerRow[3] !== "Tipo de vacante") {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quotedSheet}!A1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [SHEETS_HEADERS],
      },
    });
  }
}


function buildSheetRow({ localResult, googleFiles, driverFolder, bodyData, reviewPayload, rowStatus }) {
  const summary = reviewPayload?.summary || {};
  const fileLink = (fieldName) => googleFiles[fieldName]?.webViewLink || "";
  const status = rowStatus || (summary.canContinue ? (summary.warnings ? "APROBADO_CON_OBSERVACIONES" : "APROBADO") : "CON_ERRORES");
  const bankFromReview = extractBankFromReview(reviewPayload);
  const clabeFromReview = extractClabeFromReview(reviewPayload);
  const banco = normalizeBankName(bodyData.banco || bankFromReview);
  const clabe = extractClabeFromText(bodyData.clabeTxt || bodyData.clabe || clabeFromReview);

  return [
    nowMxIsoLike(),
    localResult.jobId || "",
    localResult.credentialId || "",
    normalizeVacancyType(bodyData.tipoVacante || bodyData.tipo_vacante || bodyData.vacante),
    bodyData.nombre || "",
    bodyData.telefono || "",
    bodyData.direccion || "",
    banco,
    clabe,
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
    range: `${quotedSheet}!A:AG`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [row],
    },
  });

  return appended.data;
}




async function readSheetRows(sheets) {
  const spreadsheetId = ENV.SPREADSHEET_ID;
  const sheetName = sheetTitle();
  const quotedSheet = a1SheetName(sheetName);

  await ensureSheetHeader(sheets);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quotedSheet}!A:AG`,
  }).catch((err) => {
    if (err?.code === 400 || err?.code === 404) return { data: { values: [] } };
    throw err;
  });

  return response.data.values || [];
}

function rowStatus(row) {
  const currentFormatStatus = String(row?.[12] || "").trim().toUpperCase();
  if (["BORRADOR", "AVANCE_GUARDADO", "DRAFT", "APROBADO", "APROBADO_CON_OBSERVACIONES", "CON_ERRORES"].includes(currentFormatStatus)) {
    return currentFormatStatus;
  }
  return String(row?.[11] || "").trim().toUpperCase();
}

function rowCurp(row) {
  const currentFormatCurp = normalizeCurpForLookup(row?.[11] || "");
  if (currentFormatCurp && currentFormatCurp.length === 18) return currentFormatCurp;
  return normalizeCurpForLookup(row?.[10] || "");
}

function isDraftStatus(status) {
  return ["BORRADOR", "AVANCE_GUARDADO", "DRAFT"].includes(String(status || "").toUpperCase());
}

async function findRowsByCurp(sheets, curpRaw) {
  const curp = normalizeCurpForLookup(curpRaw);
  const rows = await readSheetRows(sheets);
  const matches = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (rowCurp(row) === curp) {
      matches.push({
        rowNumber: i + 1,
        row,
        status: rowStatus(row),
      });
    }
  }

  return matches;
}

async function updateSheetRow(sheets, rowNumber, row) {
  const spreadsheetId = ENV.SPREADSHEET_ID;
  const quotedSheet = a1SheetName(sheetTitle());

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quotedSheet}!A${rowNumber}:AG${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [row],
    },
  });

  return {
    updated: true,
    rowNumber,
  };
}

async function deleteSheetRows(sheets, rowNumbers) {
  const unique = [...new Set((rowNumbers || []).filter((n) => Number.isInteger(n) && n > 1))].sort((a, b) => b - a);
  if (!unique.length) return { deleted: 0 };

  const spreadsheetId = ENV.SPREADSHEET_ID;
  const sheetProps = await ensureSheetTabExists(sheets, spreadsheetId, sheetTitle());
  const sheetId = sheetProps.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: unique.map((rowNumber) => ({
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      })),
    },
  });

  return { deleted: unique.length };
}

async function upsertDraftSheetRow(sheets, { curp, row }) {
  const matches = await findRowsByCurp(sheets, curp);
  const draftRows = matches.filter((m) => isDraftStatus(m.status));

  if (draftRows.length) {
    const target = draftRows[0];
    await updateSheetRow(sheets, target.rowNumber, row);
    await deleteSheetRows(sheets, draftRows.slice(1).map((m) => m.rowNumber));
    return {
      mode: "updated_draft",
      rowNumber: target.rowNumber,
    };
  }

  const appended = await appendToSheet(sheets, row);
  return {
    mode: "appended_draft",
    append: appended,
  };
}

async function upsertFinalSheetRow(sheets, { curp, row }) {
  const matches = await findRowsByCurp(sheets, curp);
  const finalRows = matches.filter((m) => !isDraftStatus(m.status));
  const draftRows = matches.filter((m) => isDraftStatus(m.status));

  if (finalRows.length) {
    const err = new Error(`La CURP ${curp} ya tiene un registro final. No se puede registrar de nuevo.`);
    err.code = "DUPLICATE_CURP";
    err.duplicate = {
      rowNumber: finalRows[0].rowNumber,
      curp,
      status: finalRows[0].status,
      nombre: finalRows[0].row?.[3] || "",
      credentialId: finalRows[0].row?.[2] || "",
      folderLink: finalRows[0].row?.[17] || "",
      credentialLink: finalRows[0].row?.[18] || "",
    };
    throw err;
  }

  if (draftRows.length) {
    const target = draftRows[0];
    await updateSheetRow(sheets, target.rowNumber, row);
    await deleteSheetRows(sheets, draftRows.slice(1).map((m) => m.rowNumber));
    return {
      mode: "updated_from_draft",
      rowNumber: target.rowNumber,
    };
  }

  const appended = await appendToSheet(sheets, row);
  return {
    mode: "appended_final",
    append: appended,
  };
}

async function findFinalRegistrationByCurp(curpRaw) {
  if (!isEnabled()) return null;

  const curp = normalizeCurpForLookup(curpRaw);
  if (!curp || curp.length < 18) return null;

  assertGoogleArchiveConfig();

  const { sheets } = await getClients();
  const matches = await findRowsByCurp(sheets, curp);
  const finalRow = matches.find((m) => !isDraftStatus(m.status));

  if (!finalRow) return null;

  return {
    rowNumber: finalRow.rowNumber,
    curp,
    status: finalRow.status,
    nombre: finalRow.row?.[3] || "",
    credentialId: finalRow.row?.[2] || "",
    folderLink: finalRow.row?.[17] || "",
    credentialLink: finalRow.row?.[18] || "",
  };
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

    const prepared = await prepareFileForDrive({
      localPath,
      originalName: info.originalName,
      mimeType: info.mimeType,
      label,
    });

    googleFiles[fieldName] = await uploadPreparedFileToDrive(drive, {
      parentId: driverFolder.id,
      prepared,
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
      name: "Borrador registro.json",
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

  const sheetAppend = await upsertDraftSheetRow(sheets, { curp, row });

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

    const prepared = await prepareFileForDrive({
      localPath: info.absolutePath,
      originalName: info.originalName,
      mimeType: info.mimeType,
      label,
    });

    googleFiles[fieldName] = await uploadPreparedFileToDrive(drive, {
      parentId: driverFolder.id,
      prepared,
    });
  }

  await trashFileByNameIfExists(drive, {
    parentId: driverFolder.id,
    name: "Borrador registro.json",
  });

  if (localResult.credentialPdf?.absolutePath) {
    googleFiles.credentialPdf = await uploadFileToDrive(drive, {
      parentId: driverFolder.id,
      localPath: localResult.credentialPdf.absolutePath,
      name: "Credencial PDF.pdf",
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

  const curp = normalizeCurpForLookup(bodyData.curpTxt || localResult.curp || "");
  const sheetAppend = await upsertFinalSheetRow(sheets, { curp, row });

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
