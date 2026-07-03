// src/services/credential.js
"use strict";

const { Readable } = require("stream");
const { ENV } = require("../config/env");

// Shared Drives / Unidades compartidas
const DRIVE_OPTS = { supportsAllDrives: true };

// ===== Reglas de validación (MX) =====
const RFC_RE = /\b[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}\b/;
const CURP_RE = /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/;
const NSS_RE = /^\d{11}$/;

// ===== Debug opcional =====
const DEBUG = String(process.env.DEBUG_CRED || "").trim() === "1";
function dlog(...args) {
  if (DEBUG) console.log("[credential]", ...args);
}

// ===== Helpers string =====
function stripAccents(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function toUpperClean(s) {
  return stripAccents(String(s || ""))
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}
function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}
function safeFileName(s) {
  return String(s || "SIN_NOMBRE")
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}
function wrapNombre(nombre) {
  const clean = String(nombre || "").trim().replace(/\s+/g, " ");
  if (clean.length <= 26) return clean;

  const cut = 26;
  const left = clean.slice(0, cut);
  const idx = left.lastIndexOf(" ");
  const splitAt = idx > 10 ? idx : cut;

  const line1 = clean.slice(0, splitAt).trim();
  const line2 = clean.slice(splitAt).trim();
  return `${line1}\n${line2}`;
}
function slugPart(s) {
  return stripAccents(String(s || ""))
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .toUpperCase()
    .slice(0, 30);
}
function buildCrePhotoName(fullName) {
  // Regla: CRE_<nombre>_<APELLIDO>_<timestamp>.jpg
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  const first = parts[0] || "SINNOMBRE";
  const last = parts.length > 1 ? parts[parts.length - 1] : "SINAPELLIDO";
  const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "_");
  return `CRE_${slugPart(first)}_${slugPart(last)}_${ts}.jpg`;
}

// ===== Drive helpers =====

// Extrae fileId de links típicos de Drive
function extractDriveFileId(url) {
  const u = String(url || "").trim();
  if (!u) return "";

  const m1 = u.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m1?.[1]) return m1[1];

  const m2 = u.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m2?.[1]) return m2[1];

  const m3 = u.match(/uc\?id=([a-zA-Z0-9_-]{10,})/);
  if (m3?.[1]) return m3[1];

  if (/^[a-zA-Z0-9_-]{10,}$/.test(u)) return u;

  return "";
}

async function downloadDriveFileBuffer(drive, fileId) {
  const res = await drive.files.get(
    { ...DRIVE_OPTS, fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

function isNotFound(e) {
  const st = e?.response?.status;
  const code = e?.code;
  return st === 404 || code === 404;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Confirma folder + devuelve meta (incluye driveId si es Shared Drive)
async function assertFolderInSharedDrive(drive, folderId, label) {
  const meta = await drive.files.get({
    ...DRIVE_OPTS,
    fileId: folderId,
    fields: "id,name,mimeType,driveId,capabilities",
  });

  if (meta?.data?.mimeType !== "application/vnd.google-apps.folder") {
    throw new Error(`${label} no es carpeta: ${folderId}`);
  }
  if (!meta?.data?.driveId) {
    throw new Error(
      `${label} NO está en Shared Drive (driveId vacío). ` +
      `Con Service Account esto provoca "no storage quota". Mueve esa carpeta a una Unidad Compartida.`
    );
  }
  return meta.data;
}

/**
 * Borrado DURO con reintentos + verificación (debe terminar en 404 al hacer get).
 * Si delete falla, intenta trashed=true y vuelve a intentar delete.
 */
async function deleteHard(drive, fileId, label = "temp") {
  if (!fileId) return { ok: true, skipped: true };

  let lastErr = null;

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      dlog("deleteHard attempt", attempt + 1, label, fileId);

      // 1) Mover a papelera (lo importante: desaparece de la carpeta)
      try {
        await drive.files.update({
          ...DRIVE_OPTS,
          fileId,
          requestBody: { trashed: true },
          fields: "id, trashed",
        });
      } catch (eTrash) {
        if (isNotFound(eTrash)) return { ok: true, alreadyGone: true };
        lastErr = eTrash;
      }

      // 2) Intentar borrado duro (si el rol lo permite)
      try {
        await drive.files.delete({ ...DRIVE_OPTS, fileId });
      } catch (eDel) {
        // Si no se puede hard-delete, al menos ya está trashed
        lastErr = eDel;
      }

      await sleep(250 + attempt * 300);

      // 3) Verificación: 404 (ya no existe) o trashed=true (suficiente)
      try {
        const g = await drive.files.get({
          ...DRIVE_OPTS,
          fileId,
          fields: "id, trashed",
        });
        if (g?.data?.trashed) return { ok: true, trashed: true };
        // si sigue sin trashed, reintenta
      } catch (e2) {
        if (isNotFound(e2)) return { ok: true, deleted: true };
        lastErr = e2;
      }
    } catch (e) {
      if (isNotFound(e)) return { ok: true, alreadyGone: true };
      lastErr = e;
    }
  }

  const msg = lastErr?.response?.data?.error?.message || lastErr?.message || String(lastErr);
  throw new Error(`No se pudo borrar/trashear ${label} (${fileId}): ${msg}`);
}


// Sube foto temporal (para que Slides la consuma) -> luego se BORRA
async function uploadTempPhoto({ drive, folderId, buffer, mimeType, fileName }) {
  const createRes = await drive.files.create({
    ...DRIVE_OPTS,
    requestBody: { name: fileName, parents: [folderId], mimeType: mimeType || "image/jpeg" },
    media: { mimeType: mimeType || "image/jpeg", body: Readable.from(buffer) },
    fields: "id,name",
  });

  const fileId = createRes.data.id;

  // Permiso temporal “anyone” para que Slides lea la imagen por URL
  await drive.permissions.create({
    ...DRIVE_OPTS,
    fileId,
    requestBody: { type: "anyone", role: "reader" },
  });

  return { fileId, imageUrl: `https://drive.google.com/uc?id=${fileId}` };
}

async function exportPdfBuffer({ drive, presentationId }) {
  const res = await drive.files.export(
    { ...DRIVE_OPTS, fileId: presentationId, mimeType: "application/pdf" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

function escDriveQ(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function deleteExistingByNameInFolder(drive, folderId, fileName, driveId) {
  const q = [
    `'${folderId}' in parents`,
    `name = '${escDriveQ(fileName)}'`,
    "trashed = false",
  ].join(" and ");

  const res = await drive.files.list({
    ...DRIVE_OPTS,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId,
    q,
    fields: "files(id,name)",
    pageSize: 100,
  });

  const files = res.data.files || [];
  for (const f of files) {
    await deleteHard(drive, f.id, `existing:${f.name}`).catch(() => { });
  }
}

// ===== Validaciones: TODO viene del Sheet =====
function normalizeCredentialRow(row) {
  const nombre = toUpperClean(row.nombre);
  const puesto = toUpperClean(row.puesto || ENV.PUESTO_DEFAULT || "OPERADOR");
  const rfc = toUpperClean(row.rfc);
  const curp = toUpperClean(row.curp);
  const nss = digitsOnly(row.nss);
  const selfieLink = String(row.selfieLink || "").trim();
  return { nombre, puesto, rfc, curp, nss, selfieLink };
}

function validateCredentialRow(row) {
  const x = normalizeCredentialRow(row);
  const errors = [];

  if (!x.nombre) errors.push("NOMBRE");
  if (!x.puesto) errors.push("PUESTO");

  if (!x.rfc) errors.push("RFC");
  else if (!RFC_RE.test(x.rfc)) errors.push("RFC_INVALIDO");

  if (!x.curp) errors.push("CURP_INE");
  else if (!CURP_RE.test(x.curp)) errors.push("CURP_INVALIDA");

  if (!x.nss) errors.push("NSS");
  else if (!NSS_RE.test(x.nss)) errors.push("NSS_INVALIDO");

  if (!x.selfieLink) errors.push("FOTO");
  else {
    const selfieId = extractDriveFileId(x.selfieLink);
    if (!selfieId) errors.push("FOTO_LINK_INVALIDO");
  }

  return { ok: errors.length === 0, errors, normalized: x };
}

/**
 * Limpieza de huérfanos en carpeta TEMP.
 * Borra solo archivos que empiecen con:
 * - TMP_CRED_
 * - CRE_
 * y que sean más viejos que olderThanMinutes (si olderThanMinutes=0 borra todos).
 */
async function cleanupTempFolderOrphans({ drive, folderId, olderThanMinutes = 30 } = {}) {
  const tmpId = folderId || ENV.CRED_TMP_FOLDER_ID;
  if (!tmpId) return { ok: true, scanned: 0, deleted: 0, errors: [], skipped: true };

  const meta = await assertFolderInSharedDrive(drive, tmpId, "CRED_TMP_FOLDER_ID");
  const driveId = meta.driveId;

  const cutoffMs = Date.now() - Math.max(0, Number(olderThanMinutes || 0)) * 60 * 1000;

  let pageToken = undefined;
  let scanned = 0;
  let deleted = 0;
  const errors = [];

  do {
    const q = [`'${tmpId}' in parents`, "trashed = false"].join(" and ");

    const res = await drive.files.list({
      ...DRIVE_OPTS,
      includeItemsFromAllDrives: true,
      corpora: "drive",
      driveId,
      q,
      fields: "nextPageToken, files(id,name,createdTime,modifiedTime,capabilities(canDelete,canTrash))",
      pageSize: 200,
      pageToken,
    });

    const files = res.data.files || [];
    scanned += files.length;

    for (const f of files) {
      const name = String(f.name || "");
      const isOurs = name.startsWith("TMP_CRED_") || name.startsWith("CRE_");
      if (!isOurs) continue;

      const createdTime = f.createdTime ? Date.parse(f.createdTime) : 0;
      const isOldEnough = Number(olderThanMinutes || 0) <= 0 ? true : createdTime > 0 && createdTime < cutoffMs;

      if (!isOldEnough) continue;

      try {
        await deleteHard(drive, f.id, `orphan:${name}`);
        deleted++;
      } catch (e) {
        errors.push(e?.message || String(e));
      }
    }

    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return { ok: errors.length === 0, scanned, deleted, errors };
}

// Wrapper: soporta llamada "legacy" cleanupTempOrphans(drive, folderId, olderThanMinutes)
// y la nueva cleanupTempOrphans({ drive, folderId, olderThanMinutes })
function cleanupTempOrphans(arg1, arg2, arg3) {
  // legacy: (driveClient, folderId, minutes)
  if (arg1 && arg1.files && typeof arg1.files.list === "function") {
    return cleanupTempFolderOrphans({
      drive: arg1,
      folderId: arg2,
      olderThanMinutes: arg3,
    });
  }
  // nuevo: ( { drive, folderId, olderThanMinutes } )
  return cleanupTempFolderOrphans(arg1);
}

/**
 * Genera PDF de credencial tomando TODO del Sheet.
 *
 * Garantía:
 * - OUTPUT_FOLDER_ID: queda SOLO 1 PDF final.
 * - TEMP: se crean 2 temporales (foto + slides) pero se borran SIEMPRE.
 * - Si falla la limpieza: rollback del PDF final y se lanza ERROR.
 */
async function generateCredentialPdfFromRow({ row, drive, slides }) {
  const templateId = ENV.TEMPLATE_PRESENTATION_ID;
  const outputFolderId = ENV.OUTPUT_FOLDER_ID;
  const tmpFolderId = ENV.CRED_TMP_FOLDER_ID;

  if (!templateId || !outputFolderId) {
    return {
      ok: false,
      skipped: true,
      reason: "Credencial deshabilitada (faltan TEMPLATE_PRESENTATION_ID/OUTPUT_FOLDER_ID)",
    };
  }
  if (!tmpFolderId) {
    return {
      ok: false,
      skipped: true,
      reason: "Falta ENV.CRED_TMP_FOLDER_ID (carpeta TEMP obligatoria)",
    };
  }

  const v = validateCredentialRow(row);
  if (!v.ok) return { ok: false, skipped: true, reason: "Validación falló", errors: v.errors };

  const { nombre, puesto, rfc, curp, nss, selfieLink } = v.normalized;

  // Validar Shared Drive (evita “no storage quota”)
  const outMeta = await assertFolderInSharedDrive(drive, outputFolderId, "OUTPUT_FOLDER_ID");
  await assertFolderInSharedDrive(drive, tmpFolderId, "CRED_TMP_FOLDER_ID");
  const outDriveId = outMeta.driveId;

  let tempPhotoId = "";
  let tempPresId = "";
  let createdPdfId = "";

  try {
    // 1) Descargar selfie (origen)
    const selfieId = extractDriveFileId(selfieLink);
    const selfieBuf = await downloadDriveFileBuffer(drive, selfieId);

    // mimeType best-effort
    let selfieMime = "image/jpeg";
    try {
      const meta = await drive.files.get({
        ...DRIVE_OPTS,
        fileId: selfieId,
        fields: "mimeType,name",
      });
      if (meta?.data?.mimeType) selfieMime = meta.data.mimeType;
    } catch (_) { }

    // 2) Subir foto TEMP a TMP
    const photoTempName = buildCrePhotoName(nombre);
    const foto = await uploadTempPhoto({
      drive,
      folderId: tmpFolderId,
      buffer: selfieBuf,
      mimeType: selfieMime,
      fileName: photoTempName,
    });
    tempPhotoId = foto.fileId;

    // 3) Copiar plantilla a TMP (temporal)
    const safeName = safeFileName(nombre);
    const presTempName = `TMP_CRED_${safeName}_${Date.now()}`;

    const copyRes = await drive.files.copy({
      ...DRIVE_OPTS,
      fileId: templateId,
      requestBody: { name: presTempName, parents: [tmpFolderId] },
      fields: "id",
    });
    tempPresId = copyRes.data.id;

    // 4) Reemplazar tokens + foto
    await slides.presentations.batchUpdate({
      presentationId: tempPresId,
      requestBody: {
        requests: [
          {
            replaceAllText: {
              containsText: { text: "__DF_PUESTO__", matchCase: true },
              replaceText: puesto || "OPERADOR",
            },
          },
          {
            replaceAllText: {
              containsText: { text: "__DF_NOMBRE__", matchCase: true },
              replaceText: wrapNombre(nombre),
            },
          },
          { replaceAllText: { containsText: { text: "__DF_RFC__", matchCase: true }, replaceText: rfc } },
          { replaceAllText: { containsText: { text: "__DF_CURP__", matchCase: true }, replaceText: curp } },
          { replaceAllText: { containsText: { text: "__DF_NSS__", matchCase: true }, replaceText: nss } },
          {
            replaceAllShapesWithImage: {
              containsText: { text: "__DF_FOTO__", matchCase: true },
              imageUrl: foto.imageUrl,
              imageReplaceMethod: "CENTER_CROP",
            },
          },
        ],
      },
    });

    // 5) Export PDF (buffer)
    const pdfBuffer = await exportPdfBuffer({ drive, presentationId: tempPresId });

    // 6) Subir PDF FINAL a OUTPUT (UPsert por nombre, 1 archivo final)
    const pdfName = `Credencial_${safeName}.pdf`;
    await deleteExistingByNameInFolder(drive, outputFolderId, pdfName, outDriveId);

    const pdfCreate = await drive.files.create({
      ...DRIVE_OPTS,
      requestBody: {
        name: pdfName,
        parents: [outputFolderId],
        mimeType: "application/pdf",
      },
      media: { mimeType: "application/pdf", body: Readable.from(pdfBuffer) },
      fields: "id, webViewLink",
    });

    createdPdfId = pdfCreate.data.id;
    const pdfLink = pdfCreate.data.webViewLink || `https://drive.google.com/file/d/${createdPdfId}/view`;

    return { ok: true, pdfId: createdPdfId, pdfLink, derived: { puesto, rfc, curp, nss } };
  } finally {
    // Limpieza estricta: si falla, rollback del PDF para NO acumular nada
    const cleanupErrors = [];

    if (tempPhotoId) {
      try {
        await deleteHard(drive, tempPhotoId, "tempPhoto");
      } catch (e) {
        cleanupErrors.push(e?.message || String(e));
      }
    }

    if (tempPresId) {
      try {
        await deleteHard(drive, tempPresId, "tempPresentation");
      } catch (e) {
        cleanupErrors.push(e?.message || String(e));
      }
    }

    if (cleanupErrors.length) {
      if (createdPdfId) {
        try {
          await deleteHard(drive, createdPdfId, "finalPdfRollback");
        } catch (e2) {
          cleanupErrors.push(e2?.message || String(e2));
        }
      }
      throw new Error(`Cleanup TEMP falló: ${cleanupErrors.join(" | ")}`);
    }
  }
}

module.exports = {
  validateCredentialRow,
  normalizeCredentialRow,
  generateCredentialPdfFromRow,
  cleanupTempFolderOrphans,
  cleanupTempOrphans,
};
