// src/jobs/credentialCron.js
const { ENV } = require("../config/env");
const { getClients } = require("../lib/google");

const {
  readSheetAsObjects,
  updateCellByHeader,
  pickCredentialInputFromRow,
  shouldProcessStatus,
} = require("../services/sheetsCredencial");

const { generateCredentialPdfFromRow, cleanupTempOrphans } = require("../services/credential");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function safeErrMsg(e) {
  const msg = e?.response?.data?.error?.message || e?.message || String(e);
  return String(msg).slice(0, 220);
}

function isRetryable(e) {
  const status = e?.response?.status ?? e?.code;
  const reason = e?.response?.data?.error?.errors?.[0]?.reason ?? e?.errors?.[0]?.reason;

  return (
    [429, 500, 502, 503, 504].includes(status) ||
    ["backendError", "rateLimitExceeded", "userRateLimitExceeded"].includes(reason)
  );
}

async function withRetry(fn, step, { retries = 5, baseMs = 400 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.response?.status ?? e?.code;
      const reason = e?.response?.data?.error?.errors?.[0]?.reason ?? e?.errors?.[0]?.reason;
      const msg = e?.response?.data?.error?.message ?? e?.message ?? String(e);

      if (!isRetryable(e) || attempt >= retries) {
        const err = new Error(`Error en ${step}: ${msg}`);
        err.cause = e;
        err.meta = { status, reason };
        throw err;
      }

      const wait = Math.floor(baseMs * (2 ** attempt) + Math.random() * 250);
      await sleep(wait);
      attempt++;
    }
  }
}

function getRetentionMinutes() {
  const raw = String(ENV.CRED_TMP_RETENTION_MINUTES || "30").trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(24 * 60, Math.max(5, Math.floor(n)));
}

function getScanTailRows() {
  const raw = String(ENV.CRED_SCAN_TAIL_ROWS || "50").trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(500, Math.max(10, Math.floor(n))); // 10..500
}

async function runCredentialCronOnce({ limit = 10 } = {}) {
  if (!ENV.SPREADSHEET_ID || !ENV.SHEET_NAME) {
    throw new Error("Faltan ENV: SPREADSHEET_ID / SHEET_NAME");
  }

  if (!ENV.TEMPLATE_PRESENTATION_ID || !ENV.OUTPUT_FOLDER_ID) {
    return {
      skipped: true,
      reason: "Credencial deshabilitada (faltan TEMPLATE_PRESENTATION_ID/OUTPUT_FOLDER_ID)",
      processed: 0,
      generated: 0,
      missing: 0,
      errors: 0,
      scanWindow: null,
      items: [],
    };
  }

  if (!ENV.CRED_TMP_FOLDER_ID) {
    return {
      skipped: true,
      reason: "Falta ENV.CRED_TMP_FOLDER_ID (carpeta TEMP obligatoria)",
      processed: 0,
      generated: 0,
      missing: 0,
      errors: 0,
      scanWindow: null,
      items: [],
    };
  }

  const { sheets, drive, slides } = await withRetry(() => getClients(), "getClients");

  // 1) Limpieza TEMP
  const retention = getRetentionMinutes();
  let tempCleanup = { skipped: true };
  try {
    tempCleanup = await withRetry(
      () => cleanupTempOrphans(drive, ENV.CRED_TMP_FOLDER_ID, retention),
      "cleanupTempOrphans"
    );
  } catch (e) {
    tempCleanup = { ok: false, error: safeErrMsg(e) };
  }

  // 2) Leer SOLO últimas N filas del sheet
  const tailRows = getScanTailRows();
  const data = await withRetry(
    () => readSheetAsObjects(sheets, ENV.SPREADSHEET_ID, ENV.SHEET_NAME, { tailRows }),
    "readSheetAsObjects(tail)"
  );

  const scanWindow = data.window || null;

  // 3) Elegibles dentro de esa ventana
  const candidates = (data.rows || []).filter((row) => {
    const statusRaw = String(row["Estatus credencial"] || "").trim();
    return shouldProcessStatus(statusRaw);
  });

  // Procesar “más recientes primero”
  const batch = candidates.slice(-limit).reverse();

  const items = [];
  let processed = 0;
  let generated = 0;
  let missing = 0;
  let errors = 0;

  for (const row of batch) {
    processed++;

    // Lock EN_PROCESO
    await withRetry(
      () =>
        updateCellByHeader(sheets, {
          spreadsheetId: ENV.SPREADSHEET_ID,
          sheetName: ENV.SHEET_NAME,
          rowNumber: row.__rowNumber,
          headerName: "Estatus credencial",
          value: `EN_PROCESO|${nowIso()}`,
        }),
      "set EN_PROCESO"
    );

    const input = pickCredentialInputFromRow(row, ENV);

    try {
      const res = await withRetry(
        () => generateCredentialPdfFromRow({ row: input, drive, slides }),
        "generateCredentialPdfFromRow"
      );

      if (!res.ok) {
        const errs = (res.errors || []).join(", ");
        const tag =
          res.reason === "Validación falló"
            ? `FALTAN_DATOS|${errs || "Campos requeridos"}`
            : `ERROR|${res.reason || "Fallo"}`;

        await withRetry(
          () =>
            updateCellByHeader(sheets, {
              spreadsheetId: ENV.SPREADSHEET_ID,
              sheetName: ENV.SHEET_NAME,
              rowNumber: row.__rowNumber,
              headerName: "Estatus credencial",
              value: tag,
            }),
          "set FALTAN_DATOS/ERROR"
        );

        if (tag.startsWith("FALTAN_DATOS|")) missing++;
        else errors++;

        items.push({ row: row.__rowNumber, nombre: input.nombre, ok: false, status: tag });
        continue;
      }

      const finalStatus = `GENERADA|${res.pdfLink}`;
      await withRetry(
        () =>
          updateCellByHeader(sheets, {
            spreadsheetId: ENV.SPREADSHEET_ID,
            sheetName: ENV.SHEET_NAME,
            rowNumber: row.__rowNumber,
            headerName: "Estatus credencial",
            value: finalStatus,
          }),
        "set GENERADA"
      );

      generated++;
      items.push({ row: row.__rowNumber, nombre: input.nombre, ok: true, pdfLink: res.pdfLink, status: finalStatus });
    } catch (e) {
      const msg = safeErrMsg(e);
      const finalStatus = `ERROR|${msg}`;

      await withRetry(
        () =>
          updateCellByHeader(sheets, {
            spreadsheetId: ENV.SPREADSHEET_ID,
            sheetName: ENV.SHEET_NAME,
            rowNumber: row.__rowNumber,
            headerName: "Estatus credencial",
            value: finalStatus,
          }),
        "set ERROR"
      );

      errors++;
      items.push({ row: row.__rowNumber, nombre: input.nombre, ok: false, status: finalStatus });
    }
  }

  return {
    processed,
    generated,
    missing,
    errors,
    tempCleanup,
    scanWindow,
    candidatesInWindow: candidates.length,
    items,
  };
}

module.exports = { runCredentialCronOnce };
