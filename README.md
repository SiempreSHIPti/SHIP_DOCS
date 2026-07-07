# Fix archivo pesado en rojo sin compresión de usuario

Se eliminó la herramienta de compresión para el usuario y se deja archivo pesado en rojo con instrucción de subir otro archivo menor a 5 MB. Ver `README-FIX-SIN-COMPRESION-USUARIO-ARCHIVO-PESADO-ROJO.md`.

---

# Fix compresión PDF raster con Python

Se agregó fallback de rasterizado con pypdfium2 para PDFs que no reducen con compresión estructural. Ver `README-FIX-COMPRESION-PYTHON-RASTER-PDF.md`.

---

# Fix compresión Python sin Ghostscript

Se agregó compresión con script Python para imágenes/PDF y se eliminó dependencia de Ghostscript. Ver `README-FIX-COMPRESION-PYTHON-SIN-GHOSTSCRIPT.md`.

---

# Fix Driver opcionales y bloqueo de estado de cuenta

Se ajustaron reglas de Driver/Chofer y el bloqueo de documentos requeridos no validados por peso. Ver `README-FIX-DRIVER-OPCIONALES-Y-BLOQUEO-ESTADO-CUENTA.md`.

---

# Fix reglas Driver/Chofer opcionales

Se ajustaron las reglas documentales para Driver y Chofer: póliza/tarjeta no se solicitan y acta es opcional para Driver. Ver `README-FIX-REGLAS-DRIVER-CHOFER-OPCIONALES.md`.

---

# Fix UX archivo pesado no faltante

Se ajustó el resumen para que un archivo cargado pero pesado no aparezca como faltante; ahora se muestra como archivo cargado no validado por peso. Ver `README-FIX-UX-ARCHIVO-PESADO-NO-FALTA.md`.

---

# Fix Ver resumen y feedback de compresión

Se cambió el botón final a Ver resumen, se agrega modal de espera si hay validaciones pendientes y se mejora el mensaje cuando la compresión no alcanza 5 MB. Ver `README-FIX-VER-RESUMEN-Y-FEEDBACK-COMPRESION.md`.

---

# Fix comprimir y validar archivo pesado

Se agregó acción en resumen para comprimir y validar archivos mayores a 5 MB sin bloquear el flujo. Ver `README-FIX-COMPRIMIR-Y-VALIDAR-ARCHIVO-PESADO.md`.

---

# Fix archivo pesado no bloquea IA

Se ajustó el flujo para que archivos mayores a 5 MB no bloqueen el resumen: se omiten de IA, se marcan en resumen y se mantiene compresión al guardar. Ver `README-FIX-ARCHIVO-PESADO-NO-BLOQUEA-IA.md`.

---

# Fix 5 MB sin bloquear validación

Se mantiene 5 MB como objetivo/recomendación, pero archivos mayores no bloquean validación/resumen y se comprimen al guardar. Ver `README-FIX-5MB-NO-BLOQUEAR-VALIDACION-COMPRESION.md`.

---

# Fix no bloquear resumen por archivos pesados

Se ajustó el flujo para permitir llegar al resumen aunque existan archivos pesados, mostrando advertencia no bloqueante. Ver `README-FIX-NO-BLOQUEAR-RESUMEN-ARCHIVOS-PESADOS.md`.

---

# Fix archivos grandes y compresión Drive

Se permite subir archivos de hasta 25 MB y se comprimen imágenes/PDFs antes de subir a Drive. Ver `README-FIX-ARCHIVOS-GRANDES-COMPRESION-DRIVE.md`.

---

# Fix progreso renumerado para Ayudante

Se ajustó el progreso para que Referencias se vea como paso 3 cuando Vehículo no aplica. Ver `README-FIX-PROGRESO-RENUMERADO-AYUDANTE.md`.

---

# Fix ocultar campos no obligatorios

Se ocultan por completo los campos que no son obligatorios según la vacante y se oculta el paso Vehículo para Ayudante. Ver `README-FIX-OCULTAR-CAMPOS-NO-OBLIGATORIOS.md`.

---

# Fix omitir pasos no aplicables

Se ajustó el flujo para saltar pasos y omitir documentos no aplicables según el tipo de vacante. Ver `README-FIX-OMITIR-PASOS-NO-APLICABLES.md`.

---

# Fix resumen y revalidación dirigida

Se ajustó el flujo para llegar al resumen, permitir guardar avance y revalidar sólo archivos corregidos. Ver `README-FIX-RESUMEN-Y-REVALIDACION-DIRIGIDA.md`.

---

# Fix validación por sección en segundo plano

Se ajustó la validación parcial para que el usuario avance de paso sin esperar a que termine la IA. Ver `README-FIX-VALIDACION-SECCION-SEGUNDO-PLANO.md`.

---

# Fix snackbar validación por sección

Se reemplazó el modal bloqueante de validación parcial por un snackbar flotante profesional. Ver `README-FIX-SNACKBAR-VALIDACION-SECCION.md`.

---

# Fix tipo de vacante y reglas documentales

Se agregó selección de tipo de vacante antes de iniciar el registro y reglas de obligatoriedad por Driver, Chofer y Ayudante. Ver `README-FIX-TIPO-VACANTE-REGLAS-DOCUMENTOS.md`.

---

# Fix validación parcial y credencial

Se agregó validación parcial por sección, check por paso y resumen final con validaciones acumuladas. También se documentó que la credencial conserva NSS, RFC, CURP y foto personal. Ver `README-FIX-VALIDACION-PARCIAL-Y-CREDENCIAL.md`.

---

# Fix logo SHIP pantalla inicial

Se agregó el logo SHIP dentro del card inicial, manteniendo el patrón visual actual. Ver `README-FIX-LOGO-SHIP-PANTALLA-INICIAL.md`.

---

# Fix pantalla inicial patrón formulario

Se ajustó la pantalla inicial para usar el mismo patrón visual del formulario: dos columnas, marca en panel izquierdo y acción principal en panel derecho. Ver `README-FIX-PANTALLA-INICIAL-PATRON-FORMULARIO.md`.

---

# Fix marca SHIP en card inicial

Se regresó al diseño anterior y se agregó únicamente la marca SHIP dentro del card inicial. Ver `README-FIX-MARCA-SHIP-CARD-INICIAL.md`.

---

# Fix visual archivos recuperados

Se corrigió la vista de archivos recuperados para que no se vea “Sin archivos seleccionados” cuando el backend ya tiene un documento cargado. Ver `README-FIX-INPUT-ARCHIVOS-RECUPERADOS.md`.

---

# Fix sin borrador final, un registro y compresión

Se corrigió el flujo para que al guardar final se actualice la fila BORRADOR en Sheets, se elimine el borrador local, se renombren documentos por columna y se compriman imágenes antes de subir a Drive. Ver `README-FIX-SIN-BORRADOR-UN-REGISTRO-COMPRESION.md`.

---

# Fix duplicados Sheets source

Se corrigió la validación de duplicados para que en producción use Google Sheets como fuente de verdad y no el archivo local temporal del contenedor. Ver `README-FIX-DUPLICADOS-SHEETS-SOURCE.md`.

---

# Fix Maps, banco/CLABE, continuar y limpieza

Se corrigió autocompletado con Google Maps, extracción de banco/CLABE desde estado de cuenta, recuperación de avances directa al resumen y limpieza final del formulario. Ver `README-FIX-MAPS-BANCO-CLABE-CONTINUAR-LIMPIEZA.md`.

---

# Fix mensajes driver, draft y Maps

Se corrigió el error al guardar avance, se ocultó información técnica para drivers y se agregó soporte para `GOOGLE_MAPS_BROWSER_KEY`. Ver `README-FIX-MENSAJES-DRIVER-DRAFT-MAPS.md`.

---

# Fix flujo operativo final

Se agregaron modales, carga/continuación de avances con archivos, prevención de duplicados por CURP, guardado de borradores en Drive/Sheets, mensajes IA simplificados y dirección con Google Maps. Ver `README-FIX-FLUJO-OPERATIVO-FINAL.md`.

---

# Fix Google Sheets tab autocreate

Se corrigió el error `Unable to parse range` creando automáticamente la pestaña del Sheet si no existe y usando rangos A1 seguros. Ver `README-FIX-SHEETS-TAB-AUTOCREATE.md`.

---

# Fix Cloud Run startup env

Se corrigió el arranque en Cloud Run para que el contenedor no truene si faltan variables de Google Drive/Sheets al inicio. Ver `README-FIX-CLOUDRUN-STARTUP-ENV.md`.

---

# Fix Cloud Build npm ci

Se corrigió el Dockerfile para evitar que Cloud Build falle cuando `package-lock.json` está desfasado frente a `package.json`. Ver `README-FIX-NPM-CI-LOCK-CLOUDBUILD.md`.

---

# Fix Cloud Build Dockerfile

Se agregó `Dockerfile`, `.dockerignore` y `cloudbuild.yaml` para corregir el error de Cloud Build que no encontraba `/workspace/Dockerfile`. Ver `README-FIX-CLOUDBUILD-DOCKERFILE.md`.

---

# Fix credencial formato PowerPoint

La credencial PDF que se genera al guardar el registro ahora usa el formato del PowerPoint cargado como plantilla visual. Ver `README-FIX-CREDENCIAL-FORMATO-POWERPOINT.md`.

---

# Fix inicio, nombre y estado de cuenta

Se agregó pantalla inicial única, se corrigió escritura de espacios en nombre y se dejó sólo carga de Estado de cuenta. Ver `README-FIX-INICIO-NOMBRE-ESTADO-CUENTA.md`.

---

# Google Sheets + Drive + credencial SHIP

Se agregó credencial PDF estilo SHIP con foto del driver y subida opcional a Google Drive/Sheets con carpeta por driver. Ver `README-GOOGLE-SHEETS-DRIVE-CREDENCIAL-SHIP.md`.

---

# Fix comprobante de domicilio

El comprobante de domicilio ahora se acepta aunque esté a nombre de otra persona; sólo se valida que sea un comprobante real. Ver `README-FIX-COMPROBANTE-DOMICILIO.md`.

---

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

