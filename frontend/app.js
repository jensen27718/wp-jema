const TOKEN_STORAGE_KEY = "crm_access_token";

const state = {
  summary: null,
  selectedConversationId: null,
  selectedConversationDetail: null,
  authToken: localStorage.getItem(TOKEN_STORAGE_KEY),
};

const views = ["dashboard", "inbox", "agents"];

const appShell = document.getElementById("appShell");
const loginOverlay = document.getElementById("loginOverlay");
const loginForm = document.getElementById("loginForm");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const loginError = document.getElementById("loginError");
const logoutBtn = document.getElementById("logoutBtn");

const nav = document.getElementById("nav");
const drawer = document.getElementById("detailDrawer");
const closeDrawerBtn = document.getElementById("closeDrawer");

const kpiCards = document.getElementById("kpiCards");
const failTags = document.getElementById("failTags");
const statusFunnel = document.getElementById("statusFunnel");
const riskTableBody = document.getElementById("riskTableBody");
const hourlyBars = document.getElementById("hourlyBars");
const agentTableDashboard = document.getElementById("agentTableDashboard");
const agentTableFull = document.getElementById("agentTableFull");
const inboxTableBody = document.getElementById("inboxTableBody");

const detailMeta = document.getElementById("detailMeta");
const detailMetrics = document.getElementById("detailMetrics");
const detailInsights = document.getElementById("detailInsights");
const detailMessages = document.getElementById("detailMessages");
const sendMessageForm = document.getElementById("sendMessageForm");
const messageSender = document.getElementById("messageSender");
const messageText = document.getElementById("messageText");
const analyzeButton = document.getElementById("analyzeButton");

const filterSearch = document.getElementById("filterSearch");
const applyInboxFiltersBtn = document.getElementById("applyInboxFilters");

const detailAgentSelect = document.getElementById("detailAgentSelect");
const detailStatusSelect = document.getElementById("detailStatusSelect");
const updateStatusBtn = document.getElementById("updateStatusBtn");

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setToken(token) {
  state.authToken = token || null;
  if (state.authToken) {
    localStorage.setItem(TOKEN_STORAGE_KEY, state.authToken);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

function showLogin(message = "") {
  loginOverlay.classList.add("open");
  appShell.classList.add("hidden");
  loginError.textContent = message;
  drawer.classList.remove("open");
}

function hideLogin() {
  loginOverlay.classList.remove("open");
  appShell.classList.remove("hidden");
  loginError.textContent = "";
}

function logout() {
  setToken(null);
  showLogin("Sesion cerrada.");
}

async function fetchJson(path, options = {}, skipAuth = false) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (!skipAuth && state.authToken) {
    headers.Authorization = `Bearer ${state.authToken}`;
  }

  const response = await fetch(path, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(text || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function fmtMinutes(minutes) {
  if (minutes === null || minutes === undefined) return "-";
  return `${minutes}m`;
}

function fmtPercent(value) {
  if (value === null || value === undefined) return "-";
  return `${Number(value).toFixed(2)}%`;
}

function setActiveView(view) {
  views.forEach((candidate) => {
    const section = document.getElementById(`view-${candidate}`);
    const navButton = nav.querySelector(`[data-view="${candidate}"]`);
    if (!section || !navButton) return;
    if (candidate === view) {
      section.classList.add("active");
      navButton.classList.add("active");
    } else {
      section.classList.remove("active");
      navButton.classList.remove("active");
    }
  });
}

function renderTopCards(cards) {
  kpiCards.innerHTML = cards
    .map((card) => {
      let value = card.value ?? card.value_pct ?? card.value_minutes ?? "-";
      if (card.value_pct !== undefined) value = `${card.value_pct}%`;
      if (card.value_minutes !== undefined && card.value_minutes !== null) value = `${card.value_minutes}m`;

      let extra = "";
      if (card.delta_vs_yesterday !== undefined) {
        const sign = card.delta_vs_yesterday >= 0 ? "+" : "";
        extra = `Delta vs ayer: ${sign}${card.delta_vs_yesterday}`;
      } else if (card.sla_badge) {
        extra = `SLA: ${card.sla_badge}`;
      }

      return `
      <article class="kpi-card">
        <h3>${escapeHtml(card.label)}</h3>
        <div class="kpi-value">${escapeHtml(value)}</div>
        <div class="kpi-extra">${escapeHtml(extra)}</div>
      </article>
      `;
    })
    .join("");
}

function renderFailTags(tags) {
  if (!tags.length) {
    failTags.innerHTML = "<p>Sin datos de tags.</p>";
    return;
  }
  failTags.innerHTML = tags
    .map((item) => `<div class="tag-row"><span>${escapeHtml(item.tag)}</span><strong>${item.count}</strong></div>`)
    .join("");
}

function renderStatusFunnel(funnel) {
  const total = Object.values(funnel).reduce((sum, count) => sum + count, 0) || 1;
  statusFunnel.innerHTML = Object.entries(funnel)
    .map(([status, count]) => {
      const pct = Math.round((count / total) * 100);
      return `
        <div class="funnel-row">
          <span>${status}</span>
          <div class="bar" style="width:${Math.max(5, pct)}%"></div>
          <strong>${count}</strong>
        </div>
      `;
    })
    .join("");
}

function renderRiskTable(rows) {
  if (!rows.length) {
    riskTableBody.innerHTML = "<tr><td colspan='7'>Sin conversaciones en riesgo.</td></tr>";
    return;
  }
  riskTableBody.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.cliente)}<br /><small>${escapeHtml(row.telefono)}</small></td>
        <td>${escapeHtml(row.estado)}</td>
        <td>${escapeHtml(row.agente || "-")}</td>
        <td>${escapeHtml(row.min_sin_respuesta ?? "-")}</td>
        <td>${escapeHtml(row.sentimiento)}</td>
        <td>${escapeHtml(row.motivo_tag)}</td>
        <td><button class="ghost-btn" data-open-conversation="${row.conversation_id}">Abrir</button></td>
      </tr>
    `
    )
    .join("");
}

function renderAgents(rows) {
  const html = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.agente)}</td>
        <td>${fmtPercent(row.sla_compliance)}</td>
        <td>${fmtMinutes(row.frt_median)}</td>
        <td>${row.backlog_asignado}</td>
        <td>${fmtPercent(row.negative_rate)}</td>
        <td>${fmtPercent(row.reopen_rate)}</td>
        <td><strong>${row.quality_score}</strong></td>
      </tr>
      `
    )
    .join("");
  agentTableDashboard.innerHTML = html || "<tr><td colspan='7'>Sin datos.</td></tr>";
  agentTableFull.innerHTML = html || "<tr><td colspan='7'>Sin datos.</td></tr>";
}

function renderHourly(rows) {
  const selected = rows.filter((item) => item.hour % 2 === 0);
  const max = Math.max(...selected.map((item) => item.count), 1);
  hourlyBars.innerHTML = selected
    .map((item) => {
      const height = Math.max(8, Math.round((item.count / max) * 110));
      const hourLabel = String(item.hour).padStart(2, "0");
      return `
        <div class="hour-col">
          <div class="bar" style="height:${height}px"></div>
          <span class="hour-label">${hourLabel}h</span>
        </div>
      `;
    })
    .join("");
}

function renderInboxRows(rows) {
  if (!rows.length) {
    inboxTableBody.innerHTML = "<tr><td colspan='5'>Sin resultados.</td></tr>";
    return;
  }

  inboxTableBody.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.client_name || "-")}</td>
        <td>${escapeHtml(row.phone || "-")}</td>
        <td>${escapeHtml(row.status || "-")}</td>
        <td>${escapeHtml(new Date(row.last_seen_at).toLocaleString())}</td>
        <td><button class="ghost-btn" data-open-conversation="${row.conversation_id}">Abrir</button></td>
      </tr>
    `
    )
    .join("");
}

function populateAgentSelect() {
  if (!state.summary || !state.summary.agent_ranking) return;
  const currentVal = detailAgentSelect.value;
  let html = '<option value="">-- Sin asignar --</option>';
  state.summary.agent_ranking.forEach((agent) => {
    html += `<option value="${agent.agent_id}">${escapeHtml(agent.agente)}</option>`;
  });
  detailAgentSelect.innerHTML = html;
  detailAgentSelect.value = currentVal;
}

function renderDetail(detail) {
  const conv = detail.conversation;
  state.selectedConversationDetail = detail;

  populateAgentSelect();
  detailAgentSelect.value = conv.assigned_agent?.id || "";
  detailStatusSelect.value = conv.status || "NEW";

  detailMeta.innerHTML = `
    <strong>${escapeHtml(conv.client?.name || "Sin cliente")}</strong><br />
    <small>${escapeHtml(conv.client?.phone || "")}</small><br />
    Estado: <strong>${escapeHtml(conv.status)}</strong> |
    Sentimiento: <strong>${escapeHtml(conv.sentiment_label || "UNKNOWN")}</strong>
  `;

  const metrics = detail.metrics;
  detailMetrics.innerHTML = `
    FRT: <strong>${fmtMinutes(metrics.frt_minutes)}</strong> |
    ART: <strong>${fmtMinutes(metrics.art_avg_minutes)}</strong> |
    Resolucion: <strong>${fmtMinutes(metrics.time_to_resolution_minutes)}</strong> |
    Prioridad: <strong>${metrics.priority_score}</strong>
  `;

  let insightsHtml = "<p class='text-secondary'>Sin insights. Usa el boton Analizar con AI.</p>";
  if (detail.insights && Object.keys(detail.insights).length > 0) {
    insightsHtml = `<pre class="result-box">${escapeHtml(JSON.stringify(detail.insights, null, 2))}</pre>`;
  }
  detailInsights.innerHTML = insightsHtml;

  detailMessages.innerHTML = detail.messages
    .map((message) => {
      const cls = message.sender === "USER" ? "msg-user" : message.sender === "AGENT" ? "msg-agent" : "msg-bot";
      return `
      <div class="msg ${cls}">
        <div class="msg-meta">${escapeHtml(message.sender)} | ${escapeHtml(new Date(message.ts).toLocaleString())}</div>
        <div>${escapeHtml(message.text)}</div>
      </div>
      `;
    })
    .join("");
}

async function patchActiveConversation(payload) {
  if (!state.selectedConversationId) return;
  await fetchJson(`/conversations/${state.selectedConversationId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  await refreshAll();
  await openConversation(state.selectedConversationId);
}

async function loadSummary() {
  const summary = await fetchJson("/dashboard/summary");
  state.summary = summary;
  renderTopCards(summary.top_cards);
  renderFailTags(summary.top_fail_tags);
  renderStatusFunnel(summary.status_funnel);
  renderRiskTable(summary.at_risk_table);
  renderAgents(summary.agent_ranking);
  renderHourly(summary.messages_by_hour);
}

async function loadInbox() {
  const params = new URLSearchParams();
  params.set("limit", "10");
  if (filterSearch.value.trim()) {
    params.set("q", filterSearch.value.trim());
  }
  const rows = await fetchJson(`/conversations/recent-clients?${params.toString()}`);
  renderInboxRows(rows);
}

async function openConversation(conversationId) {
  state.selectedConversationId = conversationId;
  const detail = await fetchJson(`/conversations/${conversationId}`);
  renderDetail(detail);
  drawer.classList.add("open");
}

async function analyzeConversation() {
  if (!state.selectedConversationId) return;
  await fetchJson(`/conversations/${state.selectedConversationId}/analyze`, {
    method: "POST",
    body: JSON.stringify({ force: true }),
  });
  await openConversation(state.selectedConversationId);
  await refreshAll();
}

async function sendMessage(event) {
  event.preventDefault();
  if (!state.selectedConversationId) return;
  const text = messageText.value.trim();
  if (!text) return;

  await fetchJson(`/conversations/${state.selectedConversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      sender: messageSender.value,
      text,
      provider: "wasender",
    }),
  });
  messageText.value = "";
  await openConversation(state.selectedConversationId);
  await refreshAll();
}

async function refreshAll() {
  await loadSummary();
  await loadInbox();
}

async function submitLogin(event) {
  event.preventDefault();
  loginError.textContent = "";

  const username = loginUsername.value.trim();
  const password = loginPassword.value;
  if (!username || !password) {
    loginError.textContent = "Debes ingresar usuario y clave.";
    return;
  }

  try {
    const auth = await fetchJson(
      "/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ username, password }),
      },
      true
    );
    setToken(auth.access_token);
    hideLogin();
    await refreshAll();
  } catch (error) {
    loginError.textContent = "Credenciales invalidas.";
  }
}

function showError(error) {
  if (error && error.status === 401) {
    logout();
    loginError.textContent = "Tu sesion expiro. Vuelve a ingresar.";
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  alert(`Error: ${message}`);
}

function wireEvents() {
  nav.addEventListener("click", (event) => {
    const target = event.target.closest("[data-view]");
    if (!target) return;
    setActiveView(target.dataset.view);
  });

  document.body.addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-conversation]");
    if (!button) return;
    openConversation(button.dataset.openConversation).catch(showError);
  });

  closeDrawerBtn.addEventListener("click", () => drawer.classList.remove("open"));
  applyInboxFiltersBtn.addEventListener("click", () => loadInbox().catch(showError));
  sendMessageForm.addEventListener("submit", (event) => sendMessage(event).catch(showError));
  analyzeButton.addEventListener("click", () => analyzeConversation().catch(showError));
  detailAgentSelect.addEventListener("change", () => {
    const val = detailAgentSelect.value;
    patchActiveConversation({ assigned_agent_id: val || null }).catch(showError);
  });
  updateStatusBtn.addEventListener("click", () => {
    const val = detailStatusSelect.value;
    patchActiveConversation({ status: val }).catch(showError);
  });

  loginForm.addEventListener("submit", (event) => submitLogin(event).catch(showError));
  logoutBtn.addEventListener("click", () => logout());
}

async function boot() {
  wireEvents();

  if (!state.authToken) {
    showLogin();
    return;
  }

  hideLogin();
  try {
    await refreshAll();
  } catch (error) {
    showError(error);
  }
}

boot().catch(showError);
