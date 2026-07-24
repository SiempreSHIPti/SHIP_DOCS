
    const errEl = document.getElementById("err");
    const submitBtn = document.getElementById("submitBtn");
    const btnText = document.getElementById("btn-text");
    const btnSpinner = document.getElementById("btn-spinner");

    // Generar jobId en el cliente para tracking de uploads por pasos
    function genJobId() {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
      return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
    }
    const globalJobId = genJobId();
    document.getElementById('jobId') && (document.getElementById('jobId').value = globalJobId);

    const activeUploads = [];
    const realtimeValidation = new Map();

    const runtimeConfig = {
      aiReviewOnlyMode: true,
      localDevMode: false,
      documentAiValidationEnabled: true,
      documentAiValidationRequired: true
    };

    const runtimeConfigPromise = fetch("/api/config", { cache: "no-store" })
      .then(r => r.ok ? r.json() : {})
      .then(cfg => Object.assign(runtimeConfig, cfg || {}))
      .catch(() => runtimeConfig);



    const DRAFT_PREFIX = "ship_registration_draft_curp_";
    let latestReviewPayload = null;
    let loadedDraftCurp = "";
    let appModalAfterClose = null;
    let mapsAutocompleteReady = false;
    const reviewReplacementFilesByField = new Map();

    const STEP_FILE_FIELDS = {
      1: ["selfie", "estado_cuenta"],
      2: ["ine_frontal", "ine_reverso", "curp", "nss_file", "constancia", "acta", "comprobante"],
      3: ["licencia", "tarjeta", "poliza"],
      4: []
    };

    const FILE_FIELDS_FOR_REVIEW = new Set(Object.values(STEP_FILE_FIELDS).flat());

    const STEP_LABELS = {
      1: "Datos personales",
      2: "Documentos",
      3: "Vehículo",
      4: "Referencias"
    };


    const VACANCY_LABELS = {
      driver: "Driver",
      chofer: "Chofer",
      ayudante: "Ayudante"
    };

    function normalizeVacancyValue(value) {
      const raw = String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase();

      if (raw.includes("ayudante")) return "ayudante";
      if (raw.includes("chofer")) return "chofer";
      if (raw.includes("driver")) return "driver";
      return "";
    }

    function selectedVacancy() {
      return normalizeVacancyValue(document.getElementById("tipo_vacante")?.value || "");
    }

    function isVehicleStepRequired() {
      return selectedVacancy() !== "ayudante";
    }

    function isFieldVisibleInSummary(row = {}) {
      const fieldName = row.fieldName;
      const vacancy = selectedVacancy() || "driver";
      const status = statusForRow(row);
      const hasUploadedFile = !!(row.fileName || row.validatedAt);

      if (vacancy === "driver" && ["tarjeta", "poliza", "acta"].includes(fieldName)) {
        return hasUploadedFile && status !== "skipped" && status !== "missing";
      }

      if (!["licencia", "tarjeta", "poliza"].includes(fieldName)) return true;
      if (vacancy === "ayudante") return false;
      if (vacancy === "chofer" && (fieldName === "tarjeta" || fieldName === "poliza")) {
        return false;
      }
      return true;
    }

    function visibleReviewRows(rows = []) {
      return (rows || []).filter(isFieldVisibleInSummary);
    }

    function isOptionalNonBlockingField(fieldName) {
      const vacancy = selectedVacancy() || "driver";
      if (vacancy === "driver" && ["tarjeta", "poliza", "acta"].includes(fieldName)) return true;
      if (vacancy === "chofer" && ["tarjeta", "poliza"].includes(fieldName)) return true;
      if (vacancy === "ayudante" && ["licencia", "tarjeta", "poliza"].includes(fieldName)) return true;
      return false;
    }

    function summarizeRowsForUi(rows = []) {
      const visible = visibleReviewRows(rows);
      const warnings = visible.filter((x) => x.status === "warning" || x.severity === "warning").length;
      const approved = visible.filter((x) => x.ok === true && x.status !== "skipped" && x.status !== "warning" && x.severity !== "warning").length;
      const skipped = visible.filter((x) => x.status === "skipped").length;
      const rejected = visible.filter((x) => x.ok === false && x.status === "rejected").length;
      const missing = visible.filter((x) => x.status === "missing").length;
      const blockingWarnings = visible.filter((x) =>
        (x.blocking === true || x.skippedByWeight === true) && !isOptionalNonBlockingField(x.fieldName)
      ).length;
      const pendingFix = rejected + missing + blockingWarnings;
      return {
        total: visible.length,
        approved,
        warnings,
        skipped,
        rejected,
        missing,
        blockingWarnings,
        pendingFix,
        canContinue: pendingFix === 0,
      };
    }

    function updateVacancyStepVisibility() {
      const skipVehicle = selectedVacancy() === "ayudante";
      document.body.classList.toggle("skip-vehicle-step", skipVehicle);
      document.querySelector(".progress-bar")?.classList.toggle("skip-vehicle-step", skipVehicle);
      document.querySelector('.section.step[data-step="3"]')?.classList.toggle("step-not-applicable", skipVehicle);
      if (skipVehicle) {
        stepValidationOk[3] = false;
        stepValidationPending[3] = false;
        delete stepValidationPromises[3];
      }
      updateProgress(currentStepNumber());
    }

    function setRequiredMark(inputId, required) {
      const input = document.getElementById(inputId);
      const label = document.querySelector(`label[for="${CSS.escape(inputId)}"]`);
      if (input) input.required = !!required;

      if (!label) return;

      let mark = label.querySelector(".required");
      if (required && !mark) {
        mark = document.createElement("span");
        mark.className = "required";
        mark.textContent = "*";
        label.appendChild(document.createTextNode(" "));
        label.appendChild(mark);
      }

      if (mark) mark.style.display = required ? "" : "none";
    }

    function updateVehicleHelpText(vacancy) {
      const vehicleStep = document.querySelector('.step[data-step="3"]');
      if (!vehicleStep) return;

      let notice = vehicleStep.querySelector(".vacancy-rule-note");
      if (!notice) {
        notice = document.createElement("p");
        notice.className = "hint vacancy-rule-note";
        vehicleStep.insertBefore(notice, vehicleStep.querySelector(".grid"));
      }

      if (vacancy === "driver") {
        notice.textContent = "Vacante Driver: licencia obligatoria. Tarjeta de circulación y póliza son opcionales; si las subes, se revisarán.";
      } else if (vacancy === "chofer") {
        notice.textContent = "Vacante Chofer: sólo se solicitará licencia de conducir. No se solicita tarjeta de circulación ni póliza.";
      } else if (vacancy === "ayudante") {
        notice.textContent = "Vacante Ayudante: el paso vehicular no aplica.";
      } else {
        notice.textContent = "Selecciona el tipo de vacante para aplicar las reglas documentales.";
      }
    }

    function fieldContainer(inputId) {
      const input = document.getElementById(inputId);
      return input?.closest(".col-6, .col-12, .field-group") || null;
    }

    function clearFileInput(input) {
      if (!input) return;
      try { input.value = ""; } catch (_) {}
      clearRecoveredFileControl(input);
      const status = input.parentElement?.querySelector(".file-status");
      if (status) status.remove();
      delete partialValidationByField[input.name];
      fieldsPendingTargetedRevalidation.delete(input.name);
      reviewReplacementFilesByField.delete(input.name);
      delete input.dataset.targetedRevalidate;
    }

    function setFieldVisibility(inputId, visible) {
      const input = document.getElementById(inputId);
      const container = fieldContainer(inputId);
      if (container) {
        container.classList.toggle("field-not-applicable", !visible);
        container.style.display = visible ? "" : "none";
      }

      if (input) {
        input.disabled = !visible;
        if (!visible) {
          input.required = false;
          clearFileInput(input);
        }
      }
    }

    function applyVacancyRules(value) {
      const vacancy = normalizeVacancyValue(value) || "driver";
      const vacancyInput = document.getElementById("tipo_vacante");
      if (vacancyInput) vacancyInput.value = vacancy;

      const showLicencia = vacancy === "driver" || vacancy === "chofer";
      const showTarjeta = vacancy === "driver"; // Driver: se solicita, pero es opcional.
      const showPoliza = vacancy === "driver"; // Driver: se solicita, pero es opcional.
      const showActa = vacancy !== "driver"; // Driver: acta opcional/no solicitada.

      setFieldVisibility("licencia", showLicencia);
      setFieldVisibility("tarjeta", showTarjeta);
      setFieldVisibility("poliza", showPoliza);
      setFieldVisibility("acta", showActa);

      setRequiredMark("licencia", showLicencia);
      setRequiredMark("tarjeta", false);
      setRequiredMark("poliza", false);
      setRequiredMark("acta", showActa);

      updateVehicleHelpText(vacancy);

      document.querySelectorAll("[data-vacancy]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.vacancy === vacancy);
      });

      const formHeader = document.querySelector(".form-header p");
      if (formHeader) {
        formHeader.textContent = `Vacante: ${VACANCY_LABELS[vacancy] || "No seleccionada"}. Complete los campos requeridos para continuar.`;
      }

      invalidateStep(3);
      updateVacancyStepVisibility();
      return vacancy;
    }

    function requireVacancyBeforeStart() {
      setLandingMode("new");
      showAppModal("Selecciona la vacante", "Antes de iniciar, elige si aplica como Driver, Chofer o Ayudante.", { type: "error" });
    }


    const stepValidationOk = { 1: false, 2: false, 3: false, 4: false };
    const stepValidationPending = { 1: false, 2: false, 3: false, 4: false };
    const stepValidationPromises = {};
    const partialValidationByField = {};
    const AI_VALIDATION_MAX_FILE_BYTES = 5 * 1024 * 1024;
    const fieldsPendingTargetedRevalidation = new Set();

    function currentStepNumber() {
      const active = document.querySelector(".step.active");
      return Number(active?.dataset?.step || 1);
    }

    function fieldStep(fieldName) {
      for (const [step, fields] of Object.entries(STEP_FILE_FIELDS)) {
        if (fields.includes(fieldName)) return Number(step);
      }
      return null;
    }

    function resetPartialValidationState() {
      Object.keys(stepValidationOk).forEach((key) => stepValidationOk[key] = false);
      Object.keys(stepValidationPending).forEach((key) => stepValidationPending[key] = false);
      Object.keys(stepValidationPromises).forEach((key) => delete stepValidationPromises[key]);
      Object.keys(partialValidationByField).forEach((key) => delete partialValidationByField[key]);
      fieldsPendingTargetedRevalidation.clear();
      document.querySelectorAll("input[data-targeted-revalidate]").forEach((input) => delete input.dataset.targetedRevalidate);
      updateProgress(currentStepNumber());
    }

    function setStepValidated(step, ok = true) {
      stepValidationOk[Number(step)] = !!ok;
      stepValidationPending[Number(step)] = false;
      updateProgress(currentStepNumber());
    }

    function invalidateStep(step) {
      if (!step) return;
      stepValidationOk[Number(step)] = false;
      stepValidationPending[Number(step)] = false;
      delete stepValidationPromises[Number(step)];
      for (const field of STEP_FILE_FIELDS[Number(step)] || []) {
        delete partialValidationByField[field];
      }
      updateProgress(currentStepNumber());
    }

    function startSectionValidation(step, fieldsOverride = null) {
      const stepNum = Number(step);
      if (!stepNum || stepValidationPending[stepNum]) return stepValidationPromises[stepNum] || Promise.resolve(false);

      stepValidationPending[stepNum] = true;
      stepValidationOk[stepNum] = false;
      updateProgress(currentStepNumber());

      const promise = validateSectionWithAi(stepNum, fieldsOverride)
        .catch((err) => {
          console.error("[section-validation] Error no controlado:", err);
          setStepValidated(stepNum, false);
          return false;
        })
        .finally(() => {
          stepValidationPending[stepNum] = false;
          updateProgress(currentStepNumber());
        });

      stepValidationPromises[stepNum] = promise;
      return promise;
    }

    function pendingValidationSteps() {
      return [1, 2, 3]
        .filter((step) => !(step === 3 && !isVehicleStepRequired()))
        .filter((step) => stepValidationPending[step] && stepValidationPromises[step]);
    }

    async function waitForPendingSectionValidations(options = {}) {
      const steps = pendingValidationSteps();
      const pending = steps.map((step) => stepValidationPromises[step]);

      if (!pending.length) return;

      if (options.modal) {
        showAppModal(
          "Validaciones en curso",
          `Estamos terminando ${pending.length} validación${pending.length === 1 ? "" : "es"} pendiente${pending.length === 1 ? "" : "s"} antes de mostrar el resumen.`,
          { type: "loading" }
        );
      } else {
        showSectionValidationToast("Terminando validaciones", "Espera un momento. Estamos cerrando las validaciones pendientes antes del resumen.", {
          type: "loading"
        });
      }

      await Promise.allSettled(pending);
    }

    function failedLabelsFromPayload(payload) {
      return visibleReviewRows(payload?.results || [])
        .filter((row) => {
          const status = statusForRow(row);
          return status === "rejected" || status === "missing";
        })
        .map((row) => row.label || DOC_LABELS[row.fieldName] || row.fieldName);
    }

    function statusIsBlocking(row) {
      const status = statusForRow(row);
      return status === "rejected" || status === "missing";
    }

    function failedFieldsFromPayload(payload) {
      return visibleReviewRows(payload?.results || [])
        .filter(statusIsBlocking)
        .map((row) => row.fieldName)
        .filter(Boolean);
    }

    function markFieldForTargetedRevalidation(fieldName) {
      if (!fieldName) return;
      fieldsPendingTargetedRevalidation.add(fieldName);
      const step = fieldStep(fieldName);
      if (step) {
        stepValidationOk[step] = false;
        updateProgress(currentStepNumber());
      }
    }

    function targetedFieldsForStep(step) {
      if (Number(step) === 3 && !isVehicleStepRequired()) return [];
      const fields = STEP_FILE_FIELDS[Number(step)] || [];
      return Array.from(fieldsPendingTargetedRevalidation).filter((field) => fields.includes(field));
    }

    function syncStepChecksFromPayload(payload) {
      const rows = payload?.results || [];
      for (const step of [1, 2, 3]) {
        if (step === 3 && !isVehicleStepRequired()) {
          stepValidationOk[3] = false;
          stepValidationPending[3] = false;
          continue;
        }
        const fields = STEP_FILE_FIELDS[step] || [];
        const rowsForStep = rows.filter((row) => fields.includes(row.fieldName));
        if (!rowsForStep.length) {
          stepValidationOk[step] = false;
          continue;
        }
        stepValidationOk[step] = rowsForStep.every((row) => !statusIsBlocking(row));
        stepValidationPending[step] = false;
      }
      updateProgress(currentStepNumber());
    }

    function buildPartialReviewFormData(step, fieldsOverride = null) {
      const fields = Array.isArray(fieldsOverride) && fieldsOverride.length
        ? fieldsOverride
        : (STEP_FILE_FIELDS[step] || []);
      const fd = buildFinalReviewFormData();
      fd.set("reviewMode", "partial");
      fd.set("partialStep", String(step || ""));
      fd.set("partialFields", fields.join(","));
      return fd;
    }

    async function validateSectionWithAi(step, fieldsOverride = null) {
      await runtimeConfigPromise;

      const fields = Array.isArray(fieldsOverride) && fieldsOverride.length
        ? fieldsOverride
        : (STEP_FILE_FIELDS[step] || []);
      if (!fields.length) {
        setStepValidated(step, true);
        return true;
      }

      showSectionValidationToast(
        `Validando ${STEP_LABELS[step] || "sección"}`,
        "Puedes continuar con el siguiente paso. Esta validación corre en segundo plano.",
        { type: "loading" }
      );
      errEl.style.display = "none";
      errEl.textContent = "";

      try {
        const resp = await fetch("/api/registration/final-review", {
          method: "POST",
          body: buildPartialReviewFormData(step, fields),
          cache: "no-store"
        });

        const data = await resp.json().catch(() => ({}));

        if (!resp.ok || !data.ok) {
          const err = new Error(data.error || `Error en validación de sección (HTTP ${resp.status})`);
          err.payload = data;
          throw err;
        }

        for (const row of data.results || []) {
          partialValidationByField[row.fieldName] = row;
          fieldsPendingTargetedRevalidation.delete(row.fieldName);
          const input = document.querySelector(`input[type="file"][name="${CSS.escape(row.fieldName)}"]`);
          if (input) delete input.dataset.targetedRevalidate;
        }

        if (!data.summary?.canContinue) {
          setStepValidated(step, false);
          const failed = failedLabelsFromPayload(data);
          const msg = failed.length
            ? `Corrige en este paso: ${failed.slice(0, 4).join(", ")}.`
            : "Hay documentos por corregir en este paso.";

          showSectionValidationToast("Revisa este paso", msg, {
            type: "warning",
            autoCloseMs: 6500
          });

          errEl.textContent = msg;
          errEl.style.display = "block";
          return false;
        }

        setStepValidated(step, true);
        showSectionValidationToast("Paso validado", `${STEP_LABELS[step] || "La sección"} quedó revisada correctamente.`, {
          type: "success",
          autoCloseMs: 2600
        });
        return true;
      } catch (err) {
        const msg = friendlyErrorMessage(err, "No fue posible validar esta sección.");
        setStepValidated(step, false);
        errEl.textContent = msg;
        errEl.style.display = "block";

        showSectionValidationToast("No se pudo validar", msg, {
          type: "error",
          autoCloseMs: 7000
        });
        return false;
      }
    }

    async function revalidateTargetedCorrectionFiles() {
      await runtimeConfigPromise;

      const hasCorrectionFile = (field) => {
        if (reviewReplacementFilesByField.has(field)) return true;
        const input = document.querySelector(`input[type="file"][name="${CSS.escape(field)}"]`);
        return !!((input?.files || [])[0]);
      };

      const targetFields = Array.from(fieldsPendingTargetedRevalidation)
        .filter((field) => FILE_FIELDS_FOR_REVIEW.has(field))
        .filter(hasCorrectionFile);

      if (!targetFields.length) {
        showSectionValidationToast("Sin archivos corregidos", "Primero reemplaza el archivo desde el resumen. Sólo se validarán archivos que acabas de subir.", {
          type: "warning",
          autoCloseMs: 5200
        });
        return false;
      }

      showSectionValidationToast(
        "Validando archivos corregidos",
        `Sólo validaremos: ${targetFields.map((field) => DOC_LABELS[field] || field).slice(0, 4).join(", ")}.`,
        { type: "loading" }
      );

      errEl.style.display = "none";
      errEl.textContent = "";

      try {
        const mainStep = fieldStep(targetFields[0]) || "";
        const resp = await fetch("/api/registration/final-review", {
          method: "POST",
          body: buildPartialReviewFormData(mainStep, targetFields),
          cache: "no-store"
        });

        const data = await resp.json().catch(() => ({}));

        if (!resp.ok || !data.ok) {
          const err = new Error(data.error || `Error validando archivos corregidos (HTTP ${resp.status})`);
          err.payload = data;
          throw err;
        }

        for (const row of data.results || []) {
          partialValidationByField[row.fieldName] = row;
          fieldsPendingTargetedRevalidation.delete(row.fieldName);
          const input = document.querySelector(`input[type="file"][name="${CSS.escape(row.fieldName)}"]`);
          if (input) delete input.dataset.targetedRevalidate;
        }

        // Mezclar únicamente los resultados revalidados con el resumen existente.
        // Así no se pierden ni se vuelven rojos los documentos que ya estaban aprobados.
        const previousRows = latestReviewPayload?.results || [];
        const updatedByField = new Map((data.results || []).map((row) => [row.fieldName, row]));
        const mergedRows = previousRows.map((row) => updatedByField.get(row.fieldName) || row);
        for (const row of data.results || []) {
          if (!mergedRows.some((existing) => existing.fieldName === row.fieldName)) mergedRows.push(row);
        }
        latestReviewPayload = {
          ...(latestReviewPayload || {}),
          results: mergedRows,
          summary: summarizeRowsForUi(mergedRows),
        };
        renderReviewSummary(latestReviewPayload);

        const failed = failedLabelsFromPayload(latestReviewPayload);
        if (failed.length) {
          showSectionValidationToast("Aún hay correcciones", `Revisa: ${failed.slice(0, 4).join(", ")}.`, {
            type: "warning",
            autoCloseMs: 6500
          });
        } else {
          showSectionValidationToast("Archivos corregidos", "Sólo los archivos reemplazados fueron revalidados y quedaron actualizados.", {
            type: "success",
            autoCloseMs: 2800
          });
        }

        return latestReviewPayload.summary?.canContinue !== false;
      } catch (err) {
        const msg = friendlyErrorMessage(err, "No fue posible validar los archivos corregidos.");
        errEl.textContent = msg;
        errEl.style.display = "block";
        showSectionValidationToast("No se pudo validar", msg, {
          type: "error",
          autoCloseMs: 7000
        });
        return false;
      }
    }

    async function finalizePartialReviews(options = {}) {
      await runtimeConfigPromise;

      setBusyReview(true);
      if (!options.silentLoading) {
        showAppModal("Preparando resumen", "Estamos consolidando los resultados ya obtenidos. No se ejecutará una validación completa nuevamente.", { type: "loading" });
      }
      errEl.style.display = "none";
      errEl.textContent = "";

      try {
        const fd = buildFinalReviewFormData();
        fd.set("finalizeFromPartials", "1");

        const resp = await fetch("/api/registration/final-review", {
          method: "POST",
          body: fd,
          cache: "no-store"
        });

        const data = await resp.json().catch(() => ({}));

        if (!resp.ok || !data.ok) {
          const err = new Error(data.error || `Error preparando resumen (HTTP ${resp.status})`);
          err.payload = data;
          throw err;
        }

        latestReviewPayload = data;
        renderReviewSummary(data);
        setStepValidated(4, data.summary?.canContinue !== false);
        if (!options.silentLoading) {
          showSuccess("Resumen listo", data.summary?.canContinue ? "Ya puedes guardar el registro." : "Hay documentos por corregir. Puedes guardar avance o reemplazar sólo los archivos marcados.");
        }
        return true;
      } catch (err) {
        const msg = friendlyErrorMessage(err, "No fue posible preparar el resumen final.");
        errEl.textContent = msg;
        errEl.style.display = "block";
        showError("No se pudo preparar el resumen", msg);
        return false;
      } finally {
        setBusyReview(false);
      }
    }



    let sectionToastTimer = null;

    function ensureSectionValidationToast() {
      let toast = document.getElementById("section-validation-toast");
      if (toast) return toast;

      toast = document.createElement("div");
      toast.id = "section-validation-toast";
      toast.className = "section-validation-toast";
      toast.innerHTML = `
        <div class="section-toast-icon"></div>
        <div class="section-toast-content">
          <strong></strong>
          <span></span>
        </div>
      `;
      document.body.appendChild(toast);
      return toast;
    }

    function showSectionValidationToast(title, message, options = {}) {
      const toast = ensureSectionValidationToast();
      const type = options.type || "loading";
      const autoCloseMs = Number(options.autoCloseMs || 0);
      const icon = toast.querySelector(".section-toast-icon");
      const titleEl = toast.querySelector("strong");
      const msgEl = toast.querySelector("span");

      clearTimeout(sectionToastTimer);

      toast.className = `section-validation-toast active ${type}`;
      titleEl.textContent = title || "Validando";
      msgEl.textContent = message || "Estamos revisando esta sección.";

      if (type === "loading") {
        icon.innerHTML = '<span class="section-toast-spinner"></span>';
      } else if (type === "success") {
        icon.textContent = "✓";
      } else if (type === "warning") {
        icon.textContent = "!";
      } else {
        icon.textContent = "!";
      }

      if (autoCloseMs > 0) {
        sectionToastTimer = setTimeout(() => {
          toast.classList.remove("active");
        }, autoCloseMs);
      }

      return toast;
    }


    function showAppModal(title, message, options = {}) {
      const type = options.type || "loading";
      const modal = document.getElementById("app-modal");
      const card = document.getElementById("app-modal-card");
      const icon = document.getElementById("app-modal-icon");
      const actions = document.getElementById("app-modal-actions");

      if (!modal || !card || !icon || !actions) return;

      card.className = `app-modal-card ${type === "success" ? "success" : type === "error" ? "error" : ""}`;
      document.getElementById("app-modal-title").textContent = title || "Procesando";
      document.getElementById("app-modal-message").textContent = message || "Espera un momento.";

      if (type === "loading") {
        icon.innerHTML = '<span class="app-modal-spinner"></span>';
        actions.style.display = "none";
      } else {
        icon.textContent = type === "success" ? "✓" : type === "error" ? "!" : "i";
        actions.style.display = "";
      }

      modal.classList.add("active");
    }

    function closeAppModal() {
      document.getElementById("app-modal")?.classList.remove("active");
      const action = appModalAfterClose;
      appModalAfterClose = null;
      if (typeof action === "function") action();
    }

    document.addEventListener("click", (ev) => {
      if (ev.target?.id === "app-modal-close") closeAppModal();
    });

    function showSuccess(title, message, options = {}) {
      appModalAfterClose = typeof options.afterClose === "function" ? options.afterClose : null;
      showAppModal(title, message, { type: "success" });
    }

    function showError(title, message) {
      showAppModal(title, message, { type: "error" });
    }

    function friendlyErrorMessage(err, fallback) {
      const text = err?.message || String(err || "") || fallback || "Ocurrió un error.";
      if (text.includes("DUPLICATE_CURP") || text.includes("ya tiene un registro final") || text.includes("No se puede registrar de nuevo")) {
        return "Esta CURP ya tiene un registro final. No se puede registrar de nuevo.";
      }
      if (text.includes("Unable to parse range")) return "No pudimos guardar el registro. Intenta de nuevo o avisa al equipo de Grupo SEZA.";
      if (text.includes("GEMINI_API_KEY")) return "No pudimos revisar los documentos. Avisa al equipo de Grupo SEZA.";
      return text.length > 180 ? `${text.slice(0, 177)}...` : text;
    }

    function formatMbFromBytes(bytes) {
      const n = Number(bytes || 0);
      if (!n) return "";
      return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    }

    function heavySelectedFileInfo(fieldName) {
      const input = document.querySelector(`input[type="file"][name="${CSS.escape(fieldName)}"]`);
      const file = (input?.files || [])[0];
      if (!file) return null;
      if ((file.size || 0) <= AI_VALIDATION_MAX_FILE_BYTES) return null;
      return {
        fileName: file.name,
        size: file.size || 0,
      };
    }

    function enrichRowWithHeavyFileState(row = {}) {
      if (row?.skippedByWeight) return row;

      const info = heavySelectedFileInfo(row.fieldName);
      if (!info) return row;

      const status = statusForRow(row);
      if (status !== "missing" && status !== "rejected") return row;

      return {
        ...row,
        ok: false,
        status: "rejected",
        severity: "error",
        recommendation: "fix_required",
        fileName: info.fileName || row.fileName,
        issues: [`No se pudo validar porque excede el peso permitido de 5 MB (${formatMbFromBytes(info.size)}).`],
        summary: "No se pudo validar porque excede el peso permitido. Sube otro archivo menor a 5 MB.",
        skippedByWeight: true,
        blocking: true,
        clientHeavyFileFallback: true,
      };
    }

    function friendlyDetailForRow(row) {
      const status = statusForRow(row);

      if (row?.skippedByWeight) {
        const fileName = row.fileName ? `Archivo cargado: ${row.fileName}. ` : "";
        return `${fileName}No se pudo validar porque excede el peso permitido de 5 MB. Sube otro archivo menor a 5 MB.`;
      }

      if (status === "approved") return "Listo. Documento correcto.";
      if (status === "skipped") return "Opcional. No bloquea el registro.";
      if (status === "missing") return detailForRow(row) || "Falta subir este documento.";

      // Antes aquí se mostraba un texto genérico. Eso hacía imposible saber por qué
      // un archivo visualmente correcto quedaba en rojo. Ahora mostramos el motivo
      // real que regresa la IA/back-end: issues[], warnings[] o summary.
      if (status === "warning" || status === "rejected") return detailForRow(row);

      return detailForRow(row);
    }

    function markDraftFiles(filePaths = {}) {
      Object.entries(filePaths || {}).forEach(([fieldName, info]) => {
        const input = document.querySelector(`input[type="file"][name="${CSS.escape(fieldName)}"]`);
        if (!input) return;
        const name = info.originalName || info.relativePath || "archivo guardado";
        showRecoveredFileControl(input, name);
        setFileStatus(input, "ok", "Documento recuperado", "Lo usaremos si no subes uno nuevo.");
      });
    }


    const DOC_LABELS = {
      selfie: "Foto personal / selfie",
      estado_cuenta: "Estado de cuenta bancario",
      ine_frontal: "INE frontal",
      ine_reverso: "INE reverso",
      curp: "CURP",
      nss_file: "Documento NSS",
      constancia: "Constancia de situación fiscal",
      acta: "Acta de nacimiento",
      comprobante: "Comprobante de domicilio",
      licencia: "Licencia de conducir",
      tarjeta: "Tarjeta de circulación",
      poliza: "Póliza de seguro"
    };

    function normalizeNameForValidation(value) {
      return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^A-ZÑ\s]/gi, " ")
        .toUpperCase()
        .replace(/\s{2,}/g, " ");
    }

    function normalizeCurp(v) {
      return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 18);
    }

    function setBusyReview(isBusy) {
      const loading = document.getElementById("review-loading");
      if (loading) loading.classList.toggle("active", Boolean(isBusy));
      submitBtn.disabled = Boolean(isBusy);
      btnText.textContent = isBusy ? "Preparando resumen..." : "Ver resumen";
      btnSpinner.style.display = isBusy ? "inline-block" : "none";
    }

    function collectTextData() {
      const data = {};
      document.querySelectorAll("#document-form input, #document-form select, #document-form textarea").forEach((el) => {
        if (!el.name || el.type === "file") return;
        if ((el.type === "radio" || el.type === "checkbox") && !el.checked) return;
        data[el.name] = el.value || "";
      });
      return data;
    }

    function fillTextData(data = {}) {
      Object.entries(data).forEach(([name, value]) => {
        const elements = Array.from(document.querySelectorAll(`[name="${CSS.escape(name)}"]`));
        elements.forEach((el) => {
          if (el.type === "radio" || el.type === "checkbox") {
            el.checked = String(el.value) === String(value);
          } else if (el.type !== "file") {
            el.value = value || "";
          }
        });
      });
      if (document.querySelector('[name="clabe_mode"]')) {
        applyClabeMode("archivo");
      }
      if (document.querySelector('input[name="nss_mode"]:checked')) {
        applyNssMode(document.querySelector('input[name="nss_mode"]:checked').value);
      }
      applyVacancyRules(data.tipo_vacante || data.tipoVacante || data.vacante || selectedVacancy() || "driver");
    }

    function buildFinalReviewFormData() {
      const form = document.getElementById("document-form");
      const fd = new FormData(form);
      const heavyFiles = [];
      const replacementFields = new Set(reviewReplacementFilesByField.keys());

      for (const [fieldName, file] of reviewReplacementFilesByField.entries()) {
        fd.delete(fieldName);
        if (!file) continue;

        if ((file.size || 0) > AI_VALIDATION_MAX_FILE_BYTES) {
          heavyFiles.push({
            fieldName,
            fileName: file.name || "archivo",
            size: file.size || 0
          });
        } else {
          fd.append(fieldName, file, file.name || fieldName);
        }
      }

      for (const input of form.querySelectorAll('input[type="file"][name]')) {
        if (replacementFields.has(input.name)) continue;
        const file = (input.files || [])[0];
        if (!file) continue;

        if ((file.size || 0) > AI_VALIDATION_MAX_FILE_BYTES) {
          fd.delete(input.name);
          heavyFiles.push({
            fieldName: input.name,
            fileName: file.name,
            size: file.size || 0
          });
        }
      }

      if (heavyFiles.length) {
        fd.set("aiSkippedHeavyFiles", JSON.stringify(heavyFiles));
      }

      if (latestReviewPayload?.results?.length) {
        try {
          fd.set("clientReviewPayload", JSON.stringify(latestReviewPayload));
        } catch (_) {}
      }

      fd.set("jobId", globalJobId);
      const nombreNormalizado = normalizeNameForValidation(document.getElementById("nombre").value || "").trim();
      fd.set("nombre", nombreNormalizado);
      fd.set("clabe_mode", "archivo");
      fd.set("telefono", document.getElementById("telefono").value || "");
      fd.set("tipo_vacante", selectedVacancy() || "driver");

      if (loadedDraftCurp) {
        fd.set("draftCurp", loadedDraftCurp);
        fd.set("useDraftFiles", "1");
      }

      return fd;
    }

    function statusForRow(row) {
      if (row?.skippedByWeight) return "rejected";
      if (row.status === "skipped") return "skipped";
      if (row.status === "warning" || row.severity === "warning") return "warning";
      if (row.status === "approved" || row.ok === true) return "approved";
      if (row.status === "missing") return "missing";
      return "rejected";
    }

    function iconForStatus(status) {
      if (status === "approved") return "✅";
      if (status === "warning") return "🟡";
      if (status === "missing") return "📎";
      if (status === "skipped") return "➖";
      return "🔴";
    }

    function detailForRow(row) {
      const warnings = row?.warnings || [];
      if (row?.status === "warning" || row?.severity === "warning") {
        if (warnings.length) return warnings.slice(0, 3).join(" ");
        return row?.summary || "Documento válido con observación.";
      }

      const issues = row?.issues || [];
      if (row?.status === "rejected" || row?.ok === false) {
        if (issues.length) return issues.slice(0, 3).join(" ");
        return row?.summary || "Documento no aprobado.";
      }

      return row?.summary || "Documento aprobado.";
    }

    function getReviewRoot() {
      const form = document.getElementById("document-form");
      if (!form) return null;

      let root = document.getElementById("review-summary-root");
      if (!root) {
        root = document.createElement("div");
        root.id = "review-summary-root";
        root.className = "review-summary-root";
      }

      // El resumen debe vivir como hijo directo del form, fuera de cualquier .section.step.
      // No usamos #err como referencia porque en algunas versiones está dentro del paso 4,
      // y insertBefore falla si el nodo de referencia no es hijo directo del form.
      if (root.parentElement !== form) {
        const firstStep = form.querySelector(":scope > .section.step");
        form.insertBefore(root, firstStep || null);
      }

      return root;
    }

    function relocateReviewBlocks() {
      const root = getReviewRoot();
      if (!root) return;

      ["review-loading", "ai-review-screen"].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.parentElement !== root) {
          root.appendChild(el);
        }
      });
    }

    function ensureReviewAtTop() {
      relocateReviewBlocks();
      document.getElementById("ai-review-screen")?.classList.add("active");
      document.body.classList.add("review-summary-mode");
    }

    function focusReviewSummary() {
      const screen = document.getElementById("ai-review-screen");
      requestAnimationFrame(() => {
        screen?.scrollIntoView({ behavior: "smooth", block: "start" });
        screen?.focus?.({ preventScroll: true });
      });
    }

    function renderReviewSummary(payload) {
      const safePayload = payload && typeof payload === "object" ? payload : { summary: {}, results: [] };
      relocateReviewBlocks();

      const screen = document.getElementById("ai-review-screen");
      const list = document.getElementById("review-list");
      const alert = document.getElementById("review-alert");
      screen?.classList.add("active");
      document.body.classList.add("review-summary-mode");

      latestReviewPayload = safePayload;
      syncStepChecksFromPayload(safePayload);
      const rows = visibleReviewRows(safePayload.results || []).map(enrichRowWithHeavyFileState);
      latestReviewPayload = {
        ...(latestReviewPayload || {}),
        results: rows,
        summary: summarizeRowsForUi(rows),
      };
      const summary = latestReviewPayload.summary;

      document.getElementById("review-score-number").textContent = `${summary.approved || 0}/${Math.max((summary.total || rows.length) - (summary.skipped || 0), 0)}`;
      document.getElementById("stat-approved").textContent = summary.approved || 0;
      document.getElementById("stat-warning").textContent = summary.warnings || 0;
      document.getElementById("stat-rejected").textContent = summary.rejected || 0;
      document.getElementById("stat-missing").textContent = summary.missing || 0;
      document.getElementById("stat-skipped").textContent = summary.skipped || 0;

      const title = document.getElementById("review-title");
      const subtitle = document.getElementById("review-subtitle");

      if (summary.canContinue) {
        title.textContent = summary.warnings ? "Documentos válidos con observaciones" : "Documentos aprobados";
        subtitle.textContent = summary.warnings
          ? "Puedes guardar el registro. Los documentos marcados en amarillo son válidos, pero no están a nombre del driver o requieren observación operativa."
          : "La IA no detectó errores bloqueantes. Puedes finalizar la revisión o guardar tu avance.";
        if (summary.warnings) {
          alert.style.display = "";
          alert.textContent = "Amarillo = documento válido con observación. Verde = válido y a nombre del driver. Rojo = inválido o no corresponde.";
        } else {
          alert.style.display = "none";
        }
      } else {
        title.textContent = "Hay documentos por corregir";
        subtitle.textContent = "Sube nuevamente los documentos marcados y vuelve a validar. También puedes guardar tu avance; para continuar después deberás ingresar tu CURP.";
        alert.style.display = "";
        alert.textContent = "Puedes guardar el avance sin capturar CURP manualmente: el sistema la tomará del documento CURP detectado por IA y guardará rutas locales de los archivos para reutilizarlos al continuar.";
      }

      list.innerHTML = rows.map((row) => {
        const status = statusForRow(row);
        const label = row.label || DOC_LABELS[row.fieldName] || row.fieldName;
        const canReplace = !row.skippedByWeight && (status === "rejected" || status === "missing" || status === "warning");
        const canUploadLighter = !!row.skippedByWeight;
        const fileName = row.fileName ? `<div class="review-item-file">Archivo revisado: ${row.fileName}</div>` : "";
        const model = "";
        const owner = row.ownerCheckApplies
          ? `<div class="review-item-file">Titular/propietario: ${row.nameFound || "No detectado"} · ${row.ownerMatchesDriver ? "Coincide con driver" : "Observación"}</div>`
          : "";

        return `
          <div class="review-item ${status} ${fieldsPendingTargetedRevalidation.has(row.fieldName) ? "pending-upload" : ""}" data-field="${row.fieldName}">
            <div class="review-icon">${iconForStatus(status)}</div>
            <div>
              <div class="review-item-title">${label}</div>
              <div class="review-item-detail">${friendlyDetailForRow(row)}</div>
              ${fileName}
              ${owner}
              ${model}
            </div>
            <div class="review-item-actions">
              ${canUploadLighter ? `<button type="button" class="review-replace-btn" data-field="${row.fieldName}">Subir otro archivo</button>` : ""}
              ${canReplace ? `<button type="button" class="review-replace-btn" data-field="${row.fieldName}">${status === "warning" ? "Cambiar archivo" : "Reemplazar archivo"}</button>` : ""}
              ${fieldsPendingTargetedRevalidation.has(row.fieldName) ? `<div class="review-inline-upload-note">Nuevo archivo listo: ${row.pendingFileName || "seleccionado"}</div>` : ""}
            </div>
          </div>
        `;
      }).join("");

      document.getElementById("review-finish-btn").disabled = !summary.canContinue;
      document.getElementById("review-finish-btn").textContent = summary.canContinue ? "Guardar registro" : "Corrige documentos primero";

      screen.classList.add("active");
      screen.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function runFinalAiReview() {
      await runtimeConfigPromise;

      setBusyReview(true);
      showAppModal("Revisando documentos", "Estamos validando tus archivos. No cierres esta ventana.", { type: "loading" });
      errEl.style.display = "none";
      errEl.textContent = "";

      try {
        const resp = await fetch("/api/registration/final-review", {
          method: "POST",
          body: buildFinalReviewFormData(),
          cache: "no-store"
        });

        const data = await resp.json().catch(() => ({}));

        if (!resp.ok || !data.ok) {
          const err = new Error(data.error || `Error en revisión IA (HTTP ${resp.status})`);
          err.payload = data;
          throw err;
        }

        renderReviewSummary(data);
        showSuccess("Revisión lista", data.summary?.canContinue ? "Tus documentos ya fueron revisados. Puedes guardar el registro." : "Hay documentos por corregir. Revisa el resumen.");
      } catch (err) {
        const msg = friendlyErrorMessage(err, "No fue posible ejecutar la revisión IA.");
        errEl.textContent = msg;
        errEl.style.display = "block";
        showError("No se pudo validar", msg);
      } finally {
        setBusyReview(false);
      }
    }


    function validateReadyForLocalSave() {
      if (!latestReviewPayload?.summary?.canContinue) {
        errEl.textContent = "Primero corrige documentos faltantes o rechazados y vuelve a validar con IA.";
        errEl.style.display = "block";
        return false;
      }

      if (loadedDraftCurp) return true;

      const requiredFiles = Array.from(document.querySelectorAll('input[type="file"]'))
        .filter((input) => !input.disabled && input.required);

      for (const input of requiredFiles) {
        if (!(input.files || [])[0]) {
          markInvalid(input, "Para guardar el registro, vuelve a subir este archivo.");
          return false;
        }
      }

      return true;
    }

    async function saveRegistrationAndGenerateCredential() {
      if (!validateReadyForLocalSave()) return;

      const btn = document.getElementById("review-finish-btn");
      const resultBox = document.getElementById("archive-result");
      const previousText = btn.textContent;

      btn.disabled = true;
      btn.textContent = "Guardando registro…";
      showAppModal("Guardando registro", "Estamos guardando tu información. No cierres esta ventana.", { type: "loading" });
      resultBox.style.display = "none";
      resultBox.innerHTML = "";

      try {
        const resp = await fetch("/api/registration/save-local", {
          method: "POST",
          body: buildFinalReviewFormData(),
          cache: "no-store"
        });

        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || `Error guardando registro (HTTP ${resp.status})`);
        }

        resultBox.style.display = "";
        resultBox.innerHTML = `
          <strong>Registro enviado correctamente.</strong><br>
          Gracias. Tu información fue guardada y será revisada por el equipo de Grupo SEZA.
        `;

        const toast = document.getElementById("draft-toast");
        toast.textContent = "Registro enviado correctamente.";
        toast.classList.add("active");

        showSuccess("Registro enviado", "Gracias. Tu información fue guardada correctamente.", {
          afterClose: resetForNextDriver
        });
        btn.textContent = "Registro enviado";
        setTimeout(resetForNextDriver, 3500);
      } catch (err) {
        const msg = friendlyErrorMessage(err, "No fue posible guardar el registro.");
        errEl.textContent = msg;
        errEl.style.display = "block";
        showError("No se pudo guardar", msg);
        btn.disabled = false;
        btn.textContent = previousText;
      }
    }



    function normalizeDetectedCurp(value) {
      return String(value || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 18);
    }

    function findCurpInText(value) {
      const text = String(value || "").toUpperCase();
      const match = text.match(/[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d/);
      return match ? normalizeDetectedCurp(match[0]) : "";
    }

    function getCurpFromLatestReview() {
      const rows = latestReviewPayload?.results || [];
      const curpRow = rows.find((row) => row.fieldName === "curp");

      const candidates = [
        curpRow?.fields?.curp,
        curpRow?.curp,
        curpRow?.summary,
        ...(curpRow?.issues || []),
        ...(curpRow?.warnings || [])
      ];

      for (const candidate of candidates) {
        const direct = normalizeDetectedCurp(candidate);
        if (direct.length === 18) return direct;

        const fromText = findCurpInText(candidate);
        if (fromText.length === 18) return fromText;
      }

      return "";
    }


    function draftKey(curp) {
      return DRAFT_PREFIX + normalizeCurp(curp);
    }

    async function saveDraftForLater() {
      const curp = getCurpFromLatestReview();

      if (!curp || curp.length < 18) {
        errEl.textContent = "No fue posible guardar el avance porque la IA no detectó una CURP válida en el documento CURP. Sube un documento CURP legible y vuelve al resumen para guardar avance.";
        errEl.style.display = "block";
        return;
      }

      const toast = document.getElementById("draft-toast");
      toast.textContent = "Guardando avance…";
      toast.classList.add("active");
      showAppModal("Guardando avance", "Estamos guardando tu avance para que puedas continuar después.", { type: "loading" });

      try {
        const resp = await fetch("/api/registration/save-draft-local", {
          method: "POST",
          body: buildFinalReviewFormData(),
          cache: "no-store"
        });

        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || `No fue posible guardar el avance (HTTP ${resp.status}).`);
        }

        loadedDraftCurp = data.curp || curp;

        if (data.credentialGenerated) {
          toast.textContent = `Avance guardado. Para continuar después, ingresa tu CURP: ${loadedDraftCurp}.`;
          showSuccess("Avance guardado");
        } else {
          const pendingReasons = Array.isArray(data.credentialPendingReasons) ? data.credentialPendingReasons : [];
          toast.textContent = `Avance guardado correctamente. Para continuar después, ingresa tu CURP: ${loadedDraftCurp}.`;
          showSuccess("Avance guardado", pendingReasons.length ? `La credencial quedó pendiente por: ${pendingReasons.join(" ")}` : "Podrás continuar después ingresando tu CURP.");
        }
        setTimeout(() => toast.classList.remove("active"), 8000);
      } catch (err) {
        const msg = friendlyErrorMessage(err, "No fue posible guardar el avance.");
        errEl.textContent = msg;
        errEl.style.display = "block";
        showError("No se pudo guardar el avance", msg);
      }
    }


    async function loadDraftByCurp(curpRaw) {
      const curp = normalizeCurp(curpRaw);
      const note = document.getElementById("resume-note");

      if (!curp || curp.length < 18) {
        setLandingMode("resume");
        note.textContent = "Ingresa una CURP válida de 18 caracteres.";
        showError("CURP inválida", "Ingresa una CURP de 18 caracteres.");
        return;
      }

      hardResetForm();
      setLandingMode("resume");
      showAppModal("Buscando avance", "Estamos buscando tu registro y archivos guardados.", { type: "loading" });

      try {
        const resp = await fetch(`/api/registration/draft-local/${encodeURIComponent(curp)}`, {
          method: "GET",
          cache: "no-store"
        });

        const data = await resp.json().catch(() => ({}));

        if (!resp.ok || !data.ok) {
          if (resp.status === 409 || data.duplicateRegistered) {
            const msg = data.error || "Esta CURP ya tiene un registro final. No se puede registrar de nuevo.";
            note.textContent = msg;
            showError("Registro existente", msg);
            return;
          }

          // Compatibilidad con avances antiguos en localStorage.
          const raw = localStorage.getItem(draftKey(curp));
          if (!raw) {
            note.textContent = data.error || "No encontramos un avance para esa CURP.";
            showError("Sin avance", note.textContent);
            return;
          }

          const draft = JSON.parse(raw);
          fillTextData(draft.data || {});
          latestReviewPayload = draft.latestReviewPayload || null;
          loadedDraftCurp = curp;

          showRegistrationInterface();
          const hasLocalReviewRows = Array.isArray(latestReviewPayload?.results) && latestReviewPayload.results.length > 0;
          if (hasLocalReviewRows) {
            renderReviewSummary(latestReviewPayload);
            focusReviewSummary();
          } else {
            showStep(1);
          }

          note.textContent = "Avance cargado desde navegador. Si falta un archivo, vuelve a subirlo.";
          showSuccess("Avance cargado", hasLocalReviewRows ? "Revisa el resumen y reemplaza únicamente lo que falte." : "No había resumen guardado; revisa los datos del expediente.");
          return;
        }

        const draft = data.draft || {};
        fillTextData(draft.data || {});
        latestReviewPayload = draft.latestReviewPayload || null;
        loadedDraftCurp = draft.curp || curp;
        resetPartialValidationState();
        if (latestReviewPayload?.results?.length) {
          for (const row of latestReviewPayload.results) {
            partialValidationByField[row.fieldName] = row;
          }
          stepValidationOk[1] = true;
          stepValidationOk[2] = true;
          stepValidationOk[3] = true;
          stepValidationOk[4] = true;
        }

        const filePaths = draft.filePaths || {};
        const fileNames = Object.values(filePaths)
          .map((x) => x.originalName || x.relativePath)
          .filter(Boolean);

        markDraftFiles(filePaths);

        showRegistrationInterface();

        const hasReviewRows = Array.isArray(latestReviewPayload?.results) && latestReviewPayload.results.length > 0;
        const hasRecoveredFiles = Object.keys(filePaths || {}).length > 0;

        if (hasReviewRows) {
          renderReviewSummary(latestReviewPayload);
          focusReviewSummary();
          note.textContent = "Avance cargado correctamente.";
          showSuccess("Avance cargado", "Revisa el resumen y corrige sólo lo marcado.");
        } else if (hasRecoveredFiles) {
          note.textContent = "Avance cargado correctamente. Estamos reconstruyendo el resumen con los archivos recuperados.";
          showSectionValidationToast("Validando avance recuperado", "No había resumen guardado; se revisarán los archivos recuperados para mostrarlo nuevamente.", {
            type: "loading"
          });
          await runFinalAiReview();
        } else {
          showStep(1);
          note.textContent = "Avance cargado correctamente, pero no encontramos archivos guardados para mostrar resumen.";
          showSuccess("Avance cargado", "Revisa los datos del expediente y continúa el registro.");
        }
      } catch (e) {
        const msg = friendlyErrorMessage(e, "No fue posible cargar el avance.");
        note.textContent = msg;
        showError("No se pudo cargar", msg);
      }
    }


    function digits(value) {
      return String(value || "").replace(/\D+/g, "");
    }

    function normalizePhone(value) {
      const d = digits(value);
      return d.length < 10 ? null : d.slice(0, 10);
    }

    function normalizeClabe(value) {
      const d = digits(value);
      if (!d) return "";
      return d.length < 18 ? null : d.slice(0, 18);
    }

    function normalizeNss(value) {
      const d = digits(value);
      if (!d) return "";
      return d.length < 11 ? null : d.slice(0, 11);
    }

    function onlyDigitsInput(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", () => {
        el.value = el.value.replace(/\D+/g, "");
      });
    }

    function markInvalid(el, msg) {
      if (!el) {
        errEl.textContent = msg || "Revisa la información capturada.";
        errEl.style.display = "block";
        return false;
      }
      el.classList.add("invalid");
      errEl.textContent = msg || "Revisa este campo.";
      errEl.style.display = "block";
      try {
        el.focus({ preventScroll: true });
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (_) {}
      return false;
    }

    function clearInvalid(el) {
      if (el) el.classList.remove("invalid");
    }

    function shortFileName(name) {
      if (!name) return "";
      return name.length > 38 ? name.slice(0, 35) + "…" : name;
    }


    function fileFieldKey(input) {
      return input?.name || input?.id || "";
    }

    function clearRecoveredFileControl(input) {
      if (!input) return;
      const key = fileFieldKey(input);
      const parent = input.parentElement || input.closest(".col-12,.col-6") || input.parentNode;
      parent?.querySelectorAll(`.recovered-file-control[data-for="${CSS.escape(key)}"]`).forEach((el) => el.remove());
      input.classList.remove("file-input-has-draft");
      delete input.dataset.draftRecovered;
      delete input.dataset.draftFileName;
    }

    function showRecoveredFileControl(input, fileName) {
      if (!input) return;

      const key = fileFieldKey(input);
      const parent = input.parentElement || input.closest(".col-12,.col-6") || input.parentNode;
      if (!parent) return;

      clearRecoveredFileControl(input);

      input.dataset.draftRecovered = "1";
      input.dataset.draftFileName = fileName || "Documento recuperado";
      input.classList.add("file-input-has-draft");

      const box = document.createElement("div");
      box.className = "recovered-file-control";
      box.dataset.for = key;
      box.innerHTML = `
        <span>
          <strong>Documento recuperado</strong>
          <small>${shortFileName(fileName || "Archivo guardado")}</small>
        </span>
        <button type="button" class="recovered-file-replace">Reemplazar</button>
      `;

      box.querySelector(".recovered-file-replace")?.addEventListener("click", () => {
        input.click();
      });

      input.insertAdjacentElement("beforebegin", box);
    }

    function getFileStatusEl(input) {
      let statusEl = input.nextElementSibling;
      if (!statusEl || !statusEl.classList.contains("file-status")) {
        statusEl = document.createElement("div");
        statusEl.className = "file-status";
        input.insertAdjacentElement("afterend", statusEl);
      }
      return statusEl;
    }

    function setFileStatus(input, type, title, detail = "") {
      const statusEl = getFileStatusEl(input);
      statusEl.className = `file-status is-${type}`;
      statusEl.innerHTML = `
        <span class="status-icon">📄</span>
        <span>
          ${title}
          ${detail ? `<small>${detail}</small>` : ""}
        </span>
      `;
    }

    function visualStepNumber(stepNum) {
      return !isVehicleStepRequired() && Number(stepNum) === 4 ? 3 : Number(stepNum);
    }

    function updateProgress(step) {
      document.querySelectorAll(".progress-step").forEach((stepEl, index) => {
        const stepNum = index + 1;
        const visualNum = visualStepNumber(stepNum);
        stepEl.classList.remove("active", "completed", "validating", "not-applicable", "visually-renumbered");
        const dot = stepEl.querySelector(".progress-dot");

        if (stepNum === 3 && !isVehicleStepRequired()) {
          stepEl.classList.add("not-applicable");
          if (dot) dot.innerHTML = "—";
        } else if (stepValidationOk[stepNum]) {
          stepEl.classList.add("completed");
          if (dot) dot.innerHTML = "✓";
        } else if (stepValidationPending[stepNum]) {
          stepEl.classList.add("validating");
          if (dot) dot.innerHTML = '<span class="progress-dot-spinner"></span>';
        } else if (stepNum === step) {
          stepEl.classList.add("active");
          if (stepNum !== visualNum) stepEl.classList.add("visually-renumbered");
          if (dot) dot.innerHTML = String(visualNum);
        } else if (dot) {
          if (stepNum !== visualNum) stepEl.classList.add("visually-renumbered");
          dot.innerHTML = String(visualNum);
        }
      });
    }

    function showStep(n) {
      document.body.classList.remove("review-summary-mode");
      document.getElementById("ai-review-screen")?.classList.remove("active");
      document.getElementById("review-loading")?.classList.remove("active");
      if (Number(n) === 3 && !isVehicleStepRequired()) n = 4;
      document.querySelectorAll(".step").forEach((s) => {
        s.classList.toggle("active", Number(s.dataset.step) === Number(n));
      });
      errEl.textContent = "";
      errEl.style.display = "none";
      document.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
      updateProgress(Number(n));

      try {
        document.querySelector(".right-panel")?.scrollTo({ top: 0, behavior: "smooth" });
      } catch (_) {}
    }

    function applyClabeMode(mode) {
      const clabeFileWrap = document.getElementById("clabe_file_wrap");
      const clabeFile = document.getElementById("estado_cuenta");
      const clabeMode = document.querySelector('[name="clabe_mode"]');

      if (clabeMode) clabeMode.value = "archivo";
      if (clabeFileWrap) clabeFileWrap.style.display = "";
      if (clabeFile) {
        clabeFile.disabled = false;
        clabeFile.required = true;
      }
    }

    function applyNssMode(mode) {
      const nssFileWrap = document.getElementById("nss_file_wrap");
      const nssNumWrap = document.getElementById("nss_num_wrap");
      const nssFile = document.getElementById("nss_file");
      const nssNum = document.getElementById("nss_num");

      if (!nssFileWrap || !nssNumWrap || !nssFile || !nssNum) return;

      if (mode === "numero") {
        nssNumWrap.style.display = "";
        nssNum.disabled = false;
        nssNum.required = true;

        nssFileWrap.style.display = "none";
        nssFile.disabled = true;
        nssFile.required = false;
        nssFile.value = "";
        clearInvalid(nssFile);
      } else {
        nssFileWrap.style.display = "";
        nssFile.disabled = false;
        nssFile.required = true;

        nssNumWrap.style.display = "none";
        nssNum.disabled = true;
        nssNum.required = false;
        nssNum.value = "";
        clearInvalid(nssNum);
      }
    }

    function validateFileSizes() {
      const recommendedFile = 5 * 1024 * 1024;
      const practicalTotal = 150 * 1024 * 1024;
      let total = 0;
      const warnings = [];

      for (const input of document.querySelectorAll('input[type="file"]')) {
        const file = (input.files || [])[0];
        if (!file) continue;

        total += file.size || 0;
        if ((file.size || 0) > recommendedFile) {
          warnings.push(`${file.name} supera 5 MB`);
        }
      }

      if (total > practicalTotal) {
        warnings.push("El total de archivos es muy alto");
      }

      if (warnings.length) {
        errEl.textContent = `${warnings[0]}. Puedes continuar al resumen; este archivo no se enviará a IA por peso, pero deberás subir otro archivo menor a 5 MB.`;
        errEl.style.display = "block";
        showSectionValidationToast("Archivo pesado", "No bloquearemos el resumen. Los archivos mayores a 5 MB se marcarán como no validados por peso.", {
          type: "warning",
          autoCloseMs: 6500
        });
      }

      return true;
    }

    function hardResetForm() {
      document.body.classList.remove("review-summary-mode");
      const form = document.getElementById("document-form");
      if (!form) return;

      form.reset();
      document.querySelectorAll(".file-status").forEach((el) => el.remove());
      document.querySelectorAll(".recovered-file-control").forEach((el) => el.remove());
      document.querySelectorAll("input.file-input-has-draft").forEach((input) => {
        input.classList.remove("file-input-has-draft");
        delete input.dataset.draftRecovered;
        delete input.dataset.draftFileName;
      });
      document.getElementById("ai-review-screen")?.classList.remove("active");
      document.getElementById("review-loading")?.classList.remove("active");
      document.getElementById("archive-result") && (document.getElementById("archive-result").style.display = "none");
      latestReviewPayload = null;
      loadedDraftCurp = "";
      reviewReplacementFilesByField.clear();
      const vacancyInput = document.getElementById("tipo_vacante");
      if (vacancyInput) vacancyInput.value = "";
      document.getElementById("vacancy-box")?.classList.remove("active");
      document.getElementById("resume-box")?.classList.remove("active");
      document.getElementById("landing-panel-vacancy")?.setAttribute("hidden", "");
      document.getElementById("landing-panel-resume")?.setAttribute("hidden", "");
      document.getElementById("landing-placeholder")?.removeAttribute("hidden");
      document.getElementById("new-registration-btn")?.classList.remove("is-selected");
      document.getElementById("show-resume-btn")?.classList.remove("is-selected");
      document.getElementById("new-registration-btn")?.setAttribute("aria-selected", "false");
      document.getElementById("show-resume-btn")?.setAttribute("aria-selected", "false");
      const resumeCurpInput = document.getElementById("resume-curp");
      if (resumeCurpInput) resumeCurpInput.value = "";
      document.querySelectorAll("[data-vacancy]").forEach((btn) => btn.classList.remove("active"));
      resetPartialValidationState();
      resetPartialValidationState();
      for (const id of ["direccion_place_id", "direccion_lat", "direccion_lng"]) {
        const el = document.getElementById(id);
        if (el) el.value = "";
      }
      const mapsHelp = document.getElementById("maps-help");
      if (mapsHelp) {
        mapsHelp.textContent = mapsAutocompleteReady
          ? "Busca tu dirección y selecciona una opción de Google Maps."
          : "Captura tu dirección completa.";
        mapsHelp.className = "maps-help warn";
      }

      applyClabeMode("archivo");
      applyNssMode("archivo");
      showStep(1);
    }

    function validateStep1() {
      const nombreEl = document.getElementById("nombre");
      const telEl = document.getElementById("telefono");
      const dirEl = document.getElementById("direccion");
      const edoEl = document.getElementById("estado_cuenta");
      const selfieEl = document.getElementById("selfie");

      nombreEl.value = normalizeNameForValidation(nombreEl.value || "").trim();

      if (!nombreEl?.value.trim()) return markInvalid(nombreEl, "Ingrese su nombre completo.");
      if (!normalizePhone(telEl?.value)) return markInvalid(telEl, "Ingrese teléfono a 10 dígitos.");
      telEl.value = normalizePhone(telEl.value);
      if (!selfieEl?.files?.length && !loadedDraftCurp) return markInvalid(selfieEl, "Debe cargar su foto personal.");
      if (!dirEl?.value.trim()) return markInvalid(dirEl, "Ingrese dirección completa.");
      if (mapsAutocompleteReady && !document.getElementById("direccion_place_id")?.value) {
        return markInvalid(dirEl, "Selecciona una dirección de la lista de Google Maps.");
      }
      if (!edoEl?.files?.length && !loadedDraftCurp) {
        return markInvalid(edoEl, "Debe cargar el estado de cuenta bancario.");
      }

      return true;
    }

    function validateStep2() {
      const requiredIds = ["ine_frontal", "ine_reverso", "curp", "acta", "comprobante", "constancia"];
      for (const id of requiredIds) {
        const el = document.getElementById(id);
        if (el && !el.disabled && !el.files?.length && !loadedDraftCurp) {
          return markInvalid(el, `Debe cargar ${DOC_LABELS[id] || id}.`);
        }
      }

      const nssMode = document.querySelector('input[name="nss_mode"]:checked')?.value || "archivo";
      if (nssMode === "archivo") {
        const nssFile = document.getElementById("nss_file");
        if (!nssFile?.files?.length && !loadedDraftCurp) return markInvalid(nssFile, "Debe cargar documento NSS.");
      } else {
        const nssNum = document.getElementById("nss_num");
        const nss = normalizeNss(nssNum?.value);
        if (!nss) return markInvalid(nssNum, "Ingrese NSS de 11 dígitos.");
        nssNum.value = nss;
      }

      return true;
    }

    function validateStep3() {
      const vacancy = selectedVacancy() || "driver";
      const licencia = document.getElementById("licencia");

      if (vacancy === "ayudante") {
        return true;
      }

      if ((vacancy === "driver" || vacancy === "chofer") && !licencia?.files?.length && !loadedDraftCurp) {
        return markInvalid(licencia, "Debe cargar licencia de conducir.");
      }

      return true;
    }

    function validateStep4() {
      const ref1NomEl = document.getElementById("ref1_nombre");
      const ref2NomEl = document.getElementById("ref2_nombre");
      const ref1TelEl = document.getElementById("ref1_tel");
      const ref2TelEl = document.getElementById("ref2_tel");

      if (!ref1NomEl?.value.trim()) return markInvalid(ref1NomEl, "Falta primera referencia.");
      if (!ref2NomEl?.value.trim()) return markInvalid(ref2NomEl, "Falta segunda referencia.");

      const r1 = normalizePhone(ref1TelEl?.value);
      if (!r1) return markInvalid(ref1TelEl, "Primera referencia: teléfono a 10 dígitos.");

      const r2 = normalizePhone(ref2TelEl?.value);
      if (!r2) return markInvalid(ref2TelEl, "Segunda referencia: teléfono a 10 dígitos.");

      ref1TelEl.value = r1;
      ref2TelEl.value = r2;
      return true;
    }

    // Inicialización robusta de toggles y navegación.
    document.querySelectorAll('input[name="clabe_mode"]').forEach((radio) => {
      radio.addEventListener("change", () => applyClabeMode(radio.value));
    });

    document.querySelectorAll('input[name="nss_mode"]').forEach((radio) => {
      radio.addEventListener("change", () => applyNssMode(radio.value));
    });

    onlyDigitsInput("telefono");
    onlyDigitsInput("clabe");
    onlyDigitsInput("nss_num");
    onlyDigitsInput("ref1_tel");
    onlyDigitsInput("ref2_tel");

    document.getElementById("nombre")?.addEventListener("input", (e) => {
      e.target.value = normalizeNameForValidation(e.target.value);
    });

    document.getElementById("next-1")?.addEventListener("click", () => {
      if (!validateStep1()) return;
      startSectionValidation(1, targetedFieldsForStep(1));
      showStep(2);
    });

    document.getElementById("next-2")?.addEventListener("click", () => {
      if (!validateStep2()) return;
      startSectionValidation(2, targetedFieldsForStep(2));
      showStep(isVehicleStepRequired() ? 3 : 4);
    });

    document.getElementById("next-3")?.addEventListener("click", () => {
      if (!validateStep3()) return;
      if (isVehicleStepRequired()) startSectionValidation(3, targetedFieldsForStep(3));
      showStep(4);
    });

    document.getElementById("back-2")?.addEventListener("click", () => showStep(1));
    document.getElementById("back-3")?.addEventListener("click", () => showStep(2));
    document.getElementById("back-4")?.addEventListener("click", () => showStep(isVehicleStepRequired() ? 3 : 2));

    document.getElementById("document-form")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      errEl.style.display = "none";
      errEl.textContent = "";

      if (!validateFileSizes()) return;
      if (!validateStep4()) return;

      setStepValidated(4, true);
      await waitForPendingSectionValidations({ modal: true });

      await finalizePartialReviews();
    });

    applyClabeMode("archivo");
    applyNssMode(document.querySelector('input[name="nss_mode"]:checked')?.value || "archivo");


    
    function resetForNextDriver() {
      hardResetForm();
      document.body.classList.add("pre-registration");
      setLandingMode(null);
      const resumeCard = document.getElementById("resume-card");
      if (resumeCard) {
        resumeCard.style.display = "";
        resumeCard.classList.add("active");
      }
      const note = document.getElementById("resume-note");
      if (note) note.textContent = "";
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

function showRegistrationInterface() {
      document.body.classList.remove("pre-registration");
      const resumeCard = document.getElementById("resume-card");
      if (resumeCard) resumeCard.style.display = "none";
      errEl.style.display = "none";
      errEl.textContent = "";
    }

    function handleFileInputSelection(input, options = {}) {
      const f = options.fileOverride || (input?.files || [])[0];
      if (!input || !f) return;

      const fromSummary = options.fromSummary === true
        || input.dataset.targetedRevalidate === "1"
        || document.body.classList.contains("review-summary-mode")
        || document.getElementById("ai-review-screen")?.classList.contains("active");

      clearRecoveredFileControl(input);

      if (fromSummary) {
        reviewReplacementFilesByField.set(input.name, f);
        input.dataset.targetedRevalidate = "1";
        markFieldForTargetedRevalidation(input.name);
        delete partialValidationByField[input.name];

        if (latestReviewPayload?.results) {
          latestReviewPayload.results = latestReviewPayload.results.map((row) =>
            row.fieldName === input.name ? { ...row, pendingFileName: shortFileName(f.name) } : row
          );
        }

        setFileStatus(input, "selected", `Archivo corregido: ${shortFileName(f.name)}`, "Sólo este archivo se validará de nuevo desde el resumen.");

        if (latestReviewPayload) {
          renderReviewSummary(latestReviewPayload);
          ensureReviewAtTop();
          focusReviewSummary();
        }
        return;
      }

      reviewReplacementFilesByField.delete(input.name);
      invalidateStep(fieldStep(input.name));
      setFileStatus(input, "selected", `Archivo seleccionado: ${shortFileName(f.name)}`, "Lo revisaremos al continuar este paso.");
    }

    function openReviewReplacementPicker(field) {
      const input = document.querySelector(`input[type="file"][name="${CSS.escape(field)}"]`);
      if (!input) return;

      input.dataset.targetedRevalidate = "1";
      markFieldForTargetedRevalidation(field);
      ensureReviewAtTop();

      const picker = document.createElement("input");
      picker.type = "file";
      picker.accept = input.getAttribute("accept") || ".pdf,.jpg,.jpeg,.png";
      picker.setAttribute("aria-hidden", "true");
      picker.style.position = "fixed";
      picker.style.left = "-10000px";
      picker.style.top = "0";
      picker.style.width = "1px";
      picker.style.height = "1px";
      picker.style.opacity = "0";

      picker.addEventListener("change", () => {
        const file = (picker.files || [])[0];
        if (!file) {
          picker.remove();
          ensureReviewAtTop();
          focusReviewSummary();
          return;
        }

        reviewReplacementFilesByField.set(field, file);

        try {
          if (typeof DataTransfer !== "undefined") {
            const transfer = new DataTransfer();
            transfer.items.add(file);
            input.files = transfer.files;
          }
        } catch (_) {
          // Aunque el navegador no permita asignar FileList, el archivo queda
          // resguardado en reviewReplacementFilesByField y se adjunta al FormData.
        }

        handleFileInputSelection(input, { fromSummary: true, fileOverride: file });
        picker.remove();
      }, { once: true });

      document.body.appendChild(picker);
      picker.click();
    }

    document.querySelectorAll('input[type="file"]').forEach(input => {
      input.addEventListener("change", function () {
        handleFileInputSelection(this);
      });
    });
document.getElementById("resume-curp")?.addEventListener("input", (e) => {
      e.target.value = normalizeCurp(e.target.value);
    });

    function setLandingMode(mode) {
      const vacancyBox = document.getElementById("vacancy-box");
      const resumeBox = document.getElementById("resume-box");
      const panelVacancy = document.getElementById("landing-panel-vacancy");
      const panelResume = document.getElementById("landing-panel-resume");
      const placeholder = document.getElementById("landing-placeholder");
      const newBtn = document.getElementById("new-registration-btn");
      const resumeBtn = document.getElementById("show-resume-btn");
      const isNew = mode === "new";
      const isResume = mode === "resume";

      vacancyBox?.classList.toggle("active", isNew);
      resumeBox?.classList.toggle("active", isResume);
      newBtn?.classList.toggle("is-selected", isNew);
      resumeBtn?.classList.toggle("is-selected", isResume);
      newBtn?.setAttribute("aria-selected", isNew ? "true" : "false");
      resumeBtn?.setAttribute("aria-selected", isResume ? "true" : "false");

      if (isNew) {
        panelVacancy?.removeAttribute("hidden");
        panelResume?.setAttribute("hidden", "");
        placeholder?.setAttribute("hidden", "");
      } else if (isResume) {
        panelResume?.removeAttribute("hidden");
        panelVacancy?.setAttribute("hidden", "");
        placeholder?.setAttribute("hidden", "");
        document.getElementById("resume-curp")?.focus();
      } else {
        panelVacancy?.setAttribute("hidden", "");
        panelResume?.setAttribute("hidden", "");
        placeholder?.removeAttribute("hidden");
      }
    }

    document.getElementById("show-resume-btn")?.addEventListener("click", () => {
      hardResetForm();
      setLandingMode("resume");
    });

    document.getElementById("new-registration-btn")?.addEventListener("click", () => {
      hardResetForm();
      latestReviewPayload = null;
      loadedDraftCurp = "";
      document.getElementById("ai-review-screen")?.classList.remove("active");
      setLandingMode("new");
    });

    document.querySelectorAll("[data-vacancy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        hardResetForm();
        const vacancy = applyVacancyRules(btn.dataset.vacancy);
        document.getElementById("vacancy-box")?.classList.add("active");
        setLandingMode("new");
        showRegistrationInterface();
        showStep(1);
        showSuccess("Vacante seleccionada", `Aplicarás como ${VACANCY_LABELS[vacancy] || vacancy}.`);
      });
    });

    document.getElementById("load-draft-btn")?.addEventListener("click", async () => {
      await loadDraftByCurp(document.getElementById("resume-curp")?.value || "");
    });

    document.getElementById("save-draft-btn")?.addEventListener("click", saveDraftForLater);

    document.getElementById("review-revalidate-btn")?.addEventListener("click", async () => {
      await revalidateTargetedCorrectionFiles();
    });

    document.getElementById("review-finish-btn")?.addEventListener("click", saveRegistrationAndGenerateCredential);

    document.getElementById("review-list")?.addEventListener("click", async (e) => {
      const btn = e.target.closest(".review-replace-btn");
      if (!btn) return;
      const field = btn.dataset.field;
      const input = document.querySelector(`input[type="file"][name="${CSS.escape(field)}"]`);
      if (!input) return;

      // Abrimos un selector temporal fuera del formulario para que el navegador
      // no enfoque ni desplace la pantalla al paso original del documento.
      openReviewReplacementPicker(field);
    });

    relocateReviewBlocks();
    updateProgress(1);
  