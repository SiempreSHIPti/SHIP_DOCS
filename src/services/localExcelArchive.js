// src/services/localExcelArchive.js
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const mime = require("mime-types");
const { ENV } = require("../config/env");
const { evaluateCredentialEligibility } = require("./credentialEligibility");
const { normalizeClabe, isValidClabe, resolveBankName } = require("../utils/clabe");

const SHIP_CREDENTIAL_FRONT_TEMPLATE = path.join(__dirname, "../assets/credential/ship-credential-front-template.jpg");
const SHIP_CREDENTIAL_BACK_TEMPLATE = path.join(__dirname, "../assets/credential/ship-credential-back-template.jpg");

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
  ["tipoVacante", "Tipo de vacante"],
  ["nombre", "Nombre completo"],
  ["telefono", "Teléfono"],
  ["direccion", "Dirección"],
  ["banco", "Banco"],
  ["clabeMode", "Modo CLABE"],
  ["clabeTxt", "CLABE"],
  ["nssMode", "Modo NSS"],
  ["nssNum", "NSS"],
  ["rfc", "RFC"],
  ["curpTxt", "CURP"],
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
  ["rejectedDetail", "Detalle documentos rechazados"],
  ["warningsDetail", "Detalle documentos con observación"],
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

function findReviewRow(reviewPayload, fieldName) {
  return (reviewPayload?.results || []).find((row) => row.fieldName === fieldName) || null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}


function reviewText(...values) {
  return values
    .flat(Infinity)
    .filter(Boolean)
    .map((v) => typeof v === "object" ? JSON.stringify(v) : String(v))
    .join(" ");
}

function normalizeVacancyType(value) {
  const raw = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

  if (raw.includes("ayudante")) return "Ayudante";
  if (raw.includes("chofer")) return "Chofer";
  if (raw.includes("driver")) return "Driver";
  return "";
}

function normalizeBankName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .slice(0, 80);
}

function extractClabeFromText(value) {
  const text = String(value || "");
  if (!text.trim()) return "";

  const candidates = [];
  const contextual = text.match(/(?:CLABE|CLABE INTERBANCARIA|CUENTA CLABE|INTERBANCARIA)[^\d]*(\d[\d\s-]{16,34}\d)/i);
  if (contextual?.[1]) candidates.push(normalizeClabe(contextual[1]));

  const contiguous = text.match(/\b\d{18}\b/);
  if (contiguous?.[0]) candidates.push(normalizeClabe(contiguous[0]));

  const compact = text.replace(/[^\d]/g, "");
  const mostlyDigits = text.replace(/[\d\s-]/g, "").trim().length <= 3;
  if (mostlyDigits && compact.length >= 18) candidates.push(normalizeClabe(compact));

  return candidates.find((candidate) => isValidClabe(candidate)) || "";
}

function getEstadoCuentaRow(reviewPayload = {}) {
  const rows = reviewPayload?.results || [];
  return rows.find((row) => row?.fieldName === "estado_cuenta") || null;
}

function extractBankFromReview(reviewPayload = {}) {
  const row = getEstadoCuentaRow(reviewPayload);
  const fields = row?.fields || {};
  return normalizeBankName(
    fields.banco ||
    fields.bank ||
    fields.institucion ||
    fields.institucion_bancaria ||
    fields.entidad_financiera ||
    fields.emisor ||
    fields.banco_emisor ||
    ""
  );
}

function extractClabeFromReview(reviewPayload = {}) {
  const row = getEstadoCuentaRow(reviewPayload);
  const fields = row?.fields || {};
  const direct = [
    fields.clabe,
    fields.clabe_interbancaria,
    fields.clabeInterbancaria,
    fields.cuenta_clabe,
    fields.cuentaClabe,
    fields.clabe_o_cuenta,
    fields.cuenta,
    fields.numero_cuenta,
    fields.account,
  ];

  for (const candidate of direct) {
    const clabe = extractClabeFromText(candidate);
    if (clabe) return clabe;
  }

  return extractClabeFromText(reviewText(
    row?.summary,
    row?.nameFound,
    row?.documentTypeDetected,
    row?.fields,
    row?.issues,
    row?.warnings
  ));
}


function normalizeCurp(value) {
  const text = String(value || "").toUpperCase();
  const match = text.match(/[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d/);
  return match ? match[0] : text.replace(/[^A-Z0-9]/g, "").slice(0, 18);
}

function normalizeRfc(value) {
  const text = String(value || "").toUpperCase();
  const match = text.match(/[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}/);
  return match ? match[0] : text.replace(/[^A-Z0-9Ñ&]/g, "").slice(0, 13);
}

function normalizeNss(value) {
  const text = String(value || "");
  const match = text.match(/\b\d{11}\b/);
  if (match) return match[0];
  const digits = text.replace(/\D/g, "");
  if (digits.length >= 11) return digits.slice(0, 11);
  // En NSS reales puede existir cero inicial; si IA lo cortó y quedan 10 dígitos, lo restauramos.
  if (digits.length === 10) return `0${digits}`;
  return digits.slice(0, 11);
}


function reviewRowLabel(row = {}) {
  return row.label || FIELD_LABELS?.[row.fieldName] || row.fieldName || "Documento";
}

function reviewRowReasons(row = {}) {
  const parts = [
    row.summary,
    ...(Array.isArray(row.issues) ? row.issues : []),
    ...(Array.isArray(row.warnings) ? row.warnings : []),
  ]
    .filter(Boolean)
    .map((x) => String(x).replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return [...new Set(parts)].slice(0, 2).join(" | ");
}

function detailRowsByStatus(reviewPayload = {}, kind = "rejected") {
  const rows = Array.isArray(reviewPayload?.results) ? reviewPayload.results : [];
  return rows
    .filter((row) => {
      const status = String(row?.status || "").toLowerCase();
      const severity = String(row?.severity || "").toLowerCase();
      if (kind === "rejected") return row?.ok === false || status === "rejected" || status === "missing" || severity === "error";
      if (kind === "warning") return status === "warning" || severity === "warning";
      return false;
    })
    .map((row) => {
      const reason = reviewRowReasons(row);
      return reason ? `${reviewRowLabel(row)}: ${reason}` : reviewRowLabel(row);
    })
    .join("\n");
}


function normalizeBody(body = {}, reviewPayload = {}) {
  const get = (...keys) => {
    for (const key of keys) {
      const value = body[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
    }
    return "";
  };

  const curpRow = findReviewRow(reviewPayload, "curp");
  const nssRow = findReviewRow(reviewPayload, "nss_file");
  const constanciaRow = findReviewRow(reviewPayload, "constancia");
  const bankFromReview = extractBankFromReview(reviewPayload);
  const clabeFromReview = extractClabeFromReview(reviewPayload);
  const clabeResolved = extractClabeFromText(firstNonEmpty(get("clabe", "clabeTxt"), clabeFromReview));
  const bankResolution = resolveBankName({
    clabe: clabeResolved,
    candidates: [bankFromReview, get("banco")],
  });

  const curpFromReview = firstNonEmpty(
    curpRow?.fields?.curp,
    curpRow?.summary,
    ...(curpRow?.issues || []),
    ...(curpRow?.warnings || [])
  );

  const nssFromReview = firstNonEmpty(
    nssRow?.fields?.nss,
    nssRow?.summary,
    ...(nssRow?.issues || []),
    ...(nssRow?.warnings || [])
  );

  const rfcFromReview = firstNonEmpty(
    constanciaRow?.fields?.rfc,
    constanciaRow?.summary,
    ...(constanciaRow?.issues || []),
    ...(constanciaRow?.warnings || [])
  );

  return {
    tipoVacante: normalizeVacancyType(get("tipo_vacante", "tipoVacante", "vacante")),
    nombre: get("nombre").toUpperCase(),
    telefono: get("telefono").replace(/\D/g, "").slice(0, 10),
    direccion: get("direccion"),
    banco: normalizeBankName(bankResolution.name || firstNonEmpty(bankFromReview, get("banco"))),
    clabeMode: get("clabe_mode") || "archivo",
    clabeTxt: clabeResolved,
    nssMode: get("nss_mode"),
    nssNum: normalizeNss(firstNonEmpty(get("nss_num", "nssNum"), nssFromReview)),
    rfc: normalizeRfc(firstNonEmpty(get("rfc"), rfcFromReview)),
    curpTxt: normalizeCurp(firstNonEmpty(get("curp_txt", "curpText", "curp_persona"), curpFromReview)),
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


function hasTemplateImages() {
  return fssync.existsSync(SHIP_CREDENTIAL_FRONT_TEMPLATE) && fssync.existsSync(SHIP_CREDENTIAL_BACK_TEMPLATE);
}

function drawTemplateBackground(doc, templatePath, cardW, cardH) {
  doc.image(templatePath, 0, 0, {
    width: cardW,
    height: cardH,
  });
}

function drawDiamondPhotoFromTemplate(doc, imagePath, cx, cy, halfSize) {
  if (!imagePath || !fssync.existsSync(imagePath)) return;

  const box = halfSize * 2;

  doc.save();
  doc.moveTo(cx, cy - halfSize)
    .lineTo(cx + halfSize, cy)
    .lineTo(cx, cy + halfSize)
    .lineTo(cx - halfSize, cy)
    .closePath()
    .clip();

  doc.image(imagePath, cx - halfSize, cy - halfSize, {
    fit: [box, box],
    align: "center",
    valign: "center",
  });
  doc.restore();
}

function textShadow(doc, text, x, y, options = {}) {
  const {
    width = 300,
    align = "center",
    size = 20,
    font = "Helvetica-Bold",
    color = "#ffffff",
    shadowColor = "#000000",
    shadowOffset = 2,
    lineGap = 2,
  } = options;

  doc.font(font).fontSize(size);
  doc.fillColor(shadowColor).text(text, x + shadowOffset, y + shadowOffset, {
    width,
    align,
    lineGap,
  });
  doc.fillColor(color).text(text, x, y, {
    width,
    align,
    lineGap,
  });
}

function splitNameForCredential(nombre) {
  const clean = String(nombre || "SIN NOMBRE")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  const parts = clean.split(" ").filter(Boolean);
  if (!parts.length) return "SIN NOMBRE";

  // Formato visual usado en la credencial SHIP:
  // NOMBRE(S) / APELLIDO PATERNO / APELLIDO MATERNO.
  // Para 3 palabras queda como en el ejemplo: HECTOR / HERNANDEZ / MORALES.
  if (parts.length >= 3) {
    const apellidoMaterno = parts[parts.length - 1];
    const apellidoPaterno = parts[parts.length - 2];
    const nombres = parts.slice(0, -2).join(" ");
    return [nombres, apellidoPaterno, apellidoMaterno].filter(Boolean).join("\n");
  }

  if (parts.length === 2) return `${parts[0]}\n${parts[1]}`;
  return parts[0];
}

function drawHalftone(doc, x, y, w, h, color = "#8f1d25", step = 14) {
  doc.save();
  doc.fillColor(color);
  for (let yy = y + 8; yy < y + h; yy += step) {
    for (let xx = x + 8; xx < x + w; xx += step) {
      const r = Math.max(1.2, Math.min(4.5, ((yy - y) / h) * 4.5));
      doc.circle(xx, yy, r).fill();
    }
  }
  doc.restore();
}

function drawChevronBand(doc, y, cardW) {
  doc.save();
  doc.fillColor("#202020");
  doc.polygon([0, y], [cardW * 0.22, y + 92], [0, y + 184]).fill();
  doc.polygon([cardW, y], [cardW * 0.78, y + 92], [cardW, y + 184]).fill();
  doc.lineWidth(16).strokeColor("#ff3344");
  doc.moveTo(0, y + 5).lineTo(cardW * 0.22, y + 92).lineTo(0, y + 179).stroke();
  doc.moveTo(cardW, y + 5).lineTo(cardW * 0.78, y + 92).lineTo(cardW, y + 179).stroke();
  doc.restore();
}

function drawPhotoDiamond(doc, imagePath, cx, cy, size) {
  doc.save();
  doc.translate(cx, cy).rotate(45);
  doc.rect(-size / 2, -size / 2, size, size).fill("#ffffff");
  doc.lineWidth(7).strokeColor("#111111").rect(-size / 2, -size / 2, size, size).stroke();
  doc.lineWidth(2).strokeColor("#ffffff").rect(-size / 2 + 9, -size / 2 + 9, size - 18, size - 18).stroke();

  if (imagePath && fssync.existsSync(imagePath)) {
    doc.save();
    doc.rect(-size / 2 + 12, -size / 2 + 12, size - 24, size - 24).clip();
    doc.rotate(-45);
    doc.image(imagePath, -size * 0.62, -size * 0.62, {
      fit: [size * 1.24, size * 1.24],
      align: "center",
      valign: "center"
    });
    doc.restore();
  }

  doc.restore();
}

function drawRoundedPhoto(doc, imagePath, x, y, w, h, radius = 28) {
  if (!imagePath || !fssync.existsSync(imagePath)) return;

  doc.save();
  doc.roundedRect(x, y, w, h, radius).clip();
  doc.image(imagePath, x, y, {
    fit: [w, h],
    align: "center",
    valign: "center",
  });
  doc.restore();

  doc.save();
  doc.lineWidth(4).strokeColor("#9EC6EF").roundedRect(x, y, w, h, radius).stroke();
  doc.restore();
}

function drawCredentialValue(doc, value, x, y, options = {}) {
  const {
    width = 200,
    size = 17,
    color = "#ffffff",
    align = "left",
  } = options;

  doc.font("Helvetica-Bold")
    .fontSize(size)
    .fillColor(color)
    .text(String(value || "N/A"), x, y, {
      width,
      align,
      lineGap: 1,
    });
}

function drawShipCredentialFront(doc, { bodyData, filePaths }) {
  const cardW = doc.page.width;
  const cardH = doc.page.height;

  if (hasTemplateImages()) {
    drawTemplateBackground(doc, SHIP_CREDENTIAL_FRONT_TEMPLATE, cardW, cardH);

    const selfie = filePaths?.selfie?.absolutePath;
    // Área fotográfica calibrada sobre la nueva plantilla SHIP.
    drawRoundedPhoto(doc, selfie, 103, 101, 194, 228, 4);

    const puesto = String(bodyData.tipoVacante || bodyData.puesto || ENV.PUESTO_DEFAULT || "OPERADOR")
      .replace(/_/g, " ")
      .trim();
    doc.font("Helvetica")
      .fontSize(17)
      .fillColor("#ffffff")
      .text(puesto || "OPERADOR", 65, 365, { width: 270, align: "center" });

    const displayName = splitNameForCredential(bodyData.nombre);
    textShadow(doc, displayName, 45, 397, {
      width: cardW - 90,
      align: "center",
      size: displayName.includes("\n") ? 23 : 27,
      font: "Helvetica-BoldOblique",
      color: "#ffffff",
      shadowColor: "#111111",
      shadowOffset: 1.5,
      lineGap: 1,
    });

    drawCredentialValue(doc, bodyData.nssNum || "N/A", 155, 510, { width: 205, size: 15 });
    drawCredentialValue(doc, bodyData.rfc || "N/A", 155, 551, { width: 205, size: 15 });
    drawCredentialValue(doc, bodyData.curpTxt || "N/A", 155, 592, { width: 220, size: 13 });
    return;
  }

  // Fallback simple SHIP si no existen los fondos renderizados.
  doc.rect(0, 0, cardW, cardH).fill("#1f1f1f");
  doc.fillColor("#ffffff").font("Helvetica-BoldOblique").fontSize(34).text("SHIP", 0, 55, {
    width: cardW,
    align: "center",
  });
  const selfie = filePaths?.selfie?.absolutePath;
  drawRoundedPhoto(doc, selfie, 102, 105, 196, 228, 4);
  const displayName = splitNameForCredential(bodyData.nombre);
  textShadow(doc, displayName, 45, 397, {
    width: cardW - 90,
    align: "center",
    size: 25,
    font: "Helvetica-Bold",
    color: "#ffffff",
    shadowColor: "#000000",
    shadowOffset: 1.5,
    lineGap: 2,
  });
  drawCredentialValue(doc, bodyData.nssNum || "N/A", 155, 510, { width: 205, size: 15 });
  drawCredentialValue(doc, bodyData.rfc || "N/A", 155, 551, { width: 205, size: 15 });
  drawCredentialValue(doc, bodyData.curpTxt || "N/A", 155, 592, { width: 220, size: 13 });
}

function drawShipCredentialBack(doc) {
  const cardW = doc.page.width;
  const cardH = doc.page.height;

  if (hasTemplateImages()) {
    drawTemplateBackground(doc, SHIP_CREDENTIAL_BACK_TEMPLATE, cardW, cardH);
    return;
  }

  doc.rect(0, 0, cardW, cardH).fill("#1f1f1f");
  doc.fillColor("#ffffff").font("Helvetica-BoldOblique").fontSize(34).text("SHIP", 0, 72, {
    width: cardW,
    align: "center",
  });
  doc.font("Helvetica-Bold").fontSize(28).text("SIEMPRE A TIEMPO", 0, 240, {
    width: cardW,
    align: "center",
  });
  doc.font("Helvetica").fontSize(17).text("SHIP TE ESCUCHA: 56 4168 8059", 0, 380, {
    width: cardW,
    align: "center",
  });
}

function createCredentialPdf({ jobId, credentialId, bodyData, filePaths, reviewSummary }) {
  return new Promise(async (resolve, reject) => {
    try {
      const credentialsDir = path.join(archiveRoot(), "credentials");
      await ensureDir(credentialsDir);

      const fileName = `${safePart(credentialId)}_${safePart(bodyData.nombre)}.pdf`;
      const abs = path.join(credentialsDir, fileName);

      const doc = new PDFDocument({
        size: [400, 629],
        margin: 0,
        info: {
          Title: `Credencial ${credentialId}`,
          Author: "SHIP",
          Subject: "Credencial de colaborador SHIP",
        },
      });

      const stream = fssync.createWriteStream(abs);
      doc.pipe(stream);

      drawShipCredentialFront(doc, { bodyData, filePaths, reviewSummary });
      doc.addPage({ size: [400, 629], margin: 0 });
      drawShipCredentialBack(doc, { bodyData, reviewSummary });

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
    rfc: bodyData.rfc,
    curpTxt: bodyData.curpTxt,
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
    rejectedDetail: detailRowsByStatus(reviewPayload, "rejected"),
    warningsDetail: detailRowsByStatus(reviewPayload, "warning"),
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

  for (const key of ["clabeTxt", "nssNum", "telefono", "ref1Tel", "ref2Tel"]) {
    const idx = HEADER_DEFINITIONS.findIndex(([k]) => k === key) + 1;
    if (idx > 0) {
      sheet.getColumn(idx).numFmt = "@";
    }
  }

  for (const key of ["rejectedDetail", "warningsDetail"]) {
    const idx = HEADER_DEFINITIONS.findIndex(([k]) => k === key) + 1;
    if (idx > 0) {
      sheet.getColumn(idx).width = 45;
    }
  }

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

async function createDraftCredentialIfEligible({ jobId, body, filePaths, reviewPayload }) {
  const bodyData = normalizeBody(body, reviewPayload);
  const eligibility = evaluateCredentialEligibility({ bodyData, reviewPayload, filePaths });

  if (!eligibility.eligible) {
    return {
      generated: false,
      eligibility,
      bodyData,
      credentialId: "",
      credentialPdf: null,
    };
  }

  const createdAtCompact = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const credentialId = `SHIP-${createdAtCompact}-${String(jobId || Date.now()).slice(0, 8).toUpperCase()}`;
  const credentialPdf = await createCredentialPdf({
    jobId,
    credentialId,
    bodyData,
    filePaths,
    reviewSummary: reviewPayload?.summary || {},
  });

  return {
    generated: true,
    eligibility,
    bodyData,
    credentialId,
    credentialPdf,
  };
}

async function saveRegistrationToLocalExcel({ jobId, body, files, reviewPayload }) {
  const bodyData = normalizeBody(body, reviewPayload);
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
    filePaths,
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
    bodyData,
    excel,
    credentialPdf,
    filePaths,
  };
}

module.exports = {
  FILE_FIELDS,
  FIELD_LABELS,
  normalizeBody,
  createCredentialPdf,
  createDraftCredentialIfEligible,
  saveRegistrationToLocalExcel,
};
