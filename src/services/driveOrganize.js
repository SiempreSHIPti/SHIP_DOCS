// src/services/driveOrganize.js
const mime = require("mime-types");
const { Readable } = require("stream");

const DRIVE_OPTS = { supportsAllDrives: true };

function esc(s) {
  return String(s || "").replace(/'/g, "\\'");
}

// Mantiene el nombre “humano” pero elimina chars inválidos para Drive/Windows
function sanitizeFolderName(name) {
  return String(name || "SIN_NOMBRE")
    .replace(/[\\\/:*?"<>|#%]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function findFolderByName(drive, parentId, name) {
  const q = [
    "mimeType = 'application/vnd.google-apps.folder'",
    `'${parentId}' in parents`,
    `name = '${esc(name)}'`,
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

const folderCache = new Map();

async function ensurePersonFolder(drive, parentId, folderName) {
  const safe = sanitizeFolderName(folderName);
  const cacheKey = `${parentId}_${safe}`;
  
  // 1. Revisar caché en memoria (evita latencia de indexación de Google Drive)
  if (folderCache.has(cacheKey)) {
    return folderCache.get(cacheKey);
  }

  // 2. Revisar si ya existe en Drive
  const existing = await findFolderByName(drive, parentId, safe);
  if (existing) {
    folderCache.set(cacheKey, existing.id);
    return existing.id;
  }

  // 3. Crear nuevo si no existe
  const created = await drive.files.create({
    ...DRIVE_OPTS,
    requestBody: {
      name: safe,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
  });

  folderCache.set(cacheKey, created.data.id);
  return created.data.id;
}

async function listFolderFiles(drive, folderId) {
  const r = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(id,name,mimeType)",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 1000,
  });
  return r.data.files || [];
}

async function deleteFile(drive, fileId) {
  try {
    await drive.files.delete({ ...DRIVE_OPTS, fileId });
  } catch (_) {}
}

/**
 * Sube archivo al folderId.
 * Si existe otro con mismo baseName (sin extensión), lo reemplaza.
 */
async function replaceAndUpload(drive, folderId, buffer, mimeType, baseName) {
  const base = sanitizeFolderName(baseName);
  const files = await listFolderFiles(drive, folderId);

  for (const f of files) {
    const withoutExt = f.name.replace(/\.[^./]+$/, "");
    if (withoutExt === base) {
      await deleteFile(drive, f.id);
    }
  }

  const extGuess = mime.extension(mimeType);
  const finalName = extGuess ? `${base}.${extGuess}` : base;

  const stream = Readable.from(buffer);

  const r = await drive.files.create({
    ...DRIVE_OPTS,
    requestBody: {
      name: finalName,
      parents: [folderId],
      mimeType: mimeType || "application/octet-stream",
    },
    media: {
      mimeType: mimeType || "application/octet-stream",
      body: stream,
    },
    fields: "id,name,webViewLink,webContentLink",
  });

  return (
    r.data.webViewLink ||
    r.data.webContentLink ||
    `https://drive.google.com/file/d/${r.data.id}/view`
  );
}

module.exports = {
  ensurePersonFolder,
  replaceAndUpload,
};
