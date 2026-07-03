// src/utils/log.js
function slog(jobId, severity = "INFO", msg = "", extra = {}) {
  const entry = { severity, jobId, msg, ...extra, ts: new Date().toISOString() };
  if (severity === "ERROR") console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}
module.exports = { slog };
