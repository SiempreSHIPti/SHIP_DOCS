# Fix nombre normalizado y opcionales

Se normaliza el nombre desde el inicio y tarjeta/póliza quedan opcionales con verde/amarillo/rojo según validez y titular. Ver `README-FIX-NOMBRE-NORMALIZADO-Y-OPCIONALES.md`.

---

# Fix reglas operativas IA

Se agregó una capa final de reglas operativas para que acentos, NSS, tarjeta/póliza y póliza opcional no se comporten incorrectamente por respuesta de Gemini. Ver `README-FIX-REGLAS-OPERATIVAS-IA.md`.

---

# Fix carga Estado de cuenta

Se corrigió el toggle de CLABE/Estado de cuenta para permitir subir el archivo correctamente. Ver `README-FIX-ESTADO-CUENTA-UPLOAD.md`.

---

# Fix final acentos, tarjeta/póliza y rutas locales

Se corrigieron acentos, tarjeta/póliza opcionales con amarillo no bloqueante y guardado/recuperación de rutas locales de archivos para continuar registros. Ver `README-FIX-FINAL-ACENTOS-TARJETA-POLIZA-RUTAS.md`.

---

# Fix acentos y observaciones

Se corrigió la validación para no bloquear por acentos, marcar tarjeta/póliza de terceros en amarillo y dejar póliza como opcional. Ver `README-FIX-ACENTOS-Y-OBSERVACIONES.md`.

---

# Guardar avance con CURP detectada

El guardado de avance ya no solicita CURP manualmente; usa la CURP detectada por IA desde el documento CURP. Ver `README-GUARDAR-AVANCE-CURP-DOCUMENTO.md`.

---

# Póliza opcional

La póliza de seguro ahora es opcional, pero se valida con IA si el usuario la carga. Ver `README-POLIZA-OPCIONAL.md`.

---

# Observaciones para tarjeta/póliza y archivos de interfaz

Se agregó manejo amarillo para tarjeta/póliza válidas que no están a nombre del driver, comparación de nombres sin acentos y guardado local con archivos ya cargados en la interfaz. Ver `README-OBSERVACIONES-TARJETA-POLIZA-Y-ARCHIVOS-INTERFAZ.md`.

---

# Guardado local en Excel y credencial PDF

Se agregó guardado local de documentos, Excel con append de filas y generación de credencial PDF. Ver `README-EXCEL-LOCAL-Y-CREDENCIAL.md`.

---

# Ajuste UX: sin CURP al inicio

Se quitó la CURP del formulario inicial. La CURP sólo se usa para recuperar o guardar avance. Ver `README-SIN-CURP-EN-INICIO.md`.

---

# Flujo actualizado: resumen IA al finalizar

Se agregó revisión IA al finalizar, pantalla de resumen, re-carga de documentos con error y continuar registro con CURP. Ver `README-FLUJO-RESUMEN-IA-Y-CONTINUAR-CURP.md`.

---

# Validación IA en tiempo real incluida

Ahora cada archivo se valida justo al seleccionarlo. Ver `README-VALIDACION-TIEMPO-REAL.md`.

---

# Fix incluido: modelo Gemini actualizado

Se cambió `gemini-2.0-flash` por `gemini-3.5-flash` y se agregó fallback automático. Ver `README-FIX-GEMINI-MODEL.md`.

---

# Registro documental - IA sólo revisión

Esta versión incluye modo:

```env
AI_REVIEW_ONLY_MODE=true
```

Con este modo se valida con IA real, pero no se sube ni guarda expediente en Drive, Sheets, Apps Script, Odoo, BD ni archivos locales.

Ver: `README-IA-SOLO-REVISION.md`.

---

# Registro documental - Modo local/dev

Esta versión está preparada para funcionar localmente sin conectar a APIs externas.

## Inicio rápido local

```bash
npm install
npm start
```

Abrir:

```txt
http://localhost:8080
```

Por defecto el ZIP incluye un `.env` seguro con:

```env
LOCAL_DEV_MODE=true
LOCAL_DEV_MOCK_AI=true
```

Con esto:

```txt
- no llama Gemini,
- no llama Google Drive,
- no escribe en Google Sheets,
- no llama Apps Script,
- no llama Odoo,
- no sube archivos a base de datos.
```

Los archivos se guardan sólo localmente en:

```txt
.local-dev/uploads/
.local-dev/submissions/
```

Ver más en `README-LOCAL-DEV-SIN-APIS.md`.

---

