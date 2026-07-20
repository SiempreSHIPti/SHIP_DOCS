// src/utils/friendlyErrors.js
function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function technicalMessageOf(err) {
  return compact(
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.message ||
    err?.error ||
    err ||
    ""
  );
}

function isDuplicateCurp(text) {
  return text.includes("duplicate_curp") ||
    text.includes("ya tiene un registro final") ||
    text.includes("no se puede registrar de nuevo");
}

function buildUserMessage({ message }) {
  return compact(message || "No fue posible completar la operación.");
}

function friendlyError(err, fallback = "No fue posible completar la operación.") {
  const technicalMessage = technicalMessageOf(err);
  const text = normalizeText(technicalMessage);
  const code = String(err?.code || err?.response?.data?.code || "").toUpperCase();

  let message = fallback;
  let cause = "";
  let action = "";
  let friendlyCode = code || "UNEXPECTED_ERROR";

  if (isDuplicateCurp(text) || code === "DUPLICATE_CURP") {
    friendlyCode = "DUPLICATE_CURP";
    message = "Esta CURP ya está registrada.";
  } else if (text.includes("curp invalida") || text.includes("curp inválida")) {
    friendlyCode = "INVALID_CURP";
    message = "La CURP no es válida.";
  } else if (text.includes("falta jobid") || text.includes("jobid")) {
    friendlyCode = "SESSION_EXPIRED";
    message = "La sesión expiró. Recarga la página.";
  } else if (text.includes("multipart/form-data invalido") || text.includes("multipart/form-data inválido") || text.includes("boundary")) {
    friendlyCode = "INVALID_FORM_UPLOAD";
    message = "No se recibieron los archivos. Vuelve a subirlos.";
  } else if (code === "LIMIT_FILE_SIZE" || text.includes("file too large") || text.includes("archivo excede") || text.includes("peso permitido") || (text.includes("supera") && text.includes("mb"))) {
    friendlyCode = "FILE_TOO_LARGE";
    message = "El archivo pesa demasiado. Máximo 5 MB.";
  } else if (code === "LIMIT_FILE_COUNT" || text.includes("too many files") || text.includes("demasiados archivos")) {
    friendlyCode = "TOO_MANY_FILES";
    message = "Sube sólo un archivo por documento.";
  } else if (text.includes("tipo de archivo no permitido")) {
    friendlyCode = "UNSUPPORTED_FILE_TYPE";
    message = "Formato no permitido. Usa PDF, JPG, PNG o WEBP.";
  } else if (text.includes("no parece ser pdf/imagen valida") || text.includes("no parece ser pdf/imagen válida")) {
    friendlyCode = "INVALID_FILE_CONTENT";
    message = "El archivo no se puede leer. Vuelve a subirlo.";
  } else if (text.includes("no coincide con su tipo declarado")) {
    friendlyCode = "FILE_TYPE_MISMATCH";
    message = "El archivo no coincide con su formato. Genera otro archivo.";
  } else if (text.includes("gemini_api_key") || text.includes("falta variable") || text.includes("no configurada") || text.includes("no configurado")) {
    friendlyCode = "SERVER_CONFIG_ERROR";
    message = "La validación no está disponible. Avisa al equipo técnico.";
  } else if (text.includes("max_tokens") || text.includes("finishreason") || text.includes("json valido") || text.includes("json válido") || text.includes("respuesta valida") || text.includes("respuesta válida")) {
    friendlyCode = "AI_INCOMPLETE_RESPONSE";
    message = "La IA no pudo leer el documento completo. Sube uno más claro.";
  } else if (text.includes("rate limit") || text.includes("ratelimit") || text.includes("429") || text.includes("quota")) {
    friendlyCode = "AI_RATE_LIMIT";
    message = "La validación está saturada. Intenta en unos minutos.";
  } else if (text.includes("unavailable") || text.includes("overloaded") || text.includes("503") || text.includes("modelos intentados") || text.includes("no hay modelos gemini disponibles")) {
    friendlyCode = "AI_UNAVAILABLE";
    message = "La IA no respondió. Intenta en unos minutos.";
  } else if (text.includes("timeout") || text.includes("etimedout") || text.includes("econnaborted") || text.includes("socket hang up")) {
    friendlyCode = "TIMEOUT";
    message = "La operación tardó demasiado. Intenta de nuevo.";
  } else if (text.includes("permission") || text.includes("permis") || text.includes("403") || text.includes("insufficient authentication") || text.includes("not authorized")) {
    friendlyCode = "PERMISSION_ERROR";
    message = "Faltan permisos del sistema. Avisa al equipo técnico.";
  } else if (text.includes("not found") || text.includes("404") || text.includes("no se encontro") || text.includes("no se encontró")) {
    friendlyCode = "RESOURCE_NOT_FOUND";
    message = "No se encontró la información solicitada.";
  } else if (text.includes("unable to parse range") || text.includes("no se encontro el header") || text.includes("no se encontró el header") || text.includes("no existe columna") || text.includes("spreadsheet_id") || text.includes("sheet")) {
    friendlyCode = "SHEET_CONFIG_ERROR";
    message = "No se pudo escribir en Sheets. Avisa al equipo técnico.";
  } else if (text.includes("drive_parent_folder_id") || text.includes("google_drive_parent_folder_id") || text.includes("folder")) {
    friendlyCode = "DRIVE_CONFIG_ERROR";
    message = "No se pudo guardar en Drive. Avisa al equipo técnico.";
  } else if (text.includes("failed to fetch") || text.includes("networkerror") || text.includes("load failed") || text.includes("network")) {
    friendlyCode = "NETWORK_ERROR";
    message = "Se perdió la conexión a internet.";
  } else if (/http\s*5\d\d/.test(text) || text.includes("internal server error")) {
    friendlyCode = "SERVER_ERROR";
    message = "El servidor tuvo un problema. Intenta de nuevo.";
  } else if (/http\s*4\d\d/.test(text)) {
    friendlyCode = "REQUEST_ERROR";
    message = "Falta información. Revisa el formulario.";
  } else if (technicalMessage) {
    message = technicalMessage.length > 160 ? `${technicalMessage.slice(0, 157)}...` : technicalMessage;
  }

  const userMessage = buildUserMessage({ message });

  return {
    code: friendlyCode,
    error: userMessage,
    userMessage,
    cause,
    action,
    technicalMessage,
  };
}

function friendlyValidationIssue(message, fieldName = "") {
  const raw = compact(message);
  const text = normalizeText(raw);
  const label = fieldName || "documento";

  if (!raw) return "No se pudo leer el documento.";

  if (text.includes("documento faltante") || text.includes("no se recibio archivo") || text.includes("no se recibió archivo")) {
    return `Falta subir ${label}.`;
  }
  if (text.includes("peso permitido") || (text.includes("excede") && text.includes("mb"))) {
    return `${label}: archivo mayor a 5 MB.`;
  }
  if (text.includes("no parece ser") || text.includes("no corresponde") || text.includes("otro documento") || text.includes("documento incorrecto") || text.includes("no es el documento esperado")) {
    return `${label}: documento incorrecto.`;
  }
  if (text.includes("ilegible") || text.includes("borroso") || text.includes("no es legible") || text.includes("no se puede leer") || text.includes("no pudo leer")) {
    return `${label}: no se lee con claridad.`;
  }
  if (text.includes("nombre") && (text.includes("no coincide") || text.includes("diferente"))) {
    return `${label}: el nombre no coincide.`;
  }
  if (text.includes("curp") && (text.includes("no detect") || text.includes("invalida") || text.includes("inválida") || text.includes("formato"))) {
    return "No se detectó una CURP válida.";
  }
  if (text.includes("rfc") && (text.includes("no detect") || text.includes("invalido") || text.includes("inválido") || text.includes("formato"))) {
    return "No se detectó un RFC válido.";
  }
  if ((text.includes("nss") || text.includes("seguro social")) && (text.includes("no detect") || text.includes("invalido") || text.includes("inválido") || text.includes("11"))) {
    return "No se detectó un NSS válido.";
  }
  if (text.includes("vigencia") || text.includes("vencid")) {
    return `${label}: documento vencido o sin vigencia visible.`;
  }
  if (text.includes("qr") || text.includes("codigo") || text.includes("código") || text.includes("mrz")) {
    return `${label}: no se ve completo el QR/código.`;
  }
  if (text.includes("titular") || text.includes("propietario") || text.includes("asegurado")) {
    return raw.length > 140 ? `${raw.slice(0, 137)}...` : raw;
  }

  return raw.length > 140 ? `${raw.slice(0, 137)}...` : raw;
}

function friendlyPayload(err, fallback, extra = {}) {
  return {
    ok: false,
    ...friendlyError(err, fallback),
    ...extra,
  };
}

module.exports = {
  friendlyError,
  friendlyPayload,
  friendlyValidationIssue,
};
