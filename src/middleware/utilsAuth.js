// src/middleware/utilsAuth.js
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CONFIG_PATH = path.join(__dirname, "../config/utils-users.json");
const COOKIE_NAME = "seza_utils_session";

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.users) || !parsed.users.length) {
    throw new Error("utils-users.json no contiene usuarios.");
  }
  return parsed;
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromB64url(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function signingSecret(config) {
  const explicit = String(config.sessionSecret || "").trim();
  if (explicit) return explicit;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(config.users || []))
    .digest("hex");
}

function signPayload(payloadB64, secret) {
  return crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

function buildSessionToken(user) {
  const config = loadConfig();
  const sessionHours = Math.max(1, Math.min(24, Number(config.sessionHours || 8)));
  const payload = {
    u: user.username,
    n: user.name || user.username,
    exp: Date.now() + sessionHours * 60 * 60 * 1000,
  };
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${signPayload(encoded, signingSecret(config))}`;
}

function verifySessionToken(token) {
  const config = loadConfig();
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature) return null;

  const expected = signPayload(encoded, signingSecret(config));
  if (!safeEqual(signature, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(fromB64url(encoded));
  } catch (_) {
    return null;
  }

  if (!payload?.u || !payload?.exp || Number(payload.exp) < Date.now()) return null;
  const user = (config.users || []).find(
    (item) => item.active !== false && safeEqual(item.username, payload.u)
  );
  if (!user) return null;

  return {
    username: user.username,
    name: user.name || user.username,
    expiresAt: Number(payload.exp),
  };
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function authenticate(username, password) {
  const config = loadConfig();
  const user = (config.users || []).find(
    (item) =>
      item.active !== false &&
      safeEqual(item.username, username) &&
      safeEqual(item.password, password)
  );
  return user || null;
}

function setSessionCookie(res, token) {
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/utils",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${8 * 60 * 60}`,
  ];
  if (isProd) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(res) {
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const attrs = [
    `${COOKIE_NAME}=`,
    "Path=/utils",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (isProd) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function requireUtilsAuth(req, res, next) {
  const cookies = parseCookies(req);
  const session = verifySessionToken(cookies[COOKIE_NAME]);
  if (!session) {
    return res.status(401).json({
      ok: false,
      error: "Sesión no válida o expirada.",
      authRequired: true,
    });
  }
  req.utilsUser = session;
  next();
}

function requireUtilsWriteHeader(req, res, next) {
  if (String(req.headers["x-utils-request"] || "") !== "1") {
    return res.status(403).json({ ok: false, error: "Solicitud administrativa no autorizada." });
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  authenticate,
  buildSessionToken,
  requireUtilsAuth,
  requireUtilsWriteHeader,
  setSessionCookie,
  clearSessionCookie,
};
