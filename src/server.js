// src/server.js
const express = require("express");
const path = require("path");
const { ENV } = require("./config/env");
const { securityHeaders, rateLimit } = require("./middleware/security");

const { submitRouter } = require("./routes/submit");
const { jobStatusRouter } = require("./routes/jobStatus");

const { cronCredencialesRouter } = require("./routes/cronCredenciales");
const { securityRouter } = require("./routes/security");
const { localDevRouter } = require("./routes/localDev");
const { documentValidationRealtimeRouter } = require("./routes/documentValidationRealtime");
const { finalDocumentReviewRouter } = require("./routes/finalDocumentReview");
const { saveLocalRegistrationRouter } = require("./routes/saveLocalRegistration");
const { draftLocalRegistrationRouter } = require("./routes/draftLocalRegistration");
function buildApp() {
  const app = express();

  function assertMiddleware(name, mw) {
    const ok = typeof mw === "function";
    if (!ok) {
      console.error(`❌ Router inválido: ${name}`, {
        type: typeof mw,
        keys: mw && typeof mw === "object" ? Object.keys(mw) : null,
        value: mw,
      });
      throw new Error(`Router inválido: ${name}`);
    }
    console.log(`✅ Router OK: ${name}`);
    return mw;
  }

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(securityHeaders);
  app.use(rateLimit({ windowMs: 60_000, max: 180, keyPrefix: "global" }));
  app.use(["/submit-step", "/submit-final"], rateLimit({ windowMs: 15 * 60_000, max: 18, keyPrefix: "submit" }));

  // Parsers (multipart lo maneja multer en /submit)
  app.use(express.urlencoded({ extended: true, limit: "256kb" }));
  app.use(express.json({ limit: "256kb" }));

  // Static
  app.use(express.static(path.join(process.cwd(), "public")));

  // Archivos locales para pruebas DEV. No se usa Drive ni BD cuando LOCAL_DEV_MODE=true.
  if (ENV.LOCAL_DEV_MODE) {
    app.use(
      "/local-dev-files",
      express.static(path.join(process.cwd(), ENV.LOCAL_DEV_STORAGE_DIR), {
        fallthrough: false,
        index: false,
        maxAge: 0
      })
    );
  }


  // Archivos de prueba generados localmente: documentos, Excel y credenciales.
  app.use(
    "/local-records",
    express.static(path.join(process.cwd(), ENV.LOCAL_RECORDS_DIR || ".local-records"), {
      fallthrough: false,
      index: false,
      maxAge: 0,
    })
  );

  // Routes
  app.use(assertMiddleware("submitRouter", submitRouter));
  app.use(assertMiddleware("jobStatusRouter", jobStatusRouter));
  app.use(assertMiddleware("cronCredencialesRouter", cronCredencialesRouter));
  app.use(assertMiddleware("securityRouter", securityRouter));
  app.use(assertMiddleware("localDevRouter", localDevRouter));
  app.use(assertMiddleware("documentValidationRealtimeRouter", documentValidationRealtimeRouter));
  app.use(assertMiddleware("finalDocumentReviewRouter", finalDocumentReviewRouter));
  app.use(assertMiddleware("saveLocalRegistrationRouter", saveLocalRegistrationRouter));
  app.use(assertMiddleware("draftLocalRegistrationRouter", draftLocalRegistrationRouter));

  // Health simple
  app.get("/api/health", (_, res) => res.json({ ok: true }));

  // Public config
  app.get("/api/config", (_, res) => res.json({
    mapsKey: ENV.GOOGLE_MAPS_KEY,
    aiReviewOnlyMode: ENV.AI_REVIEW_ONLY_MODE,
    localDevMode: ENV.LOCAL_DEV_MODE,
    documentAiValidationEnabled: ENV.DOCUMENT_AI_VALIDATION_ENABLED,
    documentAiValidationRequired: ENV.DOCUMENT_AI_VALIDATION_REQUIRED,
    documentAiValidationMode: ENV.DOCUMENT_AI_VALIDATION_MODE,
    geminiModel: ENV.GEMINI_MODEL,
    finalReviewMode: true,
    realtimeValidationEnabled: false,
    resumeByCurpEnabled: true
  }));

  return app;
}

async function startServer({ port }) {
  const app = buildApp();

  console.log("ENV OK:", {
    PORT: ENV.PORT,
    SPREADSHEET_ID: ENV.SPREADSHEET_ID ? "set" : "missing",
    DRIVE_PARENT_FOLDER_ID: ENV.DRIVE_PARENT_FOLDER_ID ? "set" : "missing",
    SHEET_NAME: ENV.SHEET_NAME,
    TEMPLATE_PRESENTATION_ID: ENV.TEMPLATE_PRESENTATION_ID ? "set" : "missing",
    OUTPUT_FOLDER_ID: ENV.OUTPUT_FOLDER_ID ? "set" : "missing",
    CRON_SECRET: ENV.CRON_SECRET ? "set" : "missing",
    GAS: ENV.APPS_SCRIPT_WEBAPP_URL ? "on" : "off",
    LOCAL_DEV_MODE: ENV.LOCAL_DEV_MODE,
    AI_REVIEW_ONLY_MODE: ENV.AI_REVIEW_ONLY_MODE,
    LOCAL_DEV_STORAGE_DIR: ENV.LOCAL_DEV_STORAGE_DIR,
    LOCAL_DEV_MOCK_AI: ENV.LOCAL_DEV_MOCK_AI,
    LOCAL_DEV_MOCK_AI_STRICT: ENV.LOCAL_DEV_MOCK_AI_STRICT,
    DOCUMENT_AI_VALIDATION_ENABLED: ENV.DOCUMENT_AI_VALIDATION_ENABLED,
    GEMINI_API_KEY: ENV.GEMINI_API_KEY ? "set" : "missing",
    GEMINI_MODEL: ENV.GEMINI_MODEL,
    GEMINI_MODEL_FALLBACKS: ENV.GEMINI_MODEL_FALLBACKS,
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server)).on("error", reject);
  });
}

module.exports = { buildApp, startServer };
