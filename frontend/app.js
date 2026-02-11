const state = {
  summary: null,
  selectedConversationId: null,
  selectedConversationDetail: null,
};

const views = ["dashboard", "inbox", "agents", "simulator"];

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
const markFollowupButton = document.getElementById("markFollowupButton");
const markClosedButton = document.getElementById("markClosedButton");

const filterStatus = document.getElementById("filterStatus");
const filterRisk = document.getElementById("filterRisk");
const filterSearch = document.getElementById("filterSearch");
const applyInboxFiltersBtn = document.getElementById("applyInboxFilters");

const simulatorForm = document.getElementById("simulatorForm");
const simulatorResult = document.getElementById("simulatorResult");
const seedButton = document.getElementById("seedButton");
const seedResult = document.getElementById("seedResult");

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status} ${response.statusText}`);
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
    inboxTableBody.innerHTML = "<tr><td colspan='7'>Sin resultados.</td></tr>";
    return;
  }
  inboxTableBody.innerHTML = rows
    .map((row) => {
      const riskClass = row.risk_flag ? "risk-on" : "risk-off";
      const riskText = row.risk_flag ? "En riesgo" : "Estable";
      return `
      <tr>
        <td>${escapeHtml(row.client?.name || "-")}<br /><small>${escapeHtml(row.client?.phone || "")}</small></td>
        <td>${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.assigned_agent?.name || "-")}</td>
        <td>${escapeHtml(new Date(row.last_message_at).toLocaleString())}</td>
        <td><span class="risk-badge ${riskClass}">${riskText}</span></td>
        <td>${row.priority_score}</td>
        <td><button class="ghost-btn" data-open-conversation="${row.id}">Abrir</button></td>
      </tr>
      `;
    })
    .join("");
}

const detailAgentSelect = document.getElementById("detailAgentSelect");
const detailStatusSelect = document.getElementById("detailStatusSelect");
const updateStatusBtn = document.getElementById("updateStatusBtn");

async function patchActiveConversation(payload) {
  if (!state.selectedConversationId) return;
  await fetchJson(`/conversations/${state.selectedConversationId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  await refreshAll();
  await openConversation(state.selectedConversationId);
}

function populateAgentSelect() {
  if (!state.summary || !state.summary.agent_ranking) return;
  const currentVal = detailAgentSelect.value;
  // Keep "Unassigned" option
  let html = '<option value="">-- Sin asignar --</option>';
  state.summary.agent_ranking.forEach(agent => {
    html += `<option value="${agent.agent_id}">${escapeHtml(agent.agente)}</option>`;
  });
  detailAgentSelect.innerHTML = html;
  detailAgentSelect.value = currentVal;
}

function renderDetail(detail) {
  const conv = detail.conversation;
  state.selectedConversationDetail = detail;

  // Populate agents if needed (idempotent-ish)
  populateAgentSelect();
  
  // Set current values
  if (conv.assigned_agent && conv.assigned_agent.id) {
    detailAgentSelect.value = conv.assigned_agent.id;
  } else {
    detailAgentSelect.value = "";
  }
  
  if (conv.status) {
      detailStatusSelect.value = conv.status;
  }

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
    Resolución: <strong>${fmtMinutes(metrics.time_to_resolution_minutes)}</strong> |
    Prioridad: <strong>${metrics.priority_score}</strong>
  `;

  let insightsHtml = "<p class='text-secondary'>Sin insights. Usa el botón Analizar con AI.</p>";
  
  if (detail.insights && Object.keys(detail.insights).length > 0) {
    const i = detail.insights;
    // const scoreClass = i.sentiment_score >= 8 ? "text-success" : i.sentiment_score <= 4 ? "text-danger" : "text-warning";
    const bulletsHtml = (i.summary_bullets || []).map(b => `<li>${escapeHtml(b)}</li>`).join("");
    const tagsHtml = (i.tags || []).map(t => `<span class="insight-tag">${escapeHtml(t)}</span>`).join("");
    
    // Key points safely handled
    const kp = i.key_points || {};
    
    // Safe accessor for suggested reply
    const suggestedReply = i.suggested_reply || "";

    insightsHtml = `
      <div class="insights-container">
        <div class="insight-header">
          <div style="display:flex; align-items:center; gap:8px;">
             <span class="sentiment-badge ${i.sentiment_label}">${i.sentiment_label}</span>
             <span style="font-size:11px; color:#666;">Score: <strong>${i.sentiment_score}/10</strong></span>
          </div>
          ${tagsHtml ? `<div class="tags-container" style="justify-content:flex-end;">${tagsHtml}</div>` : ''}
        </div>

        <section class="insight-section">
          <h4>Resumen</h4>
          <ul class="insight-bullets">
            ${bulletsHtml}
          </ul>
        </section>

        <section class="insight-section">
          <h4>Claves</h4>
          <div class="key-points-grid">
            <div class="kp-item"><strong>Necesidad</strong><span>${escapeHtml(kp.need || "-")}</span></div>
            <div class="kp-item"><strong>Objeción</strong><span>${escapeHtml(kp.objection || "-")}</span></div>
            <div class="kp-item"><strong>Urgencia</strong><span>${escapeHtml(kp.urgency || "-")}</span></div>
            <div class="kp-item"><strong>Sig. Paso</strong><span>${escapeHtml(kp.next_step || "-")}</span></div>
          </div>
        </section>

        ${suggestedReply ? `
        <section class="insight-section" style="margin-top:4px; padding-top:4px; border-top:1px dashed #ddd;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
             <h4>💬 Respuesta Sugerida</h4>
             <button class="ghost-btn" style="padding:2px 8px; font-size:10px; height:auto;" onclick="const txt = this.getAttribute('data-reply'); document.getElementById('messageText').value = txt; document.getElementById('messageText').focus();" data-reply="${escapeHtml(suggestedReply)}">
               Copiar
             </button>
          </div>
          <div style="background:#e3f2fd; padding:6px; border-radius:4px; font-style:italic; font-size:11px; color:#0d47a1; border:1px solid #bbdefb;">
            "${escapeHtml(suggestedReply)}"
          </div>
        </section>
        `: ''}

        <details style="margin-top:8px; font-size:10px; color:#999;">
          <summary style="cursor:pointer; outline:none;">Debug JSON</summary>
          <pre style="white-space:pre-wrap; background:#f5f5f5; padding:4px; border-radius:4px; margin-top:2px; font-size:9px;">${escapeHtml(JSON.stringify(detail.insights, null, 2))}</pre>
        </details>
      </div>
    `;
  }
  
  detailInsights.innerHTML = `<div class="result-box" style="background:transparent; padding:0;">${insightsHtml}</div>`;

  detailMessages.innerHTML = detail.messages
    .map((message) => {
      const cls = message.sender === "USER" ? "msg-user" : message.sender === "AGENT" ? "msg-agent" : "msg-bot";
      return `
      <div class="msg ${cls}">
        <div class="msg-meta">${escapeHtml(message.sender)} · ${escapeHtml(new Date(message.ts).toLocaleString())}</div>
        <div>${escapeHtml(message.text)}</div>
      </div>
      `;
    })
    .join("");
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
  // Also populate select if drawer is open? 
  // Better to just have it available in state
}

async function loadInbox() {
  const params = new URLSearchParams();
  if (filterStatus.value) params.append("status", filterStatus.value);
  if (filterRisk.value) params.append("risk_flag", filterRisk.value);
  if (filterSearch.value.trim()) params.append("q", filterSearch.value.trim());

  const query = params.toString();
  const rows = await fetchJson(`/conversations${query ? `?${query}` : ""}`);
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
    body: JSON.stringify({ force: true, mock: false }), // Use real AI now by default if configured
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
      provider: "mock",
    }),
  });
  messageText.value = "";
  await openConversation(state.selectedConversationId);
  await refreshAll();
}

async function runSimulator(event) {
  event.preventDefault();
  const form = new FormData(simulatorForm);
  const now = new Date().toISOString();
  const payload = {
    provider: form.get("provider"),
    wa_id: form.get("wa_id"),
    message_id: `wamid.mock.${Date.now()}`,
    timestamp: now,
    direction: "inbound",
    message_type: "text",
    text: form.get("text"),
    sender_role: form.get("sender_role"),
  };
  const result = await fetchJson("/webhook/mock", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  simulatorResult.textContent = JSON.stringify(result, null, 2);
  await refreshAll();
}

async function reseedDataset() {
  seedResult.textContent = "Generando dataset...";
  const result = await fetchJson("/seed", {
    method: "POST",
    body: JSON.stringify({
      agents: 6,
      clients: 120,
      conversations: 220,
      min_messages: 6,
      max_messages: 25,
      run_ai_on_pct: 0.35,
    }),
  });
  seedResult.textContent = JSON.stringify(result, null, 2);
  await refreshAll();
}

async function refreshAll() {
  await loadSummary();
  await loadInbox();
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
  
  // New controls
  detailAgentSelect.addEventListener("change", () => {
      const val = detailAgentSelect.value;
      patchActiveConversation({ assigned_agent_id: val || null }).catch(showError);
  });
  
  updateStatusBtn.addEventListener("click", () => {
      const val = detailStatusSelect.value;
      patchActiveConversation({ status: val }).catch(showError);
  });

  simulatorForm.addEventListener("submit", (event) => runSimulator(event).catch(showError));
  seedButton.addEventListener("click", () => reseedDataset().catch(showError));
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  alert(`Error: ${message}`);
}

async function boot() {
  wireEvents();
  await refreshAll();
}

boot().catch(showError);
