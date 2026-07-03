// src/routes/localDev.js
const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { ENV } = require("../config/env");

const router = express.Router();

router.get("/api/local-dev/status", async (_, res) => {
  res.json({
    ok: true,
    localDev: ENV.LOCAL_DEV_MODE,
    storageDir: ENV.LOCAL_DEV_STORAGE_DIR,
    mockAi: ENV.LOCAL_DEV_MOCK_AI,
    saveFiles: ENV.LOCAL_DEV_SAVE_FILES
  });
});

router.get("/api/local-dev/submissions", async (_, res) => {
  if (!ENV.LOCAL_DEV_MODE) {
    return res.status(404).json({ ok: false, error: "LOCAL_DEV_MODE no está activo." });
  }

  const dir = path.join(process.cwd(), ENV.LOCAL_DEV_STORAGE_DIR, "submissions");

  try {
    const files = await fs.readdir(dir);
    const items = files
      .filter((x) => x.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, 50)
      .map((file) => ({
        file,
        url: `/local-dev-files/submissions/${file}`
      }));

    res.json({ ok: true, items });
  } catch {
    res.json({ ok: true, items: [] });
  }
});

module.exports = { localDevRouter: router };
