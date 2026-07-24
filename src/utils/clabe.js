"use strict";

const CLABE_BANK_CODES = Object.freeze({
  "002": "BANAMEX",
  "012": "BBVA MEXICO",
  "014": "SANTANDER",
  "019": "BANJERCITO",
  "021": "HSBC",
  "030": "BAJIO",
  "036": "INBURSA",
  "044": "SCOTIABANK",
  "058": "BANREGIO",
  "059": "INVEX",
  "060": "BANSI",
  "062": "AFIRME",
  "072": "BANORTE",
  "112": "BMONEX",
  "113": "VE POR MAS",
  "127": "AZTECA",
  "130": "COMPARTAMOS",
  "132": "MULTIVA BANCO",
  "133": "ACTINVER",
  "136": "INTERCAM BANCO",
  "137": "BANCOPPEL",
  "138": "ABC CAPITAL",
  "140": "CONSUBANCO",
  "143": "CIBANCO",
  "145": "BBASE",
  "148": "PAGATODO",
  "150": "INMOBILIARIO",
  "151": "DONDE",
  "152": "BANCREA",
  "156": "SABADELL",
  "166": "BANCO DEL BIENESTAR"
});

function normalizeClabe(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 18);
}

function calculateClabeCheckDigit(first17) {
  const digits = String(first17 || "").replace(/\D/g, "");
  if (digits.length !== 17) return null;

  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += (Number(digits[i]) * weights[i % 3]) % 10;
  }
  return (10 - (sum % 10)) % 10;
}

function isValidClabe(value) {
  const clabe = normalizeClabe(value);
  if (clabe.length !== 18) return false;
  const check = calculateClabeCheckDigit(clabe.slice(0, 17));
  return check !== null && check === Number(clabe[17]);
}

function getBankCodeFromClabe(value) {
  const clabe = normalizeClabe(value);
  return clabe.length === 18 ? clabe.slice(0, 3) : "";
}

function getBankFromClabe(value) {
  const clabe = normalizeClabe(value);
  if (!isValidClabe(clabe)) return null;
  const code = getBankCodeFromClabe(clabe);
  const name = CLABE_BANK_CODES[code] || "";
  return name ? { code, name, source: "clabe_prefix" } : { code, name: "", source: "clabe_prefix_unknown" };
}

function normalizeBankKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\b(BANCO|MEXICO|MEX|SA|S A|INSTITUCION|FINANCIERA)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bankNamesEquivalent(a, b) {
  const left = normalizeBankKey(a);
  const right = normalizeBankKey(b);
  if (!left || !right) return false;
  if (left === right) return true;

  const aliases = [
    ["BBVA", "BBVA MEXICO"],
    ["BANCOMER", "BBVA MEXICO"],
    ["BANAMEX", "CITIBANAMEX"],
    ["BANORTE", "IXE"],
    ["BAJIO", "BANBAJIO"],
    ["VE POR MAS", "VEPORMAS"],
  ];

  for (const [x, y] of aliases) {
    const nx = normalizeBankKey(x);
    const ny = normalizeBankKey(y);
    if ((left === nx && right === ny) || (left === ny && right === nx)) return true;
  }

  return left.includes(right) || right.includes(left);
}

function resolveBankName({ clabe, candidates = [] } = {}) {
  const fromClabe = getBankFromClabe(clabe);
  if (fromClabe?.name) {
    return {
      name: fromClabe.name,
      code: fromClabe.code,
      source: "clabe_prefix",
      aiOrInputBank: String(candidates.find((v) => String(v || "").trim()) || "").trim(),
      mismatch: candidates.some((v) => String(v || "").trim() && !bankNamesEquivalent(v, fromClabe.name)),
    };
  }

  const fallback = String(candidates.find((v) => String(v || "").trim()) || "").trim();
  return {
    name: fallback,
    code: fromClabe?.code || getBankCodeFromClabe(clabe),
    source: fallback ? "visual_or_ai" : "unknown",
    aiOrInputBank: fallback,
    mismatch: false,
  };
}

module.exports = {
  CLABE_BANK_CODES,
  normalizeClabe,
  calculateClabeCheckDigit,
  isValidClabe,
  getBankCodeFromClabe,
  getBankFromClabe,
  normalizeBankKey,
  bankNamesEquivalent,
  resolveBankName,
};
