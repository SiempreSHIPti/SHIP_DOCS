// src/middleware/upload.js
const multer = require("multer");

const MB = 1024 * 1024;

function toInt(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Defaults seguros
const MAX_FILE_MB = toInt(process.env.MAX_FILE_MB, 12);       // por archivo
const MAX_FILES = toInt(process.env.MAX_FILES, 12);           // cantidad de archivos
const MAX_FIELDS = toInt(process.env.MAX_FIELDS, 120);        // campos texto
const MAX_FIELD_SIZE_KB = toInt(process.env.MAX_FIELD_SIZE_KB, 256); // tamaño campo texto
const MAX_TOTAL_FILES_MB = toInt(process.env.MAX_TOTAL_FILES_MB, 70); // total por request

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

function fileFilter(_req, file, cb) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}. Usa PDF, JPG, PNG o WEBP.`));
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: {
    fileSize: MAX_FILE_MB * MB,
    files: MAX_FILES,
    fields: MAX_FIELDS,
    fieldSize: MAX_FIELD_SIZE_KB * 1024,
    parts: MAX_FILES + MAX_FIELDS,
  },
});

function detectMagic(buffer) {
  if (!buffer || buffer.length < 12) return "unknown";

  const head4 = buffer.subarray(0, 4).toString("hex");
  const head8 = buffer.subarray(0, 8).toString("hex");
  const ascii4 = buffer.subarray(0, 4).toString("ascii");
  const riff = buffer.subarray(0, 4).toString("ascii");
  const webp = buffer.subarray(8, 12).toString("ascii");

  if (ascii4 === "%PDF") return "application/pdf";
  if (head4 === "ffd8ffe0" || head4 === "ffd8ffe1" || head4 === "ffd8ffe2" || head4.startsWith("ffd8ff")) return "image/jpeg";
  if (head8 === "89504e470d0a1a0a") return "image/png";
  if (riff === "RIFF" && webp === "WEBP") return "image/webp";

  return "unknown";
}

function allUploadedFiles(req) {
  const files = req.files || {};
  if (Array.isArray(files)) return files;
  return Object.values(files).flat().filter(Boolean);
}

function validateUploadedFiles(req, _res, next) {
  try {
    const files = allUploadedFiles(req);
    const totalBytes = files.reduce((sum, file) => sum + Number(file.size || file.buffer?.length || 0), 0);

    if (totalBytes > MAX_TOTAL_FILES_MB * MB) {
      return next(new Error(`El total de archivos supera ${MAX_TOTAL_FILES_MB} MB.`));
    }

    for (const file of files) {
      const detected = detectMagic(file.buffer);
      if (!ALLOWED_MIME.has(detected)) {
        return next(new Error(`El archivo ${file.originalname || file.fieldname} no parece ser PDF/imagen válida.`));
      }

      if (detected !== file.mimetype) {
        // Se permite jpeg con variaciones, pero no ejecutar archivos disfrazados.
        const pair = `${file.mimetype}->${detected}`;
        const allowedPairs = new Set(["image/jpeg->image/jpeg", "image/png->image/png", "image/webp->image/webp", "application/pdf->application/pdf"]);
        if (!allowedPairs.has(pair)) {
          return next(new Error(`El archivo ${file.originalname || file.fieldname} no coincide con su tipo declarado.`));
        }
      }
    }

    next();
  } catch (err) {
    next(err);
  }
}

function logMultipartHeaders(req, _res, next) {
  const ct = req.headers["content-type"];
  const cl = req.headers["content-length"];
  const hasBoundary = typeof ct === "string" && ct.includes("boundary=");
  console.log("[UPLOAD] content-type:", ct);
  console.log("[UPLOAD] content-length:", cl);
  console.log("[UPLOAD] has-boundary:", hasBoundary);
  next();
}

module.exports = { upload, logMultipartHeaders, validateUploadedFiles, detectMagic };
