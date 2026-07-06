// src/services/localDraftStore.js
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const mime = require("mime-types");
const { ENV } = require("../config/env");

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

function archiveRoot() {
  return path.resolve(process.cwd(), ENV.LOCAL_RECORDS_DIR || ".local-records");
}

function draftsRoot() {
  return path.join(archiveRoot(), "drafts");
}

function completedRegistryPath() {
  return path.join(archiveRoot(), "completed-registrations.json");
}

async function readCompletedRegistry() {
  const filePath = completedRegistryPath();
  if (!fssync.existsSync(filePath)) return {};
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) || {};
  } catch (_) {
    return {};
  }
}

async function findCompletedRegistration(curpRaw) {
  const curp = normalizeCurp(curpRaw);
  if (!curp || curp.length < 18) return null;
  const registry = await readCompletedRegistry();
  return registry[curp] || null;
}

async function markCurpCompleted({ curp, credentialId, jobId, googleArchive, localArchive }) {
  const normalized = normalizeCurp(curp);
  if (!normalized || normalized.length < 18) return null;

  await ensureDir(archiveRoot());
  const registry = await readCompletedRegistry();

  registry[normalized] = {
    curp: normalized,
    credentialId: credentialId || "",
    jobId: jobId || "",
    savedAt: new Date().toISOString(),
    googleFolder: googleArchive?.driverFolder?.webViewLink || "",
    localCredential: localArchive?.credentialPdf?.relativePath || "",
  };

  await fs.writeFile(completedRegistryPath(), JSON.stringify(registry, null, 2), "utf8");
  return registry[normalized];
}


function reviewText(...values) {
  return values
    .flat(Infinity)
    .filter(Boolean)
    .map((v) => typeof v === "object" ? JSON.stringify(v) : String(v))
    .join(" ");
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


function normalizeCurp(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 18);
}

function findCurpInText(value) {
  const text = String(value || "").toUpperCase();
  const match = text.match(/[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d/);
  return match ? normalizeCurp(match[0]) : "";
}

function getCurpFromReview(reviewPayload) {
  const rows = reviewPayload?.results || [];
  const curpRow = rows.find((row) => row.fieldName === "curp");

  const candidates = [
    curpRow?.fields?.curp,
    curpRow?.curp,
    curpRow?.summary,
    ...(curpRow?.issues || []),
    ...(curpRow?.warnings || []),
  ];

  for (const candidate of candidates) {
    const direct = normalizeCurp(candidate);
    if (direct.length === 18) return direct;

    const fromText = findCurpInText(candidate);
    if (fromText.length === 18) return fromText;
  }

  return "";
}

function safePart(value, fallback = "SIN_DATO") {
  const clean = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  return clean || fallback;
}

function relativeUrl(absPath) {
  const root = archiveRoot();
  const rel = path.relative(root, absPath).split(path.sep).map(encodeURIComponent).join("/");
  return `/local-records/${rel}`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function normalizeBody(body = {}, reviewPayload = {}) {
  const data = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (key === "latestReviewPayload") continue;
    if (value === undefined || value === null) continue;
    data[key] = String(value);
  }
  const banco = normalizeBankName(data.banco || extractBankFromReview(reviewPayload));
  const clabe = extractClabeFromText(data.clabe || data.clabeTxt || extractClabeFromReview(reviewPayload));
  if (banco) data.banco = banco;
  if (clabe) {
    data.clabe = clabe;
    data.clabeTxt = clabe;
    data.clabe_mode = data.clabe_mode || "archivo";
  }
  return data;
}

function getUploadedFile(files, fieldName) {
  return (files?.[fieldName] || [])[0] || null;
}

async function saveDraftFiles({ curp, jobId, files }) {
  const dir = path.join(draftsRoot(), curp, safePart(jobId).slice(0, 18));
  await ensureDir(dir);

  const filePaths = {};

  for (const fieldName of FILE_FIELDS) {
    const file = getUploadedFile(files, fieldName);
    if (!file?.buffer) continue;

    const extFromMime = mime.extension(file.mimetype || "");
    const originalExt = path.extname(file.originalname || "").replace(".", "");
    const ext = extFromMime || originalExt || "bin";
    const fileName = `${safePart(fieldName)}_${safePart(file.originalname || fieldName)}.${ext}`.replace(/(\.[^.]+)\.\1$/i, "$1");
    const abs = path.join(dir, fileName);

    await fs.writeFile(abs, file.buffer);

    filePaths[fieldName] = {
      absolutePath: abs,
      relativePath: path.relative(process.cwd(), abs),
      url: relativeUrl(abs),
      originalName: file.originalname || fileName,
      mimeType: file.mimetype || "",
      sizeBytes: file.size || file.buffer.length || 0,
    };
  }

  return filePaths;
}

async function saveLocalDraft({ jobId, body, files, reviewPayload }) {
  const curp = getCurpFromReview(reviewPayload);
  if (!curp || curp.length < 18) {
    const err = new Error("No fue posible guardar el avance porque la IA no detectó una CURP válida en el documento CURP.");
    err.code = "CURP_NOT_DETECTED";
    throw err;
  }

  await ensureDir(path.join(draftsRoot(), curp));

  const filePaths = await saveDraftFiles({ curp, jobId, files });
  const draftPath = path.join(draftsRoot(), curp, "draft.json");

  let previous = null;
  if (fssync.existsSync(draftPath)) {
    try {
      previous = JSON.parse(await fs.readFile(draftPath, "utf8"));
    } catch (_) {
      previous = null;
    }
  }

  const mergedFilePaths = {
    ...(previous?.filePaths || {}),
    ...filePaths,
  };

  const draft = {
    version: 4,
    curp,
    jobId,
    savedAt: new Date().toISOString(),
    data: normalizeBody(body, reviewPayload),
    filePaths: mergedFilePaths,
    latestReviewPayload: reviewPayload,
  };

  await fs.writeFile(draftPath, JSON.stringify(draft, null, 2), "utf8");

  return {
    curp,
    draftPath: {
      absolutePath: draftPath,
      relativePath: path.relative(process.cwd(), draftPath),
      url: relativeUrl(draftPath),
    },
    data: draft.data,
    filePaths: mergedFilePaths,
    latestReviewPayload: reviewPayload,
    savedAt: draft.savedAt,
  };
}

async function loadLocalDraft(curpRaw) {
  const curp = normalizeCurp(curpRaw);
  if (!curp || curp.length < 18) return null;

  const draftPath = path.join(draftsRoot(), curp, "draft.json");
  if (!fssync.existsSync(draftPath)) return null;

  const draft = JSON.parse(await fs.readFile(draftPath, "utf8"));
  return draft;
}

async function getDraftFile(curpRaw, fieldName) {
  const draft = await loadLocalDraft(curpRaw);
  const info = draft?.filePaths?.[fieldName];
  if (!info?.relativePath && !info?.absolutePath) return null;

  const abs = info.absolutePath || path.resolve(process.cwd(), info.relativePath);
  if (!fssync.existsSync(abs)) return null;

  const buffer = await fs.readFile(abs);
  const mimeType = info.mimeType || mime.lookup(abs) || "application/octet-stream";

  return {
    fieldname: fieldName,
    originalname: info.originalName || path.basename(abs),
    encoding: "7bit",
    mimetype: mimeType,
    size: buffer.length,
    buffer,
    fromDraft: true,
    draftPath: info,
  };
}

async function mergeDraftFilesWithUploads({ files, curp }) {
  const merged = { ...(files || {}) };

  for (const fieldName of FILE_FIELDS) {
    if (merged[fieldName]?.[0]) continue;

    const draftFile = await getDraftFile(curp, fieldName);
    if (draftFile) merged[fieldName] = [draftFile];
  }

  return merged;
}

module.exports = {
  FILE_FIELDS,
  normalizeCurp,
  getCurpFromReview,
  saveLocalDraft,
  loadLocalDraft,
  getDraftFile,
  mergeDraftFilesWithUploads,
  findCompletedRegistration,
  markCurpCompleted,
};
