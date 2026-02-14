import { requireAuth } from "../_utils/auth";
import {
  SLA_FIRST_REPLY_MINUTES,
  computeQualityScore,
  frtMinutes,
  minutesWithoutReply,
  recalcRisk,
  safeJsonParse,
  type AgentRow,
  type ClientRow,
  type ConversationRow,
  type MessageRow,
} from "../_utils/crm";
import { dbAll, refreshRiskFlags, requireDb } from "../_utils/db";
import { json, methodNotAllowed, serverError } from "../_utils/http";
import { type Env } from "../_utils/settings";

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function onRequest(context: any): Promise<Response> {
  const { request, env } = context as { request: Request; env: Env };
  if (request.method !== "GET") return methodNotAllowed(["GET"]);

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  let conversations: ConversationRow[] = [];
  let clients: ClientRow[] = [];
  let agents: AgentRow[] = [];
  let messages: Array<Pick<MessageRow, "sender" | "ts" | "out_of_hours">> = [];

  try {
    const db = requireDb(env);
    conversations = await dbAll<ConversationRow>(db, "SELECT * FROM conversations");
    clients = await dbAll<ClientRow>(db, "SELECT id, name, phone, company, city, created_at FROM clients");
    agents = await dbAll<AgentRow>(db, "SELECT id, name, active FROM agents");
    messages = await dbAll(db, "SELECT sender, ts, out_of_hours FROM messages");

    // Keep stored risk flags fresh (same behavior as Python _refresh_risk_flags).
    await refreshRiskFlags(db, conversations, new Date());
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.toLowerCase().includes("no such table")) {
      return serverError("DB is not initialized. Apply ./d1/schema.sql to your D1 database.");
    }
    return serverError(msg);
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const y = new Date(now);
  y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = y.toISOString().slice(0, 10);

  const clientsMap = new Map<string, ClientRow>(clients.map((c) => [c.id, c]));
  const agentsMap = new Map<string, AgentRow>(agents.map((a) => [a.id, a]));

  const riskComputed = new Map<string, ReturnType<typeof recalcRisk>>();
  for (const c of conversations) riskComputed.set(c.id, recalcRisk(c, now));

  const newToday = conversations.filter((c) => c.created_at.slice(0, 10) === today).length;
  const newYesterday = conversations.filter((c) => c.created_at.slice(0, 10) === yesterday).length;

  const backlog = conversations.filter((c) => c.status !== "CLOSED");
  const atRisk = conversations.filter((c) => riskComputed.get(c.id)?.riskFlag);

  const frtValues = conversations
    .map((c) => frtMinutes(c))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const frtMedian = frtValues.length ? Math.round((median(frtValues) || 0) * 100) / 100 : null;

  const replied = conversations.filter((c) => frtMinutes(c) !== null);
  const slaHits = replied.filter((c) => (frtMinutes(c) || 0) <= SLA_FIRST_REPLY_MINUTES).length;
  const slaCompliance = replied.length ? Math.round((slaHits / replied.length) * 10000) / 100 : 0.0;

  const analyzed = conversations.filter((c) => c.sentiment_label !== null && c.sentiment_label !== undefined);
  const negativeCount = analyzed.filter((c) => c.sentiment_label === "NEGATIVE").length;
  const negativeRate = analyzed.length ? Math.round((negativeCount / analyzed.length) * 10000) / 100 : 0.0;

  const reasonCounter = new Map<string, number>();
  for (const c of atRisk) {
    const reasons = riskComputed.get(c.id)?.riskReasons || [];
    for (const r of reasons) reasonCounter.set(r, (reasonCounter.get(r) || 0) + 1);
  }
  const reasonSplit = Array.from(reasonCounter.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  const tagCounter = new Map<string, number>();
  for (const c of conversations) {
    if (c.sentiment_label !== "NEGATIVE" && c.outcome !== "LOST") continue;
    const tags = safeJsonParse<string[]>(c.tags_json, []);
    for (const tag of tags) tagCounter.set(tag, (tagCounter.get(tag) || 0) + 1);
  }
  const topFailTags = Array.from(tagCounter.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag, count]) => ({ tag, count }));

  const statuses: Array<ConversationRow["status"]> = [
    "NEW",
    "CONTACTED",
    "INTERESTED",
    "NEGOTIATION",
    "REENGAGEMENT",
    "SUPPORT",
    "CLOSED",
  ];
  const funnelCounts: Record<string, number> = {};
  for (const s of statuses) funnelCounts[s] = conversations.filter((c) => c.status === s).length;

  const backlogBreakdown: Record<string, number> = {};
  for (const [status, count] of Object.entries(funnelCounts)) {
    if (status === "CLOSED") continue;
    if (count > 0) backlogBreakdown[status] = count;
  }

  const userMessages = messages.filter((m) => m.sender === "USER");
  const outOfHoursCount = userMessages.filter((m) => Boolean(m.out_of_hours)).length;
  const outOfHoursRate = userMessages.length ? Math.round((outOfHoursCount / userMessages.length) * 10000) / 100 : 0.0;

  const byHourCounter = new Map<number, number>();
  for (const m of userMessages) {
    const d = new Date(m.ts);
    if (Number.isNaN(d.getTime())) continue;
    const hour = d.getUTCHours();
    byHourCounter.set(hour, (byHourCounter.get(hour) || 0) + 1);
  }
  const messagesByHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: byHourCounter.get(hour) || 0 }));

  const atRiskTable = atRisk
    .map((c) => {
      const client = clientsMap.get(c.client_id) || null;
      const agent = c.assigned_agent_id ? agentsMap.get(c.assigned_agent_id) || null : null;
      const risk = riskComputed.get(c.id);
      const reason = (risk?.riskReasons || [""])[0] || "";
      const tags = safeJsonParse<string[]>(c.tags_json, []);
      const minSinRespuesta = minutesWithoutReply(c, now);
      const motivoTag = (tags[0] || reason) ? String(tags[0] || reason) : "";
      return {
        conversation_id: c.id,
        cliente: client?.name || "N/A",
        telefono: client?.phone || "",
        estado: c.status,
        agente: agent?.name || null,
        min_sin_respuesta: minSinRespuesta,
        sentimiento: c.sentiment_label || "UNKNOWN",
        motivo_tag: motivoTag,
        accion: "abrir",
        priority_score: risk?.priorityScore || 0,
      };
    })
    .sort((a, b) => {
      const scoreDiff = (b.priority_score || 0) - (a.priority_score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return (b.min_sin_respuesta || 0) - (a.min_sin_respuesta || 0);
    })
    .slice(0, 25);

  const agentRanking = agents
    .map((agent) => {
      const assigned = conversations.filter((c) => c.assigned_agent_id === agent.id);
      const repliedAssigned = assigned.filter((c) => frtMinutes(c) !== null);
      const frtVals = repliedAssigned
        .map((c) => frtMinutes(c))
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      const frtMed = frtVals.length ? Math.round((median(frtVals) || 0) * 100) / 100 : null;

      const slaHitsAgent = repliedAssigned.filter((c) => (frtMinutes(c) || 0) <= SLA_FIRST_REPLY_MINUTES).length;
      const sla = repliedAssigned.length ? Math.round((slaHitsAgent / repliedAssigned.length) * 10000) / 100 : 0.0;

      const backlogAssigned = assigned.filter((c) => c.status !== "CLOSED").length;
      const analyzedAssigned = assigned.filter((c) => c.sentiment_label !== null && c.sentiment_label !== undefined);
      const negative = analyzedAssigned.filter((c) => c.sentiment_label === "NEGATIVE").length;
      const negativeRateAgent = analyzedAssigned.length ? negative / analyzedAssigned.length : 0.0;

      const closed = assigned.filter((c) => c.closed_at !== null || c.status === "CLOSED");
      const reopened = closed.filter((c) => (c.reopened_count || 0) > 0).length;
      const reopenRate = closed.length ? reopened / closed.length : 0.0;

      const overdue = assigned.filter((c) => {
        const reasons = riskComputed.get(c.id)?.riskReasons || [];
        return reasons.includes("Sin primera respuesta") || reasons.includes("Seguimiento congelado");
      }).length;
      const overdueRate = assigned.length ? overdue / assigned.length : 0.0;

      const frtRatio = assigned.length ? ((frtMed || SLA_FIRST_REPLY_MINUTES) / SLA_FIRST_REPLY_MINUTES) : 0.0;
      const quality = Math.round(computeQualityScore(overdueRate, negativeRateAgent, reopenRate, frtRatio) * 100) / 100;

      return {
        agent_id: agent.id,
        agente: agent.name,
        sla_compliance: sla,
        frt_median: frtMed,
        backlog_asignado: backlogAssigned,
        negative_rate: Math.round(negativeRateAgent * 10000) / 100,
        reopen_rate: Math.round(reopenRate * 10000) / 100,
        quality_score: quality,
      };
    })
    .sort((a, b) => a.quality_score - b.quality_score);

  const topCards = [
    {
      kpi_id: "KPI_NEW_TODAY",
      label: "Conversaciones nuevas (hoy)",
      value: newToday,
      delta_vs_yesterday: newToday - newYesterday,
    },
    {
      kpi_id: "KPI_BACKLOG_PENDING",
      label: "Pendientes (Backlog)",
      value: backlog.length,
      breakdown_by_status: backlogBreakdown,
    },
    {
      kpi_id: "KPI_AT_RISK",
      label: "En riesgo",
      value: atRisk.length,
      reason_split: reasonSplit,
    },
    {
      kpi_id: "KPI_FRT_MEDIAN",
      label: "Primera respuesta (mediana)",
      value_minutes: frtMedian,
      sla_minutes: SLA_FIRST_REPLY_MINUTES,
      sla_badge: frtMedian !== null && frtMedian <= SLA_FIRST_REPLY_MINUTES ? "OK" : "ALERTA",
    },
    {
      kpi_id: "KPI_SLA_COMPLIANCE",
      label: "% Cumplimiento SLA",
      value_pct: slaCompliance,
    },
    {
      kpi_id: "KPI_NEGATIVE_RATE",
      label: "% Sentimiento negativo",
      value_pct: negativeRate,
    },
  ];

  return json({
    top_cards: topCards,
    at_risk_table: atRiskTable,
    top_fail_tags: topFailTags,
    status_funnel: funnelCounts,
    agent_ranking: agentRanking,
    out_of_hours_rate: outOfHoursRate,
    messages_by_hour: messagesByHour,
  });
}

