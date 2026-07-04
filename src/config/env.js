// src/config/env.js
require("dotenv").config();

function optional(name, def = "") {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : def;
}

function bool(name, def = false) {
  const raw = optional(name, def ? "true" : "false").toLowerCase();
  return ["1", "true", "yes", "y", "on", "si", "sí"].includes(raw);
}

const LOCAL_DEV_MODE = bool("LOCAL_DEV_MODE", false);
const AI_REVIEW_ONLY_MODE = bool("AI_REVIEW_ONLY_MODE", false);

function required(name) {
  const v = process.env[name];

  if (!v || !String(v).trim()) {
    // En modos de prueba no obligamos variables de Drive/Sheets/etc.
    if (LOCAL_DEV_MODE || AI_REVIEW_ONLY_MODE) return `disabled-${name.toLowerCase()}`;
    throw new Error(`Falta variable de entorno requerida: ${name}`);
  }

  return String(v).trim();
}

const ENV = {
  PORT: optional("PORT", "8080"),

  // ===== Modos de prueba =====
  // LOCAL_DEV_MODE: no llama IA real ni Google APIs; usa mock local.
  LOCAL_DEV_MODE,
  LOCAL_DEV_SAVE_FILES: bool("LOCAL_DEV_SAVE_FILES", true),
  LOCAL_DEV_STORAGE_DIR: optional("LOCAL_DEV_STORAGE_DIR", ".local-dev"),
  LOCAL_RECORDS_DIR: optional("LOCAL_RECORDS_DIR", ".local-records"),
  LOCAL_RECORDS_EXCEL_NAME: optional("LOCAL_RECORDS_EXCEL_NAME", "ship_documentos.xlsx"),
  LOCAL_DEV_MOCK_AI: bool("LOCAL_DEV_MOCK_AI", true),
  LOCAL_DEV_MOCK_AI_STRICT: bool("LOCAL_DEV_MOCK_AI_STRICT", true),

  // AI_REVIEW_ONLY_MODE: llama IA real para validar, pero NO sube a Drive,
  // NO escribe Sheets, NO llama Apps Script, NO llama Odoo y NO guarda expediente.
  AI_REVIEW_ONLY_MODE,

  // ===== Google Drive / Sheets =====
  GOOGLE_ARCHIVE_ENABLED: bool("GOOGLE_ARCHIVE_ENABLED", false),
  SPREADSHEET_ID: optional("SPREADSHEET_ID", ""),
  DRIVE_PARENT_FOLDER_ID: optional("DRIVE_PARENT_FOLDER_ID", ""),
  GOOGLE_DRIVE_PARENT_FOLDER_ID: optional("GOOGLE_DRIVE_PARENT_FOLDER_ID", ""),
  CRED_TMP_FOLDER_ID: optional("CRED_TMP_FOLDER_ID", ""),
  SHEET_NAME: optional("SHEET_NAME", "Documentos"),

  APPS_SCRIPT_WEBAPP_URL: optional("APPS_SCRIPT_WEBAPP_URL", ""),
  APPS_SCRIPT_SHARED_SECRET: optional("APPS_SCRIPT_SHARED_SECRET", ""),

  // ===== Credencial (Slides -> PDF) =====
  TEMPLATE_PRESENTATION_ID: optional("TEMPLATE_PRESENTATION_ID", ""),
  OUTPUT_FOLDER_ID: optional("OUTPUT_FOLDER_ID", ""),
  PUESTO_DEFAULT: optional("PUESTO_DEFAULT", "OPERADOR"),

  // ===== Cron =====
  CRON_SECRET: optional("CRON_SECRET", ""),

  // Límite total de archivos por request (MB)
  MAX_TOTAL_FILES_MB: optional("MAX_TOTAL_FILES_MB", ""),

  // Odoo
  ODOO_URL: optional("ODOO_URL", ""),
  ODOO_DB: optional("ODOO_DB", ""),
  ODOO_USER: optional("ODOO_USER", ""),
  ODOO_PASS: optional("ODOO_PASS", ""),
  SYNC_KEY: optional("SYNC_KEY", ""),

  // Legacy/No usar
  DOC_AI_PROJECT_ID: optional("DOC_AI_PROJECT_ID", ""),
  DOC_AI_LOCATION: optional("DOC_AI_LOCATION", ""),
  DOC_AI_PROCESSOR_ID: optional("DOC_AI_PROCESSOR_ID", ""),

  // ===== Validación documental con IA =====
  DOCUMENT_AI_VALIDATION_ENABLED: optional("DOCUMENT_AI_VALIDATION_ENABLED", "true") !== "false",
  DOCUMENT_AI_VALIDATION_REQUIRED: optional("DOCUMENT_AI_VALIDATION_REQUIRED", "true") !== "false",
  DOCUMENT_AI_VALIDATION_MODE: optional("DOCUMENT_AI_VALIDATION_MODE", "strict"), // strict | warn
  GEMINI_API_KEY: optional("GEMINI_API_KEY", ""),
  GEMINI_MODEL: optional("GEMINI_MODEL", "gemini-2.5-flash"),
  GEMINI_MODEL_FALLBACKS: optional("GEMINI_MODEL_FALLBACKS", "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3-flash-preview,gemini-flash-latest"),
  GEMINI_API_BASE: optional("GEMINI_API_BASE", "https://generativelanguage.googleapis.com/v1beta"),

  // Maps
  GOOGLE_MAPS_KEY: optional("GOOGLE_MAPS_KEY", optional("GOOGLE_MAPS_BROWSER_KEY", optional("GOOGLE_MAPS_API_KEY", optional("MAPS_KEY", "")))),
};


function assertGoogleArchiveConfig() {
  const missing = [];

  if (!ENV.SPREADSHEET_ID) missing.push("SPREADSHEET_ID");
  if (!ENV.GOOGLE_DRIVE_PARENT_FOLDER_ID && !ENV.DRIVE_PARENT_FOLDER_ID) {
    missing.push("GOOGLE_DRIVE_PARENT_FOLDER_ID o DRIVE_PARENT_FOLDER_ID");
  }

  if (missing.length) {
    throw new Error(`GOOGLE_ARCHIVE_ENABLED=true pero faltan variables: ${missing.join(", ")}`);
  }
}

function assertCredentialCronConfig() {
  const missing = [];

  if (!ENV.TEMPLATE_PRESENTATION_ID) missing.push("TEMPLATE_PRESENTATION_ID");
  if (!ENV.OUTPUT_FOLDER_ID) missing.push("OUTPUT_FOLDER_ID");
  if (!ENV.CRED_TMP_FOLDER_ID) missing.push("CRED_TMP_FOLDER_ID");

  if (missing.length) {
    throw new Error(`Credenciales por cron habilitadas pero faltan variables: ${missing.join(", ")}`);
  }
}

module.exports = {
  ENV,
  assertGoogleArchiveConfig,
  assertCredentialCronConfig,
};
