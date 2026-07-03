// src/routes/security.js
const express = require("express");
const { ENV } = require("../config/env");

const router = express.Router();

router.get("/api/security/document-validation-config", (_req, res) => {
  res.json({
    ok: true,
    documentAiValidationEnabled: Boolean(ENV.DOCUMENT_AI_VALIDATION_ENABLED),
    documentAiValidationRequired: Boolean(ENV.DOCUMENT_AI_VALIDATION_REQUIRED),
    documentAiValidationMode: ENV.DOCUMENT_AI_VALIDATION_MODE,
    geminiConfigured: Boolean(ENV.GEMINI_API_KEY),
    allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png", "image/webp"],
  });
});

module.exports = { securityRouter: router };
