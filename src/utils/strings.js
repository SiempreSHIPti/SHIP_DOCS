// src/utils/strings.js
function toUpperClean(s) { return String(s || "").toUpperCase().trim(); }
function digitsOnly(s) { return String(s || "").replace(/\D+/g, ""); }
function escSingleQuotes(s) { return String(s).replace(/'/g, "\\'"); }
function sanitizeFileBase(base) {
  return String(base || "")
    .replace(/[\\\/:*?"<>|#%]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
module.exports = { toUpperClean, digitsOnly, escSingleQuotes, sanitizeFileBase };
