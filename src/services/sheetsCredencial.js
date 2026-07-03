// src/services/sheetsCredencial.js
function normHeader(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function colToA1(n) {
  let s = "";
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

// src/services/sheetsCredencial.js

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

/**
 * Lee el sheet como objetos.
 * Si opts.tailRows > 0, SOLO lee la ventana de las últimas N filas:
 *   lastRow=200, tailRows=50 => startRow=150 (150..200)
 */
async function readSheetAsObjects(sheets, spreadsheetId, sheetName, opts = {}) {
  const tailRows = Number(opts.tailRows || 0);

  // 1) Headers
  const headRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!1:1`,
    majorDimension: "ROWS",
  });

  const headers = (headRes.data.values?.[0] || []).map(trimHeader);
  const lastCol = colA1(Math.max(1, headers.length));

  // Si no hay headers, regresamos vacío
  if (!headers.length || headers.every((h) => !h)) {
    return { headers, rows: [], window: null };
  }

  // 2) Determinar rango a leer
  let startRow = 2;
  let endRow = null;

  if (tailRows > 0) {
    // Tomamos longitud real por columna A (Nombre). Google regresa hasta el último valor no vacío.
    const colARes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:A`,
      majorDimension: "COLUMNS",
    });

    const colA = colARes.data.values?.[0] || [];
    const lastRow = colA.length; // incluye header en fila 1

    if (!lastRow || lastRow < 2) {
      return { headers, rows: [], window: { startRow: 2, endRow: 1, lastRow: lastRow || 1 } };
    }

    // 👇 tu regla: “si va en 200, tomar desde 150”
    startRow = Math.max(2, lastRow - tailRows);
    endRow = lastRow;
  }

  const range = endRow
    ? `${sheetName}!A${startRow}:${lastCol}${endRow}`
    : `${sheetName}!A1:${lastCol}`; // modo legacy: todo

  // 3) Leer valores
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    majorDimension: "ROWS",
  });

  const values = res.data.values || [];
  const rows = [];

  if (!endRow) {
    // legacy: incluye header en primera fila
    for (let i = 1; i < values.length; i++) {
      const rowVals = values[i] || [];
      const obj = { __rowNumber: i + 1 };
      for (let c = 0; c < headers.length; c++) {
        obj[trimHeader(headers[c])] = rowVals[c] == null ? "" : String(rowVals[c]);
      }
      rows.push(obj);
    }
    return { headers, rows, window: null };
  }

  // tail: NO incluye header, y el rowNumber real empieza en startRow
  for (let i = 0; i < values.length; i++) {
    const rowVals = values[i] || [];
    const obj = { __rowNumber: startRow + i };
    for (let c = 0; c < headers.length; c++) {
      obj[trimHeader(headers[c])] = rowVals[c] == null ? "" : String(rowVals[c]);
    }
    rows.push(obj);
  }

  return {
    headers,
    rows,
    window: { startRow, endRow, lastRow: endRow, tailRows },
  };
}

module.exports = {
  // ... deja tus exports existentes ...
  readSheetAsObjects,
};


async function updateCellByHeader(sheets, { spreadsheetId, sheetName, rowNumber, headerName, value }) {
  const headRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:ZZ1`,
  });

  const headers = (headRes.data.values?.[0] || []).map((h) => String(h || "").trim());
  const targetNorm = normHeader(headerName);

  let colIndex = -1;
  for (let i = 0; i < headers.length; i++) {
    if (normHeader(headers[i]) === targetNorm) {
      colIndex = i;
      break;
    }
  }
  if (colIndex === -1) throw new Error(`No se encontró el header: ${headerName}`);

  const colA1 = colToA1(colIndex + 1);
  const a1 = `${sheetName}!${colA1}${rowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: a1,
    valueInputOption: "RAW",
    requestBody: { values: [[String(value ?? "")]] },
  });

  return { ok: true, a1 };
}

function shouldProcessStatus(statusRaw) {
  const s = String(statusRaw || "").trim();
  if (!s) return false; // legacy vacío NO se procesa
  const head = s.split("|")[0].trim().toUpperCase();
  return ["PENDIENTE", "FALTAN_DATOS", "ERROR"].includes(head);
}

function pickCredentialInputFromRow(r, ENV) {
  const get = (...keys) => {
    for (const k of keys) {
      const v = r[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return "";
  };

  const digitsOnly = (s) => String(s || "").replace(/\D/g, "");

  return {
    nombre: get("Nombre"),
    puesto: ENV.PUESTO_DEFAULT || "OPERADOR",
    rfc: get("RFC"),
    curp: get("CURP INE"),
    nss: digitsOnly(get("Numero de Seguro Social", "Número de Seguro Social")),
    selfieLink: get("Foto", "FOTO"),
  };
}

module.exports = {
  readSheetAsObjects,
  updateCellByHeader,
  pickCredentialInputFromRow,
  shouldProcessStatus,
};
