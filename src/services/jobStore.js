// src/services/jobStore.js
const JOB_TTL_MS = 60 * 60 * 1000;
const jobs = new Map();

function setJob(jobId, patch) {
  const prev = jobs.get(jobId) || { createdAt: Date.now(), state: "queued" };
  const next = { ...prev, ...patch, updatedAt: Date.now() };
  jobs.set(jobId, next);
  if (prev._gc) clearTimeout(prev._gc);
  next._gc = setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
  return next;
}
function getJob(jobId) { return jobs.get(jobId); }

module.exports = { setJob, getJob };
