// src/services/processSubmission.js
const fs = require("fs/promises");
const path = require("path");
const mime = require("mime-types");
const { ENV } = require("../config/env");
const { getClients } = require("../lib/google");
const { ensurePersonFolder, replaceAndUpload } = require("./driveOrganize");
const { ensureSheetAndHeaders, buildRowValues, writeRowAtoAN } = require("./sheets");
const { slog } = require("../utils/log");
const { validateDocument, assertDocumentValidationResults } = require("./documentValidation");

function safeSlug(s) {
  return String(s || "")
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 60);
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

async function withRetry(fn, jobId, step, { retries = 5, baseMs = 400 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.response?.status ?? e?.response?.data?.error?.code ?? e?.code;
      const reason = e?.response?.data?.error?.errors?.[0]?.reason ?? e?.errors?.[0]?.reason;
      const msg = e?.response?.data?.error?.message ?? e?.message ?? String(e);

      const retryable =
        [429, 500, 502, 503, 504].includes(status) ||
        ["backendError", "rateLimitExceeded", "userRateLimitExceeded"].includes(reason);

      slog(jobId, retryable ? "WARN" : "ERROR", `Fallo en ${step} (attempt=${attempt + 1})`, {
        status,
        reason,
        message: msg,
      });

      if (!retryable || attempt >= retries) {
        console.error(`❌ Error final en ${step}:`);
        console.dir(e?.response?.data, { depth: null });
        console.error("status:", e?.response?.status);
        console.error("message:", e?.message);
        throw e;
      }

      const wait = Math.floor(baseMs * (2 ** attempt) + Math.random() * 250);
      await new Promise((r) => setTimeout(r, wait));
      attempt++;
    }
  }
}

function getDocMap() {
  return {
    ine_frontal: { doc: "ineFrontalLink", base: "INE_FRONTAL" },
    ine_reverso: { doc: "ineReversoLink", base: "INE_REVERSO" },
    curp: { doc: "curpLink", base: "CURP" },
    nss_file: { doc: "nssLink", base: "NSS" },
    constancia: { doc: "constanciaLink", base: "CONSTANCIA_FISCAL" },
    acta: { doc: "actaLink", base: "ACTA_NACIMIENTO" },
    comprobante: { doc: "compDomLink", base: "COMPROBANTE_DOMICILIO" },
    licencia: { doc: "licenciaLink", base: "LICENCIA" },
    tarjeta: { doc: "tarjetaLink", base: "TARJETA_CIRCULACION" },
    poliza: { doc: "polizaLink", base: "POLIZA_SEGURO" },
    selfie: { doc: "selfieLink", base: "FOTO_PERSONAL" },
    estado_cuenta: { doc: "clabeLink", base: "ESTADO_CUENTA" }
  };
}

function buildTasks(nombre, telefono, filesObj) {
  const personTag = `${safeSlug(nombre)}_${String(telefono || "").slice(0, 10)}`;
  const nameMap = getDocMap();
  const tasks = [];

  for (const [key, mapping] of Object.entries(nameMap)) {
    const file = filesObj[key];
    if (file?.buffer) {
      tasks.push({
        fieldName: key,
        file,
        docKey: mapping.doc,
        uniqueName: `${mapping.base}_${personTag}`,
        step: `upload ${mapping.base}`
      });
    }
  }

  return tasks;
}

async function validateTasks(jobId, nombre, tasks) {
  const documentValidation = {};

  if (!tasks.length) return documentValidation;

  const validationLimit = poolLimit(2);
  const validationResults = await Promise.all(
    tasks.map((t) => validationLimit(async () => {
      const result = await validateDocument({
        jobId,
        fieldName: t.fieldName,
        file: t.file,
        expectedName: nombre,
      });
      documentValidation[t.fieldName] = result;
      return result;
    }))
  );

  assertDocumentValidationResults(validationResults);
  return documentValidation;
}

async function ensureLocalDir(...parts) {
  const dir = path.join(process.cwd(), ENV.LOCAL_DEV_STORAGE_DIR, ...parts);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function saveLocalFile(jobId, task) {
  const extFromMime = mime.extension(task.file.mimetype || "") || "";
  const originalExt = path.extname(task.file.originalname || "").replace(".", "");
  const ext = extFromMime || originalExt || "bin";
  const filename = `${task.uniqueName}.${ext}`.replace(/[^\w.\-]/g, "_");
  const dir = await ensureLocalDir("uploads", jobId);
  const filepath = path.join(dir, filename);

  if (ENV.LOCAL_DEV_SAVE_FILES) {
    await fs.writeFile(filepath, task.file.buffer);
  }

  return `/local-dev-files/uploads/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}`;
}

async function uploadStepFilesLocal(jobId, nombre, telefono, filesObj) {
  slog(jobId, "INFO", "LOCAL_DEV_MODE: validando documentos y guardando archivos localmente");

  const tasks = buildTasks(nombre, telefono, filesObj);
  const documentValidation = await validateTasks(jobId, nombre, tasks);
  const newLinks = {};

  for (const task of tasks) {
    newLinks[task.docKey] = await saveLocalFile(jobId, task);
  }

  return {
    folderIdPersona: `local-dev-folder-${jobId}`,
    newLinks,
    documentValidation,
    localDev: true
  };
}


async function uploadStepFilesAiReviewOnly(jobId, nombre, telefono, filesObj) {
  slog(jobId, "INFO", "AI_REVIEW_ONLY_MODE: validando documentos con IA real sin subir ni guardar archivos");

  const tasks = buildTasks(nombre, telefono, filesObj);
  const documentValidation = await validateTasks(jobId, nombre, tasks);

  const newLinks = {};
  for (const task of tasks) {
    // No se guarda archivo. Sólo se deja trazabilidad no sensible del campo revisado.
    newLinks[task.docKey] = `ai-review-only://${task.fieldName}`;
  }

  return {
    folderIdPersona: null,
    newLinks,
    documentValidation,
    aiReviewOnly: true
  };
}


async function uploadStepFiles(jobId, nombre, telefono, filesObj) {
  if (ENV.AI_REVIEW_ONLY_MODE) {
    return uploadStepFilesAiReviewOnly(jobId, nombre, telefono, filesObj);
  }

  if (ENV.LOCAL_DEV_MODE) {
    return uploadStepFilesLocal(jobId, nombre, telefono, filesObj);
  }

  slog(jobId, "INFO", "Validando y subiendo archivos del paso actual");

  const tasks = buildTasks(nombre, telefono, filesObj);
  const documentValidation = await validateTasks(jobId, nombre, tasks);

  const { drive } = await withRetry(() => getClients(), jobId, "getClients");
  const folderIdPersona = await withRetry(
    () => ensurePersonFolder(drive, ENV.DRIVE_PARENT_FOLDER_ID, nombre),
    jobId,
    "ensurePersonFolder"
  );

  const newLinks = {};
  const limit = poolLimit(4);

  await Promise.all(
    tasks.map((t) =>
      limit(async () => {
        const link = await withRetry(
          () => replaceAndUpload(drive, folderIdPersona, t.file.buffer, t.file.mimetype, t.uniqueName),
          jobId,
          t.step
        );
        newLinks[t.docKey] = link;
      })
    )
  );

  return { folderIdPersona, newLinks, documentValidation };
}

async function finalizeSubmissionLocal(jobId, allData, { setJob }) {
  slog(jobId, "INFO", "LOCAL_DEV_MODE: finalizando registro sin Google Sheets ni APIs externas");
  setJob(jobId, { state: "processing", message: "Modo local: guardando registro en archivo JSON local…" });

  try {
    const dir = await ensureLocalDir("submissions");
    const filename = `${jobId}.json`;
    const filepath = path.join(dir, filename);

    const payload = {
      ok: true,
      localDev: true,
      jobId,
      createdAt: new Date().toISOString(),
      data: allData,
      note: "Registro guardado localmente. No se llamó Drive, Sheets, Apps Script, Odoo ni Gemini."
    };

    await fs.writeFile(filepath, JSON.stringify(payload, null, 2), "utf8");

    setJob(jobId, {
      ok: true,
      state: "done",
      message: "Modo local: expediente validado y guardado localmente. No se subió a Drive ni Sheets.",
      sheet: null,
      localDev: {
        enabled: true,
        submissionFile: `/local-dev-files/submissions/${filename}`,
        storageDir: ENV.LOCAL_DEV_STORAGE_DIR
      }
    });
  } catch (e) {
    const msg = e?.message || "Error guardando archivo local.";
    setJob(jobId, { ok: false, state: "error", message: msg });
    console.error("❌ Error en finalizeSubmissionLocal:", e);
  }
}


async function finalizeSubmissionAiReviewOnly(jobId, allData, { setJob }) {
  slog(jobId, "INFO", "AI_REVIEW_ONLY_MODE: finalizando sin enviar datos a Drive, Sheets, Apps Script, Odoo ni BD");

  // No escribimos JSON local con datos personales.
  // No subimos archivos.
  // No mandamos datos a Google Sheets.
  // Sólo actualizamos jobStore en memoria para que el navegador vea el resultado.
  setJob(jobId, {
    ok: true,
    state: "done",
    message: "Revisión IA finalizada. Modo sólo revisión: no se subió archivo, no se guardó expediente y no se envió data a Drive/Sheets/Odoo.",
    sheet: null,
    folderId: null,
    aiReviewOnly: true,
    saved: false
  });
}


async function finalizeSubmission(jobId, allData, { setJob }) {
  if (ENV.AI_REVIEW_ONLY_MODE) {
    return finalizeSubmissionAiReviewOnly(jobId, allData, { setJob });
  }

  if (ENV.LOCAL_DEV_MODE) {
    return finalizeSubmissionLocal(jobId, allData, { setJob });
  }

  slog(jobId, "INFO", "Finalizando proceso de registro");
  setJob(jobId, { state: "processing", message: "Guardando registro en Google Sheets…" });

  try {
    const { sheets } = await withRetry(() => getClients(), jobId, "getClients");
    await withRetry(() => ensureSheetAndHeaders(sheets), jobId, "ensureSheetAndHeaders");

    const values = buildRowValues(allData);
    const writeRes = await withRetry(() => writeRowAtoAN(sheets, values), jobId, "writeRowAtoAN");

    setJob(jobId, {
      ok: true,
      state: "done",
      message: "Expediente guardado exitosamente. La credencial se generará si aplica.",
      sheet: { row: writeRes.row, range: writeRes.range },
    });

  } catch (e) {
    const msg = e?.response?.data?.error?.message || e?.message || "Error no especificado guardando en Sheets.";
    setJob(jobId, { ok: false, state: "error", message: msg });
    console.error("❌ Error en finalizeSubmission:", e);
  }
}

module.exports = { uploadStepFiles, finalizeSubmission };
