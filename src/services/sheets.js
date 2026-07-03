// src/services/sheets.js
const { ENV } = require("../config/env");

const EXPECTED_HEADERS = [
  "Nombre Completo",
  "Telefono",
  "Foto personal",
  "Direccion completa",
  "Banco emisor",
  "CLABE Interbancaria",
  "Estado de cuenta.",
  "INE Frontal",
  "INE Reverso",
  "CURP",
  "Acta de naciomiento",
  "Documento NSS",
  "NSS",
  "CSF",
  "Licencia de conducir",
  "Tarjeta de circulacion",
  "Poliza de seguro",
  "Nombre Refereancia 1",
  "Numero Referencia 1",
  "Nombre Refereancia 2",
  "Numero Referencia 2"
];

// Nueva columna (AO)
const STATUS_COL = "Estatus credencial";

function colA1(n) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function trimHeader(s) {
  return String(s || "").trim();
}

function mxNowStamp() {
  // Formato similar a tu sheet: YYYY-MM-DD HH:mm:ss (zona CDMX)
  try {
    const fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    // sv-SE devuelve: 2026-01-19 08:10:22
    return fmt.format(new Date()).replace(",", "");
  } catch (_) {
    // fallback
    return new Date().toISOString().slice(0, 19).replace("T", " ");
  }
}

async function ensureSheetExists(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(title,sheetId)",
  });

  const exists = (meta.data.sheets || []).some(
    (s) => String(s?.properties?.title || "") === sheetName
  );

  if (exists) return { ok: true, created: false };

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    },
  });

  return { ok: true, created: true };
}

async function getHeaderRow(sheets) {
  const spreadsheetId = ENV.SPREADSHEET_ID;
  const sheetName = ENV.SHEET_NAME || "Documentos";

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!1:1`,
    majorDimension: "ROWS",
  });

  const headers = (res.data.values?.[0] || []).map(trimHeader);
  return { spreadsheetId, sheetName, headers };
}

/**
 * Asegura:
 * - sheet existe
 * - headers A..AN son exactamente los esperados (40)
 * - agrega "Estatus credencial" al final si falta (AO)
 *
 * NO reordena ni pisa datos.
 */
async function ensureSheetAndHeaders(sheets) {
  const spreadsheetId = ENV.SPREADSHEET_ID;
  const sheetName = ENV.SHEET_NAME || "Documentos";

  await ensureSheetExists(sheets, spreadsheetId, sheetName);

  const { headers } = await getHeaderRow(sheets);

  // Si no hay headers, inicializa con los 40 + estatus
  if (!headers || headers.length === 0 || headers.every((h) => !h)) {
    const full = EXPECTED_HEADERS.concat([STATUS_COL]);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1:${colA1(full.length)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [full] },
    });
    return { ok: true, initialized: true, addedStatus: true };
  }

  // Validar A..AN contra expected (comparación por trim)
  const base = headers.slice(0, EXPECTED_HEADERS.length).map(trimHeader);
  const expected = EXPECTED_HEADERS.map(trimHeader);

  const mismatch = [];
  for (let i = 0; i < expected.length; i++) {
    if ((base[i] || "") !== expected[i]) {
      mismatch.push({ index: i + 1, got: base[i] || "", expected: expected[i] });
    }
  }

  if (mismatch.length > 0) {
    const sample = mismatch.slice(0, 6).map((m) => `#${m.index} got="${m.got}" expected="${m.expected}"`).join(" | ");
    throw new Error(
      `Headers del Sheet no coinciden con el layout esperado A..AN. Revisa la fila 1. Ejemplos: ${sample}`
    );
  }

  // Agregar Status si falta (AO)
  const hasStatus = headers.map(trimHeader).includes(STATUS_COL);
  if (!hasStatus) {
    const newHeaders = headers.concat([STATUS_COL]);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1:${colA1(newHeaders.length)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [newHeaders] },
    });
    return { ok: true, initialized: false, addedStatus: true };
  }

  return { ok: true, initialized: false, addedStatus: false };
}

/**
 * Construye valores A..AO (40 + estatus).
 * Todo lo que no se tenga se deja vacío para que lo llene Gemini/Odoo/manual.
 */
function buildRowValues(input) {
  const {
    nombre = "",
    telefono = "",
    selfieLink = "",
    direccion = "",
    banco = "",
    clabeLink = "", 
    clabeTxt = "",  
    ineFrontalLink = "",
    ineReversoLink = "",
    curpLink = "",
    actaLink = "",
    nssLink = "",
    nssNum = "",
    constanciaLink = "",
    licenciaLink = "",
    tarjetaLink = "",
    polizaLink = "",
    ref1Nombre = "",
    ref1Tel = "",
    ref2Nombre = "",
    ref2Tel = "",
    estatusCredencial = "PENDIENTE",
  } = input || {};

  const clabeVal = clabeLink ? clabeLink : (clabeTxt ? `'${String(clabeTxt).replace(/^\'+/, "")}` : "");
  const nssTxtVal = nssNum ? `'${String(nssNum).replace(/^\'+/, "")}` : "";

  const row = new Array(EXPECTED_HEADERS.length).fill("");

  row[0] = nombre;                   // A Nombre Completo
  row[1] = telefono;                 // B Telefono
  row[2] = selfieLink;               // C Foto personal
  row[3] = direccion;                // D Direccion completa
  row[4] = banco;                    // E Banco emisor
  row[5] = clabeVal;                 // F CLABE Interbancaria (Link if file, otherwise text)
  row[6] = "";                       // G Estado de cuenta.
  row[7] = ineFrontalLink;           // H INE Frontal
  row[8] = ineReversoLink;           // I INE Reverso
  row[9] = curpLink;                 // J CURP
  row[10] = actaLink;                // K Acta de naciomiento
  row[11] = nssLink;                 // L Documento NSS
  row[12] = nssTxtVal;               // M NSS
  row[13] = constanciaLink;          // N CSF
  row[14] = licenciaLink;            // O Licencia de conducir
  row[15] = tarjetaLink;             // P Tarjeta de circulacion
  row[16] = polizaLink;              // Q Poliza de seguro
  row[17] = ref1Nombre;              // R Nombre Refereancia 1
  row[18] = ref1Tel;                 // S Numero Referencia 1
  row[19] = ref2Nombre;              // T Nombre Refereancia 2
  row[20] = ref2Tel;                 // U Numero Referencia 2

  // V Estatus credencial
  // W Fecha de registro
  return row.concat([estatusCredencial, mxNowStamp()]);
}

/**
 * Escribe la fila en la siguiente fila libre desde A..AO.
 * (Mantiene el nombre "writeRowAtoAN" para compatibilidad, aunque ahora incluye AO)
 */
async function writeRowAtoAN(sheets, values) {
  const spreadsheetId = ENV.SPREADSHEET_ID;
  const sheetName = ENV.SHEET_NAME || "Documentos";

  // A..W (23) 
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:W`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });

  const updatedRange = res.data.updates?.updatedRange || "";
  const m = updatedRange.match(/!(?:[A-Z]+)(\d+):/);
  const rowNumber = m?.[1] ? Number(m[1]) : null;

  return { row: rowNumber, range: updatedRange };
}

// === Helpers de cron (solo tocan "Estatus credencial") ===

async function readAllRows(sheets) {
  const { spreadsheetId, sheetName, headers } = await getHeaderRow(sheets);

  const lastCol = colA1(headers.length);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:${lastCol}`,
    majorDimension: "ROWS",
  });

  const values = res.data.values || [];
  if (values.length <= 1) return [];

  const out = [];
  for (let r = 1; r < values.length; r++) {
    const rowVals = values[r] || [];
    const obj = { __rowNumber: r + 1 };
    for (let c = 0; c < headers.length; c++) {
      obj[trimHeader(headers[c])] = rowVals[c] == null ? "" : String(rowVals[c]);
    }
    out.push(obj);
  }
  return out;
}

async function updateCredStatusCell(sheets, rowNumber, value) {
  const { spreadsheetId, sheetName, headers } = await getHeaderRow(sheets);

  const idx = headers.map(trimHeader).indexOf(STATUS_COL);
  if (idx < 0) throw new Error(`No existe columna "${STATUS_COL}" en el Sheet.`);

  const col = colA1(idx + 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!${col}${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[String(value || "")]] },
  });
}

module.exports = {
  EXPECTED_HEADERS,
  STATUS_COL,

  ensureSheetAndHeaders,
  buildRowValues,
  writeRowAtoAN,

  readAllRows,
  updateCredStatusCell,
};
