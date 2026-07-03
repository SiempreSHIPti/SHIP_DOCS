// src/services/localExcelArchive.js
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const mime = require("mime-types");
const { ENV } = require("../config/env");

const FILE_FIELDS = [
  "selfie",
  "estado_cuenta",
  "ine_frontal",
  "ine_reverso",
  "curp",
  "nss_file",
  "constancia",
  "acta",
  "comprobante",
  "licencia",
  "tarjeta",
  "poliza",
];

const FIELD_LABELS = {
  selfie: "Foto personal",
  estado_cuenta: "Estado de cuenta",
  ine_frontal: "INE frontal",
  ine_reverso: "INE reverso",
  curp: "CURP",
  nss_file: "Documento NSS",
  constancia: "Constancia fiscal",
  acta: "Acta nacimiento",
  comprobante: "Comprobante domicilio",
  licencia: "Licencia",
  tarjeta: "Tarjeta circulación",
  poliza: "Póliza seguro",
};

const HEADER_DEFINITIONS = [
  ["createdAt", "Fecha registro"],
  ["jobId", "Job ID"],
  ["credentialId", "ID credencial"],
  ["nombre", "Nombre completo"],
  ["telefono", "Teléfono"],
  ["direccion", "Dirección"],
  ["banco", "Banco"],
  ["clabeMode", "Modo CLABE"],
  ["clabeTxt", "CLABE"],
  ["nssMode", "Modo NSS"],
  ["nssNum", "NSS"],
  ["ref1Nombre", "Referencia 1"],
  ["ref1Tel", "Teléfono ref. 1"],
  ["ref2Nombre", "Referencia 2"],
  ["ref2Tel", "Teléfono ref. 2"],
  ["aiStatus", "Estado revisión IA"],
  ["aiApproved", "Docs aprobados"],
  ["aiRejected", "Docs rechazados"],
  ["aiWarnings", "Docs con observación"],
  ["aiMissing", "Docs faltantes"],
  ["aiSkipped", "Docs omitidos"],
  ["selfiePath", "Ruta foto personal"],
  ["estadoCuentaPath", "Ruta estado de cuenta"],
  ["ineFrontalPath", "Ruta INE frontal"],
  ["ineReversoPath", "Ruta INE reverso"],
  ["curpPath", "Ruta CURP"],
  ["nssFilePath", "Ruta documento NSS"],
  ["constanciaPath", "Ruta constancia fiscal"],
  ["actaPath", "Ruta acta nacimiento"],
  ["comprobantePath", "Ruta comprobante domicilio"],
  ["licenciaPath", "Ruta licencia"],
  ["tarjetaPath", "Ruta tarjeta circulación"],
  ["polizaPath", "Ruta póliza seguro"],
  ["credentialPdfPath", "Ruta credencial PDF"],
  ["excelPath", "Ruta Excel"],
  ["reviewJson", "Resumen revisión IA JSON"],
];

const FIELD_TO_ROW_KEY = {
  selfie: "selfiePath",
  estado_cuenta: "estadoCuentaPath",
  ine_frontal: "ineFrontalPath",
  ine_reverso: "ineReversoPath",
  curp: "curpPath",
  nss_file: "nssFilePath",
  constancia: "constanciaPath",
  acta: "actaPath",
  comprobante: "comprobantePath",
  licencia: "licenciaPath",
  tarjeta: "tarjetaPath",
  poliza: "polizaPath",
};

function safePart(value, fallback = "SIN_DATO") {
  const clean = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  return clean || fallback;
}

function nowMxIsoLike() {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date()).replace(",", "");
  } catch {
    return new Date().toISOString();
  }
}

function archiveRoot() {
  return path.resolve(process.cwd(), ENV.LOCAL_RECORDS_DIR || ".local-records");
}

function excelPath() {
  return path.join(archiveRoot(), ENV.LOCAL_RECORDS_EXCEL_NAME || "ship_documentos.xlsx");
}

function relativeUrl(absPath) {
  const root = archiveRoot();
  const rel = path.relative(root, absPath).split(path.sep).map(encodeURIComponent).join("/");
  return `/local-records/${rel}`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function normalizeBody(body = {}) {
  const get = (...keys) => {
    for (const key of keys) {
      const value = body[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
    }
    return "";
  };

  return {
    nombre: get("nombre").toUpperCase(),
    telefono: get("telefono").replace(/\D/g, "").slice(0, 10),
    direccion: get("direccion"),
    banco: get("banco").toUpperCase(),
    clabeMode: get("clabe_mode"),
    clabeTxt: get("clabe", "clabeTxt").replace(/\D/g, "").slice(0, 18),
    nssMode: get("nss_mode"),
    nssNum: get("nss_num", "nssNum").replace(/\D/g, "").slice(0, 11),
    ref1Nombre: get("ref1_nombre", "ref1Nombre").toUpperCase(),
    ref1Tel: get("ref1_tel", "ref1Tel").replace(/\D/g, "").slice(0, 10),
    ref2Nombre: get("ref2_nombre", "ref2Nombre").toUpperCase(),
    ref2Tel: get("ref2_tel", "ref2Tel").replace(/\D/g, "").slice(0, 10),
  };
}

function getUploadedFile(files, fieldName) {
  return (files?.[fieldName] || [])[0] || null;
}

async function saveUploadedFiles({ jobId, nombre, files }) {
  const dirName = `${safePart(nombre)}_${safePart(jobId).slice(0, 12)}`;
  const uploadDir = path.join(archiveRoot(), "uploads", dirName);
  await ensureDir(uploadDir);

  const paths = {};

  for (const fieldName of FILE_FIELDS) {
    const file = getUploadedFile(files, fieldName);
    if (!file?.buffer) continue;

    const extFromMime = mime.extension(file.mimetype || "");
    const originalExt = path.extname(file.originalname || "").replace(".", "");
    const ext = extFromMime || originalExt || "bin";
    const fileName = `${safePart(fieldName)}_${safePart(file.originalname || fieldName)}.${ext}`.replace(/(\.[^.]+)\.\1$/i, "$1");
    const abs = path.join(uploadDir, fileName);

    await fs.writeFile(abs, file.buffer);
    paths[fieldName] = {
      absolutePath: abs,
      relativePath: path.relative(process.cwd(), abs),
      url: relativeUrl(abs),
      originalName: file.originalname || fileName,
      mimeType: file.mimetype || "",
      sizeBytes: file.size || file.buffer.length || 0,
    };
  }

  return paths;
}

function createCredentialPdf({ jobId, credentialId, bodyData, reviewSummary }) {
  return new Promise(async (resolve, reject) => {
    try {
      const credentialsDir = path.join(archiveRoot(), "credentials");
      await ensureDir(credentialsDir);

      const fileName = `${safePart(credentialId)}_${safePart(bodyData.nombre)}.pdf`;
      const abs = path.join(credentialsDir, fileName);

      const doc = new PDFDocument({
        size: "A4",
        margin: 46,
        info: {
          Title: `Credencial ${credentialId}`,
          Author: "SHIP Drivers360",
          Subject: "Credencial de driver",
        },
      });

      const stream = fssync.createWriteStream(abs);
      doc.pipe(stream);

      doc
        .rect(0, 0, doc.page.width, 96)
        .fill("#151518");

      doc
        .fillColor("#f80020")
        .fontSize(28)
        .font("Helvetica-Bold")
        .text("SHIP", 46, 34, { continued: true })
        .fillColor("#ffffff")
        .text(" Drivers360");

      doc
        .moveDown(2)
        .fillColor("#111827")
        .fontSize(20)
        .font("Helvetica-Bold")
        .text("Credencial de Driver", 46, 130);

      doc
        .fontSize(10)
        .fillColor("#6b7280")
        .text(`Generada: ${nowMxIsoLike()}`, 46, 158)
        .text(`Job ID: ${jobId}`, 46, 174)
        .text(`ID credencial: ${credentialId}`, 46, 190);

      doc
        .roundedRect(46, 225, 500, 190, 14)
        .strokeColor("#e5e7eb")
        .lineWidth(1)
        .stroke();

      doc
        .fillColor("#111827")
        .fontSize(13)
        .font("Helvetica-Bold")
        .text("Nombre", 70, 250)
        .font("Helvetica")
        .fontSize(18)
        .text(bodyData.nombre || "SIN NOMBRE", 70, 270, { width: 450 });

      doc
        .fontSize(11)
        .fillColor("#374151")
        .text(`Teléfono: ${bodyData.telefono || "N/A"}`, 70, 318)
        .text(`Banco: ${bodyData.banco || "N/A"}`, 70, 336)
        .text(`NSS: ${bodyData.nssNum || "N/A"}`, 70, 354)
        .text(`Estado IA: ${reviewSummary?.canContinue ? "APROBADO" : "CON OBSERVACIONES"}`, 70, 372);

      doc
        .roundedRect(46, 445, 500, 90, 14)
        .fillAndStroke("#f9fafb", "#e5e7eb");

      doc
        .fillColor("#111827")
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("Resumen de revisión documental", 70, 466)
        .font("Helvetica")
        .fontSize(10)
        .text(`Aprobados: ${reviewSummary?.approved ?? 0}`, 70, 490)
        .text(`Rechazados: ${reviewSummary?.rejected ?? 0}`, 190, 490)
        .text(`Faltantes: ${reviewSummary?.missing ?? 0}`, 315, 490)
        .text(`Omitidos: ${reviewSummary?.skipped ?? 0}`, 430, 490);

      doc
        .fillColor("#6b7280")
        .fontSize(9)
        .text("Documento generado para pruebas locales. No sustituye validación operativa final.", 46, 760, {
          align: "center",
          width: 500,
        });

      doc.end();

      stream.on("finish", () => resolve({
        absolutePath: abs,
        relativePath: path.relative(process.cwd(), abs),
        url: relativeUrl(abs),
      }));
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}

async function loadWorkbookOrCreate() {
  const xlsxPath = excelPath();
  await ensureDir(path.dirname(xlsxPath));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SHIP Drivers360";
  workbook.created = new Date();

  if (fssync.existsSync(xlsxPath)) {
    await workbook.xlsx.readFile(xlsxPath);
  }

  let sheet = workbook.getWorksheet("Registros");
  if (!sheet) {
    sheet = workbook.addWorksheet("Registros", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
  }

  if (sheet.rowCount === 0 || !sheet.getRow(1).getCell(1).value) {
    sheet.columns = HEADER_DEFINITIONS.map(([key, header]) => ({
      key,
      header,
      width: Math.min(Math.max(header.length + 4, 16), 38),
    }));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF151518" },
    };
    headerRow.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    headerRow.height = 26;
  } else {
    sheet.columns = HEADER_DEFINITIONS.map(([key, header], index) => ({
      key,
      header,
      width: sheet.getColumn(index + 1).width || Math.min(Math.max(header.length + 4, 16), 38),
    }));
  }

  return { workbook, sheet, xlsxPath };
}

async function appendExcelRow({ jobId, credentialId, bodyData, filePaths, credentialPdf, reviewPayload }) {
  const { workbook, sheet, xlsxPath } = await loadWorkbookOrCreate();

  const summary = reviewPayload?.summary || {};
  const row = {
    createdAt: nowMxIsoLike(),
    jobId,
    credentialId,
    nombre: bodyData.nombre,
    telefono: bodyData.telefono,
    direccion: bodyData.direccion,
    banco: bodyData.banco,
    clabeMode: bodyData.clabeMode,
    clabeTxt: bodyData.clabeTxt,
    nssMode: bodyData.nssMode,
    nssNum: bodyData.nssNum,
    ref1Nombre: bodyData.ref1Nombre,
    ref1Tel: bodyData.ref1Tel,
    ref2Nombre: bodyData.ref2Nombre,
    ref2Tel: bodyData.ref2Tel,
    aiStatus: summary.canContinue ? (summary.warnings ? "APROBADO_CON_OBSERVACIONES" : "APROBADO") : "CON_ERRORES",
    aiApproved: summary.approved || 0,
    aiRejected: summary.rejected || 0,
    aiWarnings: summary.warnings || 0,
    aiMissing: summary.missing || 0,
    aiSkipped: summary.skipped || 0,
    credentialPdfPath: credentialPdf.relativePath,
    excelPath: path.relative(process.cwd(), xlsxPath),
    reviewJson: JSON.stringify(reviewPayload || {}),
  };

  for (const [fieldName, rowKey] of Object.entries(FIELD_TO_ROW_KEY)) {
    row[rowKey] = filePaths[fieldName]?.relativePath || "";
  }

  const added = sheet.addRow(row);
  added.alignment = { vertical: "top", wrapText: true };

  const reviewCol = HEADER_DEFINITIONS.findIndex(([key]) => key === "reviewJson") + 1;
  sheet.getColumn(reviewCol).width = 55;

  for (const col of [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33]) {
    sheet.getColumn(col).width = 36;
  }

  sheet.autoFilter = {
    from: "A1",
    to: `${sheet.getColumn(HEADER_DEFINITIONS.length).letter}1`,
  };

  await workbook.xlsx.writeFile(xlsxPath);

  return {
    absolutePath: xlsxPath,
    relativePath: path.relative(process.cwd(), xlsxPath),
    url: relativeUrl(xlsxPath),
    rowNumber: added.number,
  };
}

async function saveRegistrationToLocalExcel({ jobId, body, files, reviewPayload }) {
  const bodyData = normalizeBody(body);
  const createdAtCompact = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const credentialId = `SHIP-${createdAtCompact}-${String(jobId || Date.now()).slice(0, 8).toUpperCase()}`;

  await ensureDir(archiveRoot());

  const filePaths = await saveUploadedFiles({
    jobId,
    nombre: bodyData.nombre || "SIN_NOMBRE",
    files,
  });

  const credentialPdf = await createCredentialPdf({
    jobId,
    credentialId,
    bodyData,
    reviewSummary: reviewPayload?.summary || {},
  });

  const excel = await appendExcelRow({
    jobId,
    credentialId,
    bodyData,
    filePaths,
    credentialPdf,
    reviewPayload,
  });

  return {
    ok: true,
    jobId,
    credentialId,
    excel,
    credentialPdf,
    filePaths,
  };
}

module.exports = {
  FILE_FIELDS,
  FIELD_LABELS,
  saveRegistrationToLocalExcel,
};
