// src/services/documentValidation.js
const axios = require("axios");
const { ENV } = require("../config/env");
const { slog } = require("../utils/log");
const { normalizeClabe, isValidClabe, resolveBankName } = require("../utils/clabe");

const DOC_RULES = {
  ine_frontal: {
    label: "INE frontal",
    expectedType: "identificacion_oficial_ine_frontal",
    requireNameMatch: true,
    minConfidence: 0.72,
    requiredEvidence: ["nombre", "fotografia", "clave_elector_o_curp", "vigencia_o_fecha"],
  },
  ine_reverso: {
    label: "INE reverso",
    expectedType: "identificacion_oficial_ine_reverso",
    requireNameMatch: false,
    minConfidence: 0.70,
    requiredEvidence: ["codigo_qr_o_mrz_o_datos_reverso"],
  },
  curp: {
    label: "CURP",
    expectedType: "constancia_curp",
    requireNameMatch: true,
    minConfidence: 0.72,
    requiredEvidence: ["curp", "nombre"],
  },
  nss_file: {
    label: "Documento NSS",
    expectedType: "documento_nss_imss",
    requireNameMatch: true,
    minConfidence: 0.70,
    requiredEvidence: ["nss", "nombre"],
  },
  constancia: {
    label: "Constancia de situación fiscal",
    expectedType: "constancia_situacion_fiscal_sat",
    requireNameMatch: true,
    minConfidence: 0.72,
    requiredEvidence: ["rfc", "nombre_o_razon_social", "regimen_o_sat"],
  },
  acta: {
    label: "Acta de nacimiento",
    expectedType: "acta_nacimiento",
    requireNameMatch: true,
    minConfidence: 0.70,
    requiredEvidence: ["nombre", "fecha_nacimiento_o_lugar", "registro_civil"],
  },
  comprobante: {
    label: "Comprobante de domicilio",
    expectedType: "comprobante_domicilio",
    requireNameMatch: false,
    minConfidence: 0.68,
    requiredEvidence: ["domicilio", "fecha_o_periodo", "emisor"],
  },
  licencia: {
    label: "Licencia de conducir",
    expectedType: "licencia_conducir",
    requireNameMatch: true,
    minConfidence: 0.72,
    requiredEvidence: ["nombre", "numero_licencia", "vigencia"],
  },
  tarjeta: {
    label: "Tarjeta de circulación",
    expectedType: "tarjeta_circulacion_vehicular",
    requireNameMatch: false,
    minConfidence: 0.70,
    requiredEvidence: ["placa_o_serie", "vehiculo", "vigencia_o_folio"],
  },
  poliza: {
    label: "Póliza de seguro",
    expectedType: "poliza_seguro_vehicular",
    requireNameMatch: false,
    minConfidence: 0.68,
    requiredEvidence: ["aseguradora", "poliza", "vigencia", "vehiculo"],
  },
  estado_cuenta: {
    label: "Estado de cuenta / comprobante bancario",
    expectedType: "estado_cuenta_o_captura_bancaria",
    requireNameMatch: true,
    minConfidence: 0.70,
    requiredEvidence: ["logo_o_marca_banco_o_codigo_clabe", "nombre_titular", "clabe_interbancaria_18_digitos"],
  },
  selfie: {
    label: "Foto personal / selfie",
    expectedType: "selfie_foto_personal",
    requireNameMatch: false,
    minConfidence: 0.80,
    requiredEvidence: [
      "una_persona_real",
      "rostro_visible",
      "captura_directa_de_camara",
      "sin_pantalla_telefono_monitor",
      "sin_foto_impresa_o_foto_de_otra_foto",
    ],
  },
};

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-ZÑ\s]/gi, " ")
    .toUpperCase()
    .replace(/\b(DE|DEL|LA|LAS|LOS|Y|DA|DAS|DOS)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameSimilarity(expected, found) {
  const a = normalizeName(expected).split(" ").filter((x) => x.length > 2);
  const b = new Set(normalizeName(found).split(" ").filter((x) => x.length > 2));
  if (!a.length || !b.size) return 0;
  const hits = a.filter((x) => b.has(x)).length;
  return hits / a.length;
}

const OWNER_OBSERVATION_FIELDS = new Set(["tarjeta", "poliza"]);
const NAME_MATCH_THRESHOLD = 0.68;

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return null;
}

function computeNameMatch(expectedName, foundName, aiNameMatches) {
  const similarity = nameSimilarity(expectedName, foundName);
  const normalizedExpected = normalizeName(expectedName);
  const normalizedFound = normalizeName(foundName);

  const accentInsensitiveExact = Boolean(
    normalizedExpected &&
    normalizedFound &&
    normalizedExpected === normalizedFound
  );

  const matchesBySimilarity = similarity >= NAME_MATCH_THRESHOLD;
  const matches = accentInsensitiveExact || matchesBySimilarity || aiNameMatches === true;

  return {
    similarity,
    matches,
    accentInsensitiveExact,
    normalizedExpected,
    normalizedFound
  };
}

function isNameMismatchIssue(issue) {
  const text = String(issue || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const mentionsPerson =
    text.includes("nombre") ||
    text.includes("titular") ||
    text.includes("propietario") ||
    text.includes("asegurado") ||
    text.includes("conductor") ||
    text.includes("driver");

  const mentionsMismatch =
    text.includes("no coincide") ||
    text.includes("diferencia") ||
    text.includes("difiere") ||
    text.includes("difier") ||
    text.includes("exactamente") ||
    text.includes("esperado") ||
    text.includes("detectado") ||
    text.includes("caracteres base") ||
    text.includes("interpretacion ocr") ||
    text.includes("accent") ||
    text.includes("acent") ||
    text.includes("mismatch") ||
    text.includes("different");

  return mentionsPerson && mentionsMismatch;
}

function isMissingNameIssue(issue) {
  const text = String(issue || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return (
    (text.includes("no se detect") || text.includes("no detect")) &&
    (text.includes("nombre") || text.includes("titular") || text.includes("propietario") || text.includes("asegurado"))
  );
}

function isOwnershipOnlyIssue(issue) {
  return isNameMismatchIssue(issue) || isMissingNameIssue(issue);
}

function isAccentOnlyNameIssue(issue) {
  const text = String(issue || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return (
    (text.includes("acent") || text.includes("difiere") || text.includes("diferencia") || text.includes("caracteres base") || text.includes("interpretacion ocr")) &&
    (text.includes("nombre") || text.includes("titular") || text.includes("driver") || text.includes("esperado"))
  );
}

function isIrrelevantFieldIssue(fieldName, issue) {
  const text = String(issue || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  // El NSS no debe exigir RFC. Si Gemini menciona RFC en NSS, es una regla equivocada.
  if (fieldName === "nss_file" && text.includes("rfc")) return true;

  return false;
}

function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try { return JSON.parse(raw); } catch (_) {}

  const match = raw.match(/```json\s*([\s\S]*?)\s*```/i) || raw.match(/```\s*([\s\S]*?)\s*```/i);
  if (match) {
    try { return JSON.parse(match[1]); } catch (_) {}
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
  }

  return null;
}

function promptFor(rule, expectedName) {
  return `
Eres un validador documental estricto para un proceso de alta de drivers en México.

Tu tarea es validar un archivo cargado por el usuario.

Documento esperado: ${rule.label}
Tipo esperado interno: ${rule.expectedType}
Nombre esperado del driver: ${expectedName || "NO_PROPORCIONADO"}
Debe coincidir nombre: ${rule.requireNameMatch ? "SI" : "NO"}
Evidencia mínima esperada: ${rule.requiredEvidence.join(", ")}

Analiza visualmente/OCR el documento y responde SOLO JSON válido con esta estructura:
{
  "ok": boolean,
  "documentTypeDetected": string,
  "isExpectedDocument": boolean,
  "isLegible": boolean,
  "nameFound": string|null,
  "nameMatches": boolean|null,
  "confidence": number,
  "fields": {
    "banco": string|null,
    "bankLogoDetected": boolean|null,
    "bankLogoText": string|null,
    "isBankAppScreenshot": boolean|null,
    "clabe": string|null,
    "clabe_interbancaria": string|null,
    "cuenta_clabe": string|null,
    "cuenta": string|null,
    "curp": string|null,
    "rfc": string|null,
    "nss": string|null,
    "vigencia": string|null,
    "fecha": string|null,
    "ownerName": string|null,
    "propietario": string|null,
    "asegurado": string|null,
    "isRealPerson": boolean|null,
    "isDirectCameraCapture": boolean|null,
    "isScreenRecapture": boolean|null,
    "isPrintedPhoto": boolean|null,
    "isPhotoOfPhoto": boolean|null,
    "screenOrDeviceDetected": boolean|null,
    "faceCount": number|null,
    "spoofIndicators": string[]
  },
  "issues": string[],
  "recommendation": "accept"|"reject"|"manual_review",
  "summary": string
}

Reglas:
- ok debe ser true sólo si el documento corresponde al tipo esperado, es legible y cumple la coincidencia de nombre cuando aplique.
- La coincidencia de nombre debe evaluarse ignorando acentos/diacríticos y diferencias menores de mayúsculas/minúsculas. Ejemplo: JOSE = JOSÉ, MARTIN = MARTÍN, GONZALEZ = GONZÁLEZ.
- REGLAS ESPECIALES PARA ESTADO DE CUENTA / COMPROBANTE BANCARIO:
  - Se acepta un estado de cuenta PDF/imagen o una fotografía/captura de pantalla de la app, banca web o pantalla bancaria. NO rechaces este documento únicamente por ser captura de pantalla.
  - Para aprobar una captura bancaria deben existir: (1) identidad bancaria verificable por logo/marca visible O por el código bancario de una CLABE válida, (2) nombre del titular y (3) CLABE interbancaria de 18 dígitos.
  - NO adivines el banco sólo por colores o estilo visual de la app. Si ves logo/texto explícito, guárdalo; el backend validará de forma determinista el banco usando los primeros 3 dígitos de la CLABE.
  - Guarda el banco visualmente detectado en fields.banco, indica fields.bankLogoDetected=true sólo cuando el logo/marca sea realmente identificable, fields.bankLogoText con el texto o marca detectada y fields.isBankAppScreenshot=true cuando sea captura/foto de pantalla.
  - Guarda la CLABE en fields.clabe sólo con 18 dígitos, aun si visualmente aparece separada con espacios o guiones.
  - No basta con un número de cuenta: para aprobación automática de este campo debe existir CLABE de 18 dígitos y su dígito verificador debe ser válido.
  - El nombre del titular debe corresponder al nombre esperado del driver ignorando acentos y diferencias menores de OCR.
  - No exijas periodo, fecha de corte ni formato de estado de cuenta tradicional cuando la evidencia provenga de banca móvil/web.
  - Si no puedes identificar visualmente la entidad bancaria, NO inventes una. Devuelve la CLABE y deja que el backend resuelva el banco por los primeros 3 dígitos cuando el código exista en el catálogo.
- Si el documento esperado es Comprobante de domicilio, valida únicamente que sea un comprobante real/válido, legible y que contenga domicilio/emisor/periodo o datos suficientes. No lo rechaces si está a nombre de otra persona.
- REGLAS ESPECIALES PARA TARJETA DE CIRCULACIÓN / PERMISO GUBERNAMENTAL:
  - Además de una tarjeta de circulación, acepta permisos, autorizaciones, constancias o documentos oficiales emitidos por CUALQUIER autoridad gubernamental federal, estatal o municipal, siempre que el archivo sea legible y tenga formato oficial reconocible.
  - Para un permiso gubernamental no exijas que aparezcan placa, serie, vehículo o nombre del driver si el propio formato del permiso no los contiene.
  - Identifica la autoridad/dependencia en fields.autoridad_emisora o fields.dependencia_gobierno; guarda el folio en fields.folio_permiso cuando exista; marca fields.isGovernmentPermit=true y fields.isOfficialGovernmentFormat=true cuando corresponda.
  - Si es una tarjeta de circulación tradicional, conserva la validación normal del documento. Si está a nombre de otra persona, no la rechaces por nombre; puede quedar como observación no bloqueante.
- Para Póliza de seguro, si detectas asegurado/titular, colócalo en nameFound y fields.asegurado. Si es válida pero no está a nombre del driver, no la rechaces por nombre; usa recommendation manual_review, ok true y explica la observación.
- REGLAS ESPECIALES PARA FOTO PERSONAL / SELFIE:
  - Debe aparecer exactamente una persona real, con el rostro visible, suficientemente grande y enfocado.
  - Debe parecer una captura directa de cámara de la persona presente frente al dispositivo.
  - Rechaza fotografías tomadas a otra fotografía, a una credencial, a una impresión, a un teléfono, tableta, laptop, monitor o televisión.
  - Rechaza capturas de pantalla, imágenes con marco de dispositivo, bordes de pantalla, reflejos de cristal, patrón moiré, pixelado de pantalla, brillo de monitor o una mano sosteniendo otra foto/dispositivo.
  - Rechaza imágenes generadas artificialmente o rostros evidentemente sintéticos cuando existan señales visuales claras.
  - En fields informa obligatoriamente isRealPerson, isDirectCameraCapture, isScreenRecapture, isPrintedPhoto, isPhotoOfPhoto, screenOrDeviceDetected, faceCount y spoofIndicators.
  - Para aprobar la selfie: isRealPerson=true, isDirectCameraCapture=true, faceCount=1 y todos los indicadores de recaptura/impresión/dispositivo=false.
  - Si no puedes confirmar una captura directa con confianza suficiente, recommendation debe ser reject y explica el indicador observado.
- No inventes datos no visibles.
- No devuelvas texto fuera del JSON.
`;
}


function fileTokens(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function hasAnyToken(text, tokens) {
  const normalized = fileTokens(text).join(" ");
  return tokens.some((token) => normalized.includes(token));
}

function expectedTokensFor(fieldName) {
  const map = {
    ine_frontal: ["ine", "frontal", "identificacion", "credencial"],
    ine_reverso: ["ine", "reverso", "identificacion", "credencial"],
    curp: ["curp"],
    nss_file: ["nss", "imss", "seguro", "social"],
    constancia: ["constancia", "situacion", "fiscal", "sat", "rfc", "csf"],
    acta: ["acta", "nacimiento"],
    comprobante: ["comprobante", "domicilio", "recibo", "luz", "agua", "telefono"],
    licencia: ["licencia", "conducir", "manejo"],
    tarjeta: ["tarjeta", "circulacion"],
    poliza: ["poliza", "seguro"],
    estado_cuenta: ["estado", "cuenta", "banco", "clabe", "bbva", "banorte", "santander", "azteca", "banamex", "hsbc", "scotiabank"],
    selfie: ["selfie", "foto", "rostro", "persona"]
  };

  return map[fieldName] || [fieldName];
}

function forbiddenTokensForLocalMock() {
  return [
    "gato",
    "perro",
    "mascota",
    "comida",
    "paisaje",
    "random",
    "prueba",
    "demo-basura",
    "basura",
    "nada",
    "incorrecto",
    "wrong",
    "fail",
    "rechazar",
    "malo",
    "ilegible",
    "borroso",
    "no-corresponde",
    "nocorresponde",
    "otro-documento"
  ];
}

function expectedNameTokens(expectedName) {
  return normalizeName(expectedName)
    .split(" ")
    .filter((token) => token.length > 2);
}

function localMockValidation({ fieldName, file, rule, expectedName, jobId }) {
  const originalName = String(file?.originalname || "").toLowerCase();
  const mime = String(file?.mimetype || "").toLowerCase();
  const size = Number(file?.size || file?.buffer?.length || 0);

  const isPdfOrImage = /pdf|jpeg|jpg|png|webp/.test(mime);
  const forbidden = hasAnyToken(originalName, forbiddenTokensForLocalMock());
  const typeMatch = hasAnyToken(originalName, expectedTokensFor(fieldName));

  const nameTokens = expectedNameTokens(expectedName);
  const normalizedFileName = fileTokens(originalName).join(" ");
  const nameHits = nameTokens.filter((token) => normalizedFileName.includes(token.toLowerCase())).length;
  const ownerObservation = OWNER_OBSERVATION_FIELDS.has(fieldName);
  const hasNameEvidence = !rule.requireNameMatch || nameHits >= Math.min(2, Math.max(1, nameTokens.length));
  const ownerMatchesInFileName = ownerObservation && nameHits >= Math.min(2, Math.max(1, nameTokens.length));

  const strict = ENV.LOCAL_DEV_MOCK_AI_STRICT !== false;
  const isLegible = !forbidden && size > 128 && isPdfOrImage;

  const strictOk = !strict || (typeMatch && hasNameEvidence);
  const ok = !forbidden && strictOk && isLegible;

  const issues = [];

  if (!isPdfOrImage) issues.push("El archivo local no parece PDF o imagen permitida.");
  if (size <= 128) issues.push("El archivo está vacío o es demasiado pequeño.");
  if (forbidden) issues.push("Simulación local: el nombre del archivo indica que no corresponde o es ilegible.");

  if (strict && !typeMatch) {
    issues.push(`Mock local estricto: el nombre del archivo no contiene evidencia del documento esperado (${rule.label}).`);
  }

  if (strict && rule.requireNameMatch && !hasNameEvidence) {
    issues.push("Mock local estricto: el nombre del archivo no contiene suficiente evidencia del nombre del driver.");
  }

  if (fieldName === "estado_cuenta" && strict) {
    const hasBankEvidence = hasAnyToken(originalName, ["estado", "cuenta", "banco", "clabe", "bbva", "banorte", "santander", "azteca", "banamex", "hsbc", "scotiabank"]);
    if (!hasBankEvidence) issues.push("Mock local estricto: no hay evidencia de estado de cuenta/banco/CLABE en el nombre del archivo.");
  }

  const fields = {
    banco: fieldName === "estado_cuenta" && ok ? "BANCO DEMO" : null,
    clabe: fieldName === "estado_cuenta" && ok ? "012345678901234568" : null,
    cuenta: fieldName === "estado_cuenta" && ok ? "1234567890" : null,
    bankLogoDetected: fieldName === "estado_cuenta" && ok ? true : null,
    bankLogoText: fieldName === "estado_cuenta" && ok ? "BANCO DEMO" : null,
    isBankAppScreenshot: fieldName === "estado_cuenta" && ok ? hasAnyToken(originalName, ["captura", "screenshot", "app", "pantalla"]) : null,
    curp: fieldName === "curp" && ok ? "CURPDEMO000000HDFXXX00" : null,
    rfc: fieldName === "constancia" && ok ? "RFCDEMO000XXX" : null,
    nss: fieldName === "nss_file" && ok ? "12345678901" : null,
    vigencia: ["ine_frontal", "licencia", "tarjeta", "poliza"].includes(fieldName) && ok ? "2030" : null,
    fecha: ok ? new Date().toISOString().slice(0, 10) : null,
    ownerName: ownerObservation ? (ownerMatchesInFileName ? expectedName : "TERCERO DEMO") : null,
    propietario: fieldName === "tarjeta" ? (ownerMatchesInFileName ? expectedName : "TERCERO DEMO") : null,
    asegurado: fieldName === "poliza" ? (ownerMatchesInFileName ? expectedName : "TERCERO DEMO") : null,
    isRealPerson: fieldName === "selfie" ? ok : null,
    isDirectCameraCapture: fieldName === "selfie" ? ok : null,
    isScreenRecapture: fieldName === "selfie" ? false : null,
    isPrintedPhoto: fieldName === "selfie" ? false : null,
    isPhotoOfPhoto: fieldName === "selfie" ? false : null,
    screenOrDeviceDetected: fieldName === "selfie" ? false : null,
    faceCount: fieldName === "selfie" && ok ? 1 : null,
    spoofIndicators: []
  };

  const raw = {
    ok,
    documentTypeDetected: typeMatch ? rule.expectedType : "desconocido_o_no_corresponde",
    isExpectedDocument: typeMatch && !forbidden,
    isLegible,
    nameFound: rule.requireNameMatch && hasNameEvidence ? expectedName : (ownerObservation ? fields.ownerName : null),
    nameMatches: rule.requireNameMatch ? hasNameEvidence : (ownerObservation ? ownerMatchesInFileName : null),
    confidence: ok ? 0.93 : forbidden ? 0.20 : 0.45,
    fields,
    issues,
    recommendation: ok ? "accept" : "reject",
    summary: ok
      ? `Validación local estricta aprobada para ${rule.label}. No se llamó a Gemini ni a APIs externas.`
      : `Validación local estricta rechazada para ${rule.label}. No se llamó a Gemini ni a APIs externas.`
  };

  const result = hardenResult(raw, { fieldName, rule, expectedName });

  slog(jobId, result.ok ? "INFO" : "WARN", `Resultado validación LOCAL estricta ${rule.label}`, {
    ok: result.ok,
    recommendation: result.recommendation,
    issues: result.issues
  });

  return {
    ...result,
    localDev: true,
    provider: "mock_strict",
    strict,
    fileNameChecked: originalName
  };
}


function uniqueModels() {
  const configured = [
    ENV.GEMINI_MODEL,
    ...(String(ENV.GEMINI_MODEL_FALLBACKS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean))
  ];

  const seen = new Set();
  return configured.filter((model) => {
    if (!model || seen.has(model)) return false;
    seen.add(model);
    return true;
  });
}

function isModelUnavailableError(err) {
  const status = err?.response?.status;
  const message = String(
    err?.response?.data?.error?.message ||
    err?.message ||
    ""
  ).toLowerCase();

  return (
    status === 404 ||
    message.includes("no longer available") ||
    message.includes("not found") ||
    message.includes("not supported") ||
    message.includes("deprecated") ||
    message.includes("shutdown")
  );
}

async function callGeminiWithModel({ file, rule, expectedName, jobId, model }) {
  const url = `${ENV.GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(ENV.GEMINI_API_KEY)}`;

  const body = {
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json"
    },
    contents: [
      {
        role: "user",
        parts: [
          { text: promptFor(rule, expectedName) },
          {
            inlineData: {
              mimeType: file.mimetype,
              data: file.buffer.toString("base64")
            }
          }
        ]
      }
    ]
  };

  const res = await axios.post(url, body, { timeout: 45000 });
  const text = res.data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") || "";
  const parsed = extractJson(text);

  if (!parsed || typeof parsed !== "object") {
    slog(jobId, "ERROR", "Gemini no devolvió JSON válido", { model, text: text.slice(0, 500) });
    throw new Error("La IA no devolvió una respuesta válida de validación documental.");
  }

  return {
    parsed,
    modelUsed: model
  };
}

async function callGemini({ file, rule, expectedName, jobId }) {
  if (!ENV.GEMINI_API_KEY) {
    throw new Error("Falta GEMINI_API_KEY para validar documentos con IA. En AI_REVIEW_ONLY_MODE debes configurar una llave real de Gemini.");
  }

  const models = uniqueModels();
  let lastError = null;

  for (const model of models) {
    try {
      slog(jobId, "INFO", `Intentando validación Gemini con modelo: ${model}`);
      return await callGeminiWithModel({ file, rule, expectedName, jobId, model });
    } catch (err) {
      lastError = err;
      const message = err?.response?.data?.error?.message || err?.message || String(err);

      if (isModelUnavailableError(err)) {
        slog(jobId, "WARN", "Modelo Gemini no disponible, probando fallback", {
          model,
          message
        });
        continue;
      }

      throw err;
    }
  }

  const msg = lastError?.response?.data?.error?.message || lastError?.message || "No hay modelos Gemini disponibles.";
  throw new Error(`No se pudo validar con Gemini. Modelos intentados: ${models.join(", ")}. Último error: ${msg}`);
}

function nullableBoolean(value) {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "si", "sí"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  return null;
}

function buildSelfieVerification(fields = {}) {
  const faceCountRaw = Number(fields.faceCount ?? fields.face_count);
  return {
    isRealPerson: nullableBoolean(fields.isRealPerson ?? fields.real_person ?? fields.persona_real),
    isDirectCameraCapture: nullableBoolean(fields.isDirectCameraCapture ?? fields.direct_camera_capture ?? fields.captura_directa),
    isScreenRecapture: nullableBoolean(fields.isScreenRecapture ?? fields.screen_recapture ?? fields.foto_a_pantalla),
    isPrintedPhoto: nullableBoolean(fields.isPrintedPhoto ?? fields.printed_photo ?? fields.foto_impresa),
    isPhotoOfPhoto: nullableBoolean(fields.isPhotoOfPhoto ?? fields.photo_of_photo ?? fields.foto_de_foto),
    screenOrDeviceDetected: nullableBoolean(fields.screenOrDeviceDetected ?? fields.device_detected ?? fields.pantalla_o_dispositivo_detectado),
    faceCount: Number.isFinite(faceCountRaw) ? faceCountRaw : null,
    spoofIndicators: Array.isArray(fields.spoofIndicators)
      ? fields.spoofIndicators.map(String).filter(Boolean).slice(0, 10)
      : [],
  };
}


function nullableBool(value) {
  if (value === true || value === false) return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "si", "sí", "yes"].includes(text)) return true;
  if (["false", "0", "no"].includes(text)) return false;
  return null;
}

function bankScreenshotEvidence(result, expectedName) {
  const fields = result?.fields || {};
  const logoDetected = nullableBool(fields.bankLogoDetected ?? fields.logo_banco_detectado ?? fields.logo_detectado);
  const logoText = firstNonEmpty(fields.bankLogoText, fields.logo_banco, fields.marca_banco, fields.logo_text);
  const visualBank = firstNonEmpty(
    fields.banco,
    fields.bank,
    fields.institucion,
    fields.institucion_bancaria,
    fields.entidad_financiera,
    fields.emisor,
    fields.banco_emisor,
    logoText
  );

  const clabeCandidates = [
    fields.clabe,
    fields.clabe_interbancaria,
    fields.clabeInterbancaria,
    fields.cuenta_clabe,
    fields.cuentaClabe
  ].map(normalizeClabe).filter(Boolean);

  const clabe = clabeCandidates.find((candidate) => isValidClabe(candidate)) || clabeCandidates[0] || "";
  const bankResolution = resolveBankName({ clabe, candidates: [visualBank, logoText] });
  const bank = bankResolution.name || visualBank;

  // Si la CLABE tiene un código bancario conocido, esa fuente prevalece.
  // Si el código no está catalogado, se exige evidencia visual explícita del banco.
  const bankIdentityVerified = Boolean(
    bankResolution.source === "clabe_prefix" ||
    ((logoDetected === true || Boolean(logoText)) && visualBank)
  );

  const name = firstNonEmpty(
    result?.nameFound,
    fields.nombre,
    fields.nombre_titular,
    fields.nombreTitular,
    fields.titular,
    fields.ownerName
  );
  const nameCheck = computeNameMatch(expectedName, name, result?.nameMatches);

  return {
    bank,
    visualBank,
    bankCode: bankResolution.code || "",
    bankSource: bankResolution.source,
    bankMismatch: bankResolution.mismatch,
    bankIdentityVerified,
    logoDetected: logoDetected === true || Boolean(logoText),
    logoText,
    clabe,
    clabeValid: isValidClabe(clabe),
    name,
    nameMatches: nameCheck.matches,
  };
}

function isBankScreenshotIrrelevantIssue(issue, evidence) {
  if (!evidence?.bank || !evidence?.bankIdentityVerified || !evidence?.name || !evidence?.clabeValid) return false;

  const text = String(issue || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return (
    text.includes("periodo") ||
    text.includes("fecha de corte") ||
    text.includes("captura de pantalla") ||
    text.includes("captura de app") ||
    text.includes("pantalla") ||
    text.includes("no parece ser estado de cuenta") ||
    text.includes("no corresponde al formato tradicional") ||
    text.includes("numero de cuenta") ||
    (evidence.bankSource === "clabe_prefix" && (
      text.includes("logo") ||
      text.includes("marca bancaria") ||
      text.includes("banco emisor") ||
      text.includes("no se detecto banco") ||
      text.includes("no se identifico banco") ||
      text.includes("no se puede identificar banco") ||
      text.includes("banco detectado") ||
      text.includes("banco no coincide")
    ))
  );
}

function hardenResult(raw, { fieldName, rule, expectedName }) {
  const fields = raw.fields && typeof raw.fields === "object" ? raw.fields : {};
  const ownerCandidate = firstNonEmpty(
    raw.nameFound,
    fields.ownerName,
    fields.propietario,
    fields.asegurado,
    fields.titular
  );

  const result = {
    fieldName,
    label: rule.label,
    expectedType: rule.expectedType,
    ok: Boolean(raw.ok),
    documentTypeDetected: String(raw.documentTypeDetected || "desconocido"),
    isExpectedDocument: Boolean(raw.isExpectedDocument),
    isLegible: Boolean(raw.isLegible),
    nameFound: ownerCandidate,
    nameMatches: raw.nameMatches === null || raw.nameMatches === undefined ? null : Boolean(raw.nameMatches),
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0,
    fields,
    issues: Array.isArray(raw.issues) ? raw.issues.map(String).slice(0, 12) : [],
    recommendation: ["accept", "reject", "manual_review"].includes(raw.recommendation) ? raw.recommendation : "manual_review",
    summary: String(raw.summary || "").slice(0, 500)
  };

  if (fieldName === "estado_cuenta") {
    const bankEvidence = bankScreenshotEvidence(result, expectedName);
    result.fields = {
      ...result.fields,
      banco: bankEvidence.bank || result.fields?.banco || null,
      banco_detectado_ia: bankEvidence.visualBank || null,
      banco_codigo_clabe: bankEvidence.bankCode || null,
      banco_fuente: bankEvidence.bankSource || null,
      banco_conflicto_ia_clabe: bankEvidence.bankMismatch === true,
      clabe: bankEvidence.clabe || result.fields?.clabe || null,
      bankLogoDetected: bankEvidence.logoDetected,
      bankLogoText: bankEvidence.logoText || result.fields?.bankLogoText || null,
    };
    result.nameFound = bankEvidence.name || result.nameFound;
    result.nameMatches = bankEvidence.nameMatches;

    if (
      result.isLegible &&
      bankEvidence.bankIdentityVerified &&
      bankEvidence.bank &&
      bankEvidence.name &&
      bankEvidence.clabeValid
    ) {
      result.isExpectedDocument = true;
      result.documentTypeDetected = result.documentTypeDetected === "desconocido"
        ? "captura_o_comprobante_bancario"
        : result.documentTypeDetected;
    }
  }

  const ownerCheckApplies = OWNER_OBSERVATION_FIELDS.has(fieldName);
  const nameCheck = computeNameMatch(expectedName, result.nameFound, result.nameMatches);
  const bankEvidenceForIssues = fieldName === "estado_cuenta"
    ? bankScreenshotEvidence(result, expectedName)
    : null;

  const rawBlockingIssues = [];
  const warningIssues = [];

  for (const issue of result.issues) {
    if (!issue) continue;

    if (isIrrelevantFieldIssue(fieldName, issue)) {
      continue;
    }

    if (fieldName === "estado_cuenta" && isBankScreenshotIrrelevantIssue(issue, bankEvidenceForIssues)) {
      continue;
    }

    // Si el nombre realmente coincide al normalizar acentos, ignoramos errores de IA por acentuación
    // o por "coincidencia exacta" generados por OCR/Gemini.
    if (!ownerCheckApplies && rule.requireNameMatch && nameCheck.matches && (isNameMismatchIssue(issue) || isAccentOnlyNameIssue(issue))) {
      continue;
    }

    // Para tarjeta/póliza, diferencias de propietario/asegurado no son bloqueantes si el documento es válido.
    if (ownerCheckApplies && (isOwnershipOnlyIssue(issue) || isNameMismatchIssue(issue) || isAccentOnlyNameIssue(issue))) {
      warningIssues.push(issue);
      continue;
    }

    rawBlockingIssues.push(issue);
  }

  const blockingIssues = [...rawBlockingIssues];

  if (!result.isExpectedDocument) blockingIssues.push(`El archivo no parece ser ${rule.label}.`);
  if (!result.isLegible) blockingIssues.push("La información del documento no es legible.");
  const strongBankEvidenceForConfidence = fieldName === "estado_cuenta"
    ? bankScreenshotEvidence(result, expectedName)
    : null;
  if (
    result.confidence < rule.minConfidence &&
    !(strongBankEvidenceForConfidence?.bankIdentityVerified &&
      strongBankEvidenceForConfidence?.clabeValid &&
      strongBankEvidenceForConfidence?.name)
  ) {
    blockingIssues.push(`Confianza baja (${result.confidence}).`);
  }

  if (rule.requireNameMatch) {
    if (!result.nameFound) {
      blockingIssues.push("No se detectó nombre del titular/persona en el documento.");
    } else if (!nameCheck.matches) {
      blockingIssues.push(`El nombre detectado no coincide con el driver. Detectado: ${result.nameFound}`);
    }
  }

  if (fieldName === "estado_cuenta") {
    const bankEvidence = bankScreenshotEvidence(result, expectedName);

    if (!bankEvidence.bank) {
      blockingIssues.push("No se detectó banco emisor.");
    }
    if (!bankEvidence.bankIdentityVerified) {
      blockingIssues.push("No se pudo identificar el banco por logo/marca ni por el código bancario de la CLABE.");
    }
    if (!bankEvidence.name) {
      blockingIssues.push("No se detectó el nombre del titular.");
    }
    if (!bankEvidence.clabe) {
      blockingIssues.push("No se detectó una CLABE interbancaria de 18 dígitos.");
    } else if (!bankEvidence.clabeValid) {
      blockingIssues.push("La CLABE detectada no es válida (dígito verificador incorrecto).");
    }

    if (bankEvidence.bankMismatch && bankEvidence.visualBank) {
      warningIssues.push(
        `El banco detectado visualmente (${bankEvidence.visualBank}) no coincide con el código de la CLABE. Se usará ${bankEvidence.bank}.`
      );
    }
  }

  const selfieVerification = fieldName === "selfie" ? buildSelfieVerification(result.fields) : null;
  if (selfieVerification) {
    if (selfieVerification.isRealPerson !== true) {
      blockingIssues.push("No se pudo confirmar que la imagen corresponda a una persona real.");
    }
    if (selfieVerification.isDirectCameraCapture !== true) {
      blockingIssues.push("La foto no parece una captura directa de cámara de la persona.");
    }
    if (selfieVerification.isScreenRecapture === true || selfieVerification.screenOrDeviceDetected === true) {
      blockingIssues.push("Se detectó que la imagen podría ser una fotografía tomada a un teléfono, monitor u otra pantalla.");
    }
    if (selfieVerification.isPrintedPhoto === true || selfieVerification.isPhotoOfPhoto === true) {
      blockingIssues.push("Se detectó una fotografía impresa o una foto tomada a otra fotografía.");
    }
    if (selfieVerification.faceCount !== 1) {
      blockingIssues.push(
        selfieVerification.faceCount === null
          ? "No se pudo confirmar que aparezca exactamente un rostro."
          : `La fotografía debe contener exactamente una persona; se detectaron ${selfieVerification.faceCount} rostros.`
      );
    }
    for (const indicator of selfieVerification.spoofIndicators) {
      blockingIssues.push(`Indicador de recaptura: ${indicator}`);
    }
  }

  const bankEvidenceForValidity = fieldName === "estado_cuenta"
    ? bankScreenshotEvidence(result, expectedName)
    : null;

  const documentItselfValid = fieldName === "estado_cuenta"
    ? Boolean(
        result.isExpectedDocument &&
        result.isLegible &&
        bankEvidenceForValidity?.bankIdentityVerified &&
        bankEvidenceForValidity?.clabeValid &&
        bankEvidenceForValidity?.name
      )
    : Boolean(
        result.isExpectedDocument &&
        result.isLegible &&
        result.confidence >= rule.minConfidence
      );

  let ownerStatus = "not_applicable";
  let severity = "error";
  let finalOk = false;
  let recommendation = blockingIssues.length >= 2 ? "reject" : "manual_review";

  if (ownerCheckApplies) {
    const hasBlockingNonOwnershipIssues = blockingIssues.length > 0;

    if (!documentItselfValid || hasBlockingNonOwnershipIssues) {
      severity = "error";
      finalOk = false;
      recommendation = "reject";
    } else if (result.nameFound && nameCheck.matches) {
      ownerStatus = "matches_driver";
      severity = "success";
      finalOk = true;
      recommendation = "accept";
    } else {
      ownerStatus = result.nameFound ? "different_owner" : "owner_not_detected";
      severity = "warning";
      finalOk = true;
      recommendation = "manual_review";

      warningIssues.push(
        result.nameFound
          ? `Documento válido, pero el propietario/asegurado detectado no coincide con el driver. Detectado: ${result.nameFound}`
          : "Documento válido, pero no se detectó propietario/asegurado para confirmar si coincide con el driver."
      );
    }
  } else {
    const baseValid = documentItselfValid && blockingIssues.length === 0;
    severity = baseValid ? "success" : "error";
    finalOk = baseValid;
    recommendation = baseValid ? "accept" : (blockingIssues.length >= 2 ? "reject" : "manual_review");
  }

  return {
    ...result,
    ok: finalOk,
    severity,
    ownerCheckApplies,
    ownerStatus,
    ownerMatchesDriver: ownerStatus === "matches_driver",
    nameSimilarity: nameCheck.similarity,
    accentInsensitiveNameMatch: nameCheck.accentInsensitiveExact,
    ...(selfieVerification ? { selfieVerification } : {}),
    issues: [...new Set(blockingIssues)],
    warnings: [...new Set(warningIssues)],
    recommendation
  };
}

async function validateDocument({ jobId, fieldName, file, expectedName }) {
  const rule = DOC_RULES[fieldName];

  if (!rule) {
    return {
      fieldName,
      label: fieldName,
      ok: true,
      skipped: true,
      recommendation: "accept",
      issues: []
    };
  }

  if (!ENV.DOCUMENT_AI_VALIDATION_ENABLED) {
    return {
      fieldName,
      label: rule.label,
      ok: true,
      skipped: true,
      recommendation: "manual_review",
      issues: ["Validación IA deshabilitada por configuración."]
    };
  }

  if (ENV.LOCAL_DEV_MODE && !ENV.AI_REVIEW_ONLY_MODE && ENV.LOCAL_DEV_MOCK_AI) {
    return localMockValidation({ fieldName, file, rule, expectedName, jobId });
  }

  try {
    slog(jobId, "INFO", `Validando documento con IA: ${rule.label}`);
    const { parsed: raw, modelUsed } = await callGemini({ file, rule, expectedName, jobId });
    const result = {
      ...hardenResult(raw, { fieldName, rule, expectedName }),
      provider: "gemini",
      modelUsed
    };
    slog(jobId, result.ok ? "INFO" : "WARN", `Resultado validación ${rule.label}`, {
      ok: result.ok,
      recommendation: result.recommendation,
      issues: result.issues
    });
    return result;
  } catch (err) {
    const message = err?.response?.data?.error?.message || err?.message || "Error validando documento con IA.";
    slog(jobId, "ERROR", `Fallo validación IA ${rule.label}`, { message });

    return {
      fieldName,
      label: rule.label,
      expectedType: rule.expectedType,
      ok: !ENV.DOCUMENT_AI_VALIDATION_REQUIRED,
      isExpectedDocument: false,
      isLegible: false,
      confidence: 0,
      recommendation: ENV.DOCUMENT_AI_VALIDATION_REQUIRED ? "reject" : "manual_review",
      issues: [message],
      summary: "No se pudo validar el documento con IA."
    };
  }
}

function assertDocumentValidationResults(results) {
  if (ENV.DOCUMENT_AI_VALIDATION_MODE === "warn") return;
  if (!ENV.DOCUMENT_AI_VALIDATION_REQUIRED) return;

  const failed = results.filter((r) => r && r.ok === false && r.recommendation !== "manual_review");
  const manual = results.filter((r) => r && r.ok === false && r.recommendation === "manual_review");
  const blocking = failed.length ? failed : manual;

  if (blocking.length) {
    const msg = blocking
      .map((r) => `${r.label || r.fieldName}: ${(r.issues || []).join("; ")}`)
      .join(" | ");
    const err = new Error(`Validación documental no aprobada. ${msg}`);
    err.code = "DOCUMENT_VALIDATION_FAILED";
    err.details = blocking;
    throw err;
  }
}

module.exports = {
  DOC_RULES,
  validateDocument,
  assertDocumentValidationResults,
  normalizeName,
  nameSimilarity
};
