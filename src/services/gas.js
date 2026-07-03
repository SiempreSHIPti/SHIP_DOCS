// src/services/gas.js
const axios = require("axios");
const { ENV } = require("../config/env");

function looksLikeHtml(body, ctype) {
  const preview = (typeof body === "string" ? body : JSON.stringify(body || {})).slice(0, 200);
  if (/text\/html/i.test(ctype)) return true;
  if (/^\s*<!doctype html>/i.test(preview)) return true;
  if (/accounts\.google\.com|Sign in|<title>.*Google/i.test(preview)) return true;
  return false;
}

async function callGAS_POST(payload) {
  return axios.post(ENV.APPS_SCRIPT_WEBAPP_URL, payload, {
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": ENV.APPS_SCRIPT_SHARED_SECRET || "" },
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: () => true,
  });
}

async function callGAS_GET(payload) {
  const qs = new URLSearchParams({
    fn: payload.fn,
    secret: payload.secret || "",
    payload: JSON.stringify(payload.payload || null),
  });
  const url = `${ENV.APPS_SCRIPT_WEBAPP_URL}?${qs.toString()}`;

  return axios.get(url, { timeout: 20000, maxRedirects: 5, validateStatus: () => true });
}

async function triggerAppsScriptWebApp(params) {
  if (!ENV.APPS_SCRIPT_WEBAPP_URL) throw new Error("APPS_SCRIPT_WEBAPP_URL no configurada");

  const payload = { fn: "ejecutarExtraccionINE", secret: ENV.APPS_SCRIPT_SHARED_SECRET || "", payload: params };

  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await callGAS_POST(payload);
      const ctype = String(r.headers["content-type"] || r.headers["Content-Type"] || "");
      const bodyPreview = (typeof r.data === "string" ? r.data : JSON.stringify(r.data || {})).slice(0, 300);
      console.log(`[GAS][POST] intento ${i + 1} status=${r.status} ctype=${ctype} body=${bodyPreview}`);

      if (!looksLikeHtml(r.data, ctype) && r.status >= 200 && r.status < 300) {
        const data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
        if (data && data.ok === true) return { ok: true, via: "POST" };
        lastErr = new Error(`POST 2xx pero sin ok:true: ${bodyPreview}`);
      } else {
        lastErr = new Error(`POST no válido (HTML/redirect o HTTP ${r.status})`);
      }
    } catch (e) {
      lastErr = new Error(`POST error: ${e?.message || e}`);
    }

    try {
      const r = await callGAS_GET(payload);
      const ctype = String(r.headers["content-type"] || r.headers["Content-Type"] || "");
      const bodyPreview = (typeof r.data === "string" ? r.data : JSON.stringify(r.data || {})).slice(0, 300);
      console.log(`[GAS][GET ] intento ${i + 1} status=${r.status} ctype=${ctype} body=${bodyPreview}`);

      if (!looksLikeHtml(r.data, ctype) && r.status >= 200 && r.status < 300) {
        const data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
        if (data && data.ok === true) return { ok: true, via: "GET" };
        lastErr = new Error(`GET 2xx pero sin ok:true: ${bodyPreview}`);
      } else {
        lastErr = new Error(`GET no válido (HTML/redirect o HTTP ${r.status})`);
      }
    } catch (e) {
      lastErr = new Error(`GET error: ${e?.message || e}`);
    }

    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }

  throw lastErr || new Error("No se pudo invocar Apps Script.");
}

module.exports = { looksLikeHtml, callGAS_POST, callGAS_GET, triggerAppsScriptWebApp };
