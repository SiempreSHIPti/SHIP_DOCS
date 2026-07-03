// src/services/drive.js
const mime = require("mime-types");
const { Readable } = require("stream");
const { escSingleQuotes, sanitizeFileBase } = require("../utils/strings");

// Busca folder por nombre EXACTO dentro del parent
async function findFolderByName(drive, parentId, name) {
  const q = [
    "mimeType = 'application/vnd.google-apps.folder'",
    `'${parentId}' in parents`,
    `name = '${escSingleQuotes(name)}'`,
    "trashed = false",
  ].join(" and ");

  const r = await drive.files.list({
    q,
    fields: "files(id,name)",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 10,
  });

  return (r.data.files && r.data.files[0]) || null;
}

async function ensurePersonFolder(drive, parentId, folderName) {
  const safe = sanitizeFileBase(folderName || "SIN_NOMBRE");

  const existing = await findFolderByName(drive, parentId, safe);
  if (existing) return existing.id;

  const created = await drive.files.create({
    requestBody: {
      name: safe,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });

  return created.data.id;
}

// En lugar de listar TODO el folder (pageSize 1000), hacemos búsqueda acotada por baseName
async function findFileByBaseName(drive, folderId, base) {
  // 1) Buscar EXACTO: name = 'BASE' (por si alguien subió sin extensión)
  const q1 = [
    `'${folderId}' in parents`,
    "trashed = false",
    `name = '${escSingleQuotes(base)}'`,
  ].join(" and ");

  const r1 = await drive.files.list({
    q: q1,
    fields: "files(id,name,mimeType,webViewLink,webContentLink)",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 1,
  });

  if (r1.data.files?.[0]) return r1.data.files[0];

  // 2) Fallback: name contains base, pero filtrado estricto por sin-ext === base
  const q2 = [
    `'${folderId}' in parents`,
    "trashed = false",
    `name contains '${escSingleQuotes(base)}'`,
  ].join(" and ");

  const r2 = await drive.files.list({
    q: q2,
    fields: "files(id,name,mimeType,webViewLink,webContentLink)",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 20,
  });

  const files = r2.data.files || [];
  const match = files.find((f) => f.name.replace(/\.[^./]+$/, "") === base);
  return match || null;
}

// Upsert: si existe -> update; si no existe -> create
async function replaceAndUpload(drive, folderId, buffer, mimeType, baseName) {
  const base = sanitizeFileBase(baseName);
  const extGuess = mime.extension(mimeType);
  const finalName = extGuess ? `${base}.${extGuess}` : base;

  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);

  const existing = await findFileByBaseName(drive, folderId, base);

  if (existing?.id) {
    const r = await drive.files.update({
      fileId: existing.id,
      requestBody: { name: finalName, mimeType: mimeType || "application/octet-stream" },
      media: { mimeType: mimeType || "application/octet-stream", body: stream },
      fields: "id,name,webViewLink,webContentLink",
      supportsAllDrives: true,
    });

    return r.data.webViewLink || r.data.webContentLink || `https://drive.google.com/file/d/${r.data.id}/view`;
  }

  const r = await drive.files.create({
    requestBody: {
      name: finalName,
      parents: [folderId],
      mimeType: mimeType || "application/octet-stream",
    },
    media: { mimeType: mimeType || "application/octet-stream", body: stream },
    fields: "id,name,webViewLink,webContentLink",
    supportsAllDrives: true,
  });

  return r.data.webViewLink || r.data.webContentLink || `https://drive.google.com/file/d/${r.data.id}/view`;
}

module.exports = { ensurePersonFolder, replaceAndUpload };
