// src/routes/jobStatus.js
const express = require("express");
const { getJob } = require("../services/jobStore");

const router = express.Router();

router.get("/api/job-status", (req, res) => {
  const jobId = String(req.query.jobId || "").trim();
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ ok:false, state:"not_found", message:"No existe ese ID de seguimiento (aún)." });
  res.json({
    ok: job.ok !== false,
    state: job.state,
    message: job.message || "",
    jobId,
    updatedAt: job.updatedAt,
    sheet: job.sheet || null,
    folderId: job.folderId || null,
    documentValidation: job.data?.documentValidation || null,
    validationErrors: job.validationErrors || null,
    documentValidationSummary: (() => {
      const rows = Object.values(job.data?.documentValidation || {});
      return {
        total: rows.length,
        approved: rows.filter(x => x && x.ok === true).length,
        rejected: rows.filter(x => x && x.ok === false).length,
        validating: rows.filter(x => x && x.status === "validating").length
      };
    })(),
    aiReviewOnly: job.aiReviewOnly || false,
    saved: job.saved !== false,
  });
});

module.exports = { jobStatusRouter: router };
