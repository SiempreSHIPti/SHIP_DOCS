(() => {
  "use strict";

  const state = {
    session: null,
    offset: 0,
    limit: 100,
    total: 0,
    search: "",
    status: "",
    currentRow: null,
    currentDriver: null,
    searchTimer: null,
  };

  const $ = (id) => document.getElementById(id);

  const loginView = $("login-view");
  const appView = $("app-view");
  const modal = $("detail-modal");
  const busy = $("busy-overlay");
  const busyText = $("busy-text");

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showBusy(message = "Procesando...") {
    busyText.textContent = message;
    busy.classList.remove("hidden");
  }

  function hideBusy() {
    busy.classList.add("hidden");
  }

  async function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    const isForm = options.body instanceof FormData;

    if (options.body && !isForm && typeof options.body !== "string") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    if (options.method && options.method !== "GET") {
      headers["X-Utils-Request"] = "1";
    }

    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      payload = { ok: false, error: "Respuesta inválida del servidor." };
    }

    if (response.status === 401) {
      state.session = null;
      showLogin();
      throw new Error(payload?.error || "Sesión expirada.");
    }

    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || payload?.userMessage || `Error HTTP ${response.status}`);
    }
    return payload;
  }

  function showLogin() {
    appView.classList.add("hidden");
    modal.classList.add("hidden");
    loginView.classList.remove("hidden");
  }

  function showApp() {
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    $("session-user").textContent = state.session?.name || state.session?.username || "Administrador";
  }

  function badgeClass(status) {
    const s = String(status || "").toUpperCase();
    if (s === "APROBADO") return "ok";
    if (s.includes("OBSERV")) return "warn";
    if (s.includes("ERROR") || s.includes("RECHAZ") || s.includes("FALT")) return "bad";
    if (s.includes("PENDIENTE")) return "warn";
    return "neutral";
  }

  function docBadge(status) {
    const s = String(status || "").toLowerCase();
    if (s === "approved") return ["Aprobado", "ok"];
    if (s === "warning") return ["Observación", "warn"];
    if (s === "rejected" || s === "missing") return [s === "missing" ? "Faltante" : "Rechazado", "bad"];
    if (s === "uploaded") return ["Cargado", "neutral"];
    if (s === "skipped") return ["Omitido", "neutral"];
    return [status || "Sin estado", "neutral"];
  }

  function renderRows(items) {
    const tbody = $("drivers-body");
    tbody.innerHTML = "";

    if (!items.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="9" class="muted">No se encontraron registros.</td>`;
      tbody.appendChild(tr);
      return;
    }

    for (const item of items) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${item.rowNumber}</td>
        <td class="name-cell">
          <strong>${escapeHtml(item.nombre || "Sin nombre")}</strong>
          <span class="subtle">${escapeHtml(item.telefono || "")}</span>
        </td>
        <td>${escapeHtml(item.curp || "")}</td>
        <td>${escapeHtml(item.tipoVacante || "")}</td>
        <td><span class="badge ${badgeClass(item.estado)}">${escapeHtml(item.estado || "SIN ESTADO")}</span></td>
        <td>${escapeHtml(item.rechazados || "—")}</td>
        <td>${escapeHtml(item.observaciones || "—")}</td>
        <td>${item.credencialPdf ? '<span class="badge ok">Sí</span>' : '<span class="badge neutral">No</span>'}</td>
        <td><button class="ghost small detail-btn" type="button">Ver detalle</button></td>
      `;
      tr.querySelector(".detail-btn").addEventListener("click", () => openDriver(item.rowNumber));
      tbody.appendChild(tr);
    }
  }

  async function loadDrivers(reset = false) {
    if (reset) state.offset = 0;
    showBusy("Consultando Google Sheets...");
    try {
      const params = new URLSearchParams({
        offset: String(state.offset),
        limit: String(state.limit),
      });
      if (state.search) params.set("search", state.search);
      if (state.status) params.set("status", state.status);

      const result = await api(`/utils/api/drivers?${params.toString()}`);
      state.total = result.total || 0;
      renderRows(result.items || []);
      $("result-count").textContent = `${state.total} driver${state.total === 1 ? "" : "s"}`;

      const from = state.total ? state.offset + 1 : 0;
      const to = Math.min(state.offset + state.limit, state.total);
      $("page-info").textContent = state.total ? ` · mostrando ${from}-${to}` : "";
      $("prev-btn").disabled = state.offset <= 0;
      $("next-btn").disabled = state.offset + state.limit >= state.total;
    } catch (err) {
      console.error(err);
      alert(err.message);
    } finally {
      hideBusy();
    }
  }

  function showDetailNotice(message, kind = "ok") {
    const box = $("detail-alert");
    box.textContent = message;
    box.className = `notice ${kind}`;
    box.classList.remove("hidden");
    setTimeout(() => box.classList.add("hidden"), 6500);
  }

  function fillForm(driver) {
    const form = $("driver-form");
    const values = {
      tipoVacante: driver.tipoVacante || "",
      nombre: driver.nombre || "",
      telefono: driver.telefono || "",
      curp: driver.curp || "",
      rfc: driver.rfc || "",
      nss: driver.nss || "",
      banco: driver.banco || "",
      clabe: driver.clabe || "",
      direccion: driver.direccion || "",
    };
    for (const [name, value] of Object.entries(values)) {
      const input = form.elements.namedItem(name);
      if (input) input.value = value;
    }
  }

  function renderDocuments(driver) {
    const grid = $("documents-grid");
    grid.innerHTML = "";

    for (const doc of driver.documents || []) {
      const [statusText, statusClass] = docBadge(doc.status);
      const issues = [...(doc.issues || []), ...(doc.warnings || [])].filter(Boolean);
      const card = document.createElement("article");
      card.className = "doc-card";
      card.innerHTML = `
        <div class="doc-head">
          <div class="doc-title">${escapeHtml(doc.label)}</div>
          <span class="badge ${statusClass}">${escapeHtml(statusText)}</span>
        </div>
        ${doc.summary ? `<div class="doc-text">${escapeHtml(doc.summary)}</div>` : ""}
        ${issues.length ? `<div class="doc-text">${escapeHtml(issues.join("\n"))}</div>` : ""}
        <div class="doc-actions">
          ${doc.link ? `<a class="ghost small link-button" href="${escapeHtml(doc.link)}" target="_blank" rel="noopener">Abrir</a>` : ""}
          <label class="ghost small file-input">
            Reemplazar
            <input type="file" accept=".pdf,image/jpeg,image/png,image/webp" data-field="${escapeHtml(doc.fieldName)}" />
          </label>
        </div>
      `;

      const input = card.querySelector('input[type="file"]');
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return;
        const confirmed = confirm(`¿Reemplazar "${doc.label}" con "${file.name}" y volver a validarlo?`);
        if (!confirmed) {
          input.value = "";
          return;
        }
        await replaceDocument(doc.fieldName, file);
        input.value = "";
      });
      grid.appendChild(card);
    }
  }

  function renderDriver(driver) {
    state.currentDriver = driver;
    state.currentRow = driver.rowNumber;

    $("detail-title").textContent = driver.nombre || `Fila ${driver.rowNumber}`;
    $("detail-subtitle").textContent = `Fila ${driver.rowNumber} · ${driver.curp || "CURP sin registrar"}`;
    $("detail-status").innerHTML = `<span class="badge ${badgeClass(driver.estado)}">${escapeHtml(driver.estado || "SIN ESTADO")}</span>`;

    fillForm(driver);
    $("rejected-detail").textContent = driver.detalleRechazados || driver.rechazados || "Sin documentos rechazados.";
    $("warning-detail").textContent = driver.detalleObservaciones || driver.observaciones || "Sin observaciones.";

    const folder = $("folder-link");
    if (driver.carpetaDrive) {
      folder.href = driver.carpetaDrive;
      folder.classList.remove("hidden");
    } else {
      folder.classList.add("hidden");
      folder.removeAttribute("href");
    }

    const credentialLink = $("credential-link");
    const credentialBadge = $("credential-badge");
    const credentialInfo = $("credential-info");
    if (driver.credencialPdf) {
      credentialLink.href = driver.credencialPdf;
      credentialLink.classList.remove("hidden");
      credentialBadge.className = "badge ok";
      credentialBadge.textContent = "Generada";
      credentialInfo.textContent = driver.credentialId
        ? `ID: ${driver.credentialId}`
        : "La credencial ya está registrada en el Sheet.";
    } else {
      credentialLink.classList.add("hidden");
      credentialLink.removeAttribute("href");
      credentialBadge.className = "badge neutral";
      credentialBadge.textContent = "Sin credencial";
      credentialInfo.textContent = "Puedes generarla manualmente cuando nombre, CURP, RFC, NSS y foto estén disponibles.";
    }

    renderDocuments(driver);
  }

  async function openDriver(rowNumber) {
    showBusy("Cargando expediente...");
    try {
      const result = await api(`/utils/api/drivers/${rowNumber}`);
      renderDriver(result.driver);
      modal.classList.remove("hidden");
    } catch (err) {
      alert(err.message);
    } finally {
      hideBusy();
    }
  }

  async function refreshCurrentDriver() {
    if (!state.currentRow) return;
    const result = await api(`/utils/api/drivers/${state.currentRow}`);
    renderDriver(result.driver);
  }

  async function saveDriver() {
    if (!state.currentRow) return;
    const form = $("driver-form");
    const body = Object.fromEntries(new FormData(form).entries());

    showBusy("Guardando cambios en Google Sheets...");
    try {
      const result = await api(`/utils/api/drivers/${state.currentRow}`, {
        method: "PATCH",
        body,
      });
      renderDriver(result.driver);
      showDetailNotice("Datos actualizados en Google Sheets.", "ok");
      await loadDrivers(false);
    } catch (err) {
      showDetailNotice(err.message, "bad");
    } finally {
      hideBusy();
    }
  }

  async function replaceDocument(fieldName, file) {
    if (!state.currentRow) return;
    const form = new FormData();
    form.append("file", file);

    showBusy("Subiendo, validando y actualizando el expediente...");
    try {
      const result = await api(`/utils/api/drivers/${state.currentRow}/documents/${encodeURIComponent(fieldName)}`, {
        method: "POST",
        body: form,
      });
      renderDriver(result.driver);
      const status = result.document?.validation?.status || "actualizado";
      showDetailNotice(`Documento actualizado. Resultado: ${status}.`, status === "rejected" ? "bad" : "ok");
      await loadDrivers(false);
    } catch (err) {
      showDetailNotice(err.message, "bad");
    } finally {
      hideBusy();
    }
  }

  async function generateCredential() {
    if (!state.currentRow) return;
    if (!confirm("¿Crear o regenerar la credencial de este driver? El enlace del Sheet será actualizado.")) return;

    showBusy("Generando credencial...");
    try {
      const result = await api(`/utils/api/drivers/${state.currentRow}/credential`, {
        method: "POST",
        body: {},
      });
      renderDriver(result.driver);
      const extra = result.mode === "local_pdf" && result.slideFallbackReason
        ? " Se utilizó el generador local como respaldo."
        : "";
      showDetailNotice(`Credencial generada correctamente.${extra}`, "ok");
      await loadDrivers(false);
    } catch (err) {
      showDetailNotice(err.message, "bad");
    } finally {
      hideBusy();
    }
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = $("login-error");
    errorBox.classList.add("hidden");
    showBusy("Validando acceso...");
    try {
      const payload = await api("/utils/api/login", {
        method: "POST",
        body: {
          username: $("login-username").value,
          password: $("login-password").value,
        },
      });
      state.session = payload.user;
      $("login-password").value = "";
      showApp();
      await loadDrivers(true);
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove("hidden");
    } finally {
      hideBusy();
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    try {
      await api("/utils/api/logout", { method: "POST", body: {} });
    } catch (_) {}
    state.session = null;
    showLogin();
  });

  $("refresh-btn").addEventListener("click", () => loadDrivers(false));
  $("save-driver-btn").addEventListener("click", saveDriver);
  $("generate-credential-btn").addEventListener("click", generateCredential);

  $("close-modal").addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.classList.add("hidden");
  });

  $("search-input").addEventListener("input", (event) => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.search = event.target.value.trim();
      loadDrivers(true);
    }, 350);
  });

  $("status-filter").addEventListener("change", (event) => {
    state.status = event.target.value;
    loadDrivers(true);
  });

  $("prev-btn").addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - state.limit);
    loadDrivers(false);
  });

  $("next-btn").addEventListener("click", () => {
    if (state.offset + state.limit < state.total) {
      state.offset += state.limit;
      loadDrivers(false);
    }
  });

  async function init() {
    try {
      const payload = await api("/utils/api/session");
      state.session = payload.user;
      showApp();
      await loadDrivers(true);
    } catch (_) {
      showLogin();
    }
  }

  init();
})();
