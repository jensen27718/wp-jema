import { requireAuth } from "../_utils/auth";
import {
  conversationView,
  frtMinutes,
  minutesBetween,
  parseIso,
  recalcRisk,
  safeJsonParse,
  type ConversationRow,
  type MessageRow,
  type MessageSender,
} from "../_utils/crm";
import { dbRun, getAgentById, getClientById, getConversationById, getMessagesForConversation, requireDb } from "../_utils/db";
import { badRequest, json, methodNotAllowed, notFound, serverError } from "../_utils/http";
import { type Env } from "../_utils/settings";

function round2(value: number | null): number | null {
  if (value === null || value === undefined) return null;
  return Math.round(value * 100) / 100;
}

function conversationMetrics(messages: MessageRow[], conv: ConversationRow) {
  const sorted = [...messages].sort((a, b) => a.ts.localeCompare(b.ts));
  const responseTimes: number[] = [];
  let waitingUserTs: Date | null = null;

  for (const msg of sorted) {
    const ts = new Date(msg.ts);
    if (Number.isNaN(ts.getTime())) continue;
    if (msg.sender === "USER") {
      waitingUserTs = ts;
      continue;
    }
    if (msg.sender === "AGENT" && waitingUserTs) {
      const deltaMin = Math.floor((ts.getTime() - waitingUserTs.getTime()) / 60000);
      responseTimes.push(Math.max(0, deltaMin));
      waitingUserTs = null;
    }
  }

  const artAvg = responseTimes.length ? round2(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : null;
  const timeToResolution = minutesBetween(parseIso(conv.created_at), parseIso(conv.closed_at));

  return {
    frt_minutes: frtMinutes(conv),
    art_avg_minutes: artAvg,
    time_to_resolution_minutes: timeToResolution,
  };
}

export async function onRequest(context: any): Promise<Response> {
  const { request, env, params } = context as { request: Request; env: Env; params: Record<string, string> };
  if (!["GET", "PATCH"].includes(request.method)) return methodNotAllowed(["GET", "PATCH"]);

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const conversationId = String(params.conversation_id || "").trim();
  if (!conversationId) return badRequest("conversation_id is required");

  const db = requireDb(env);

  let conv = await getConversationById(db, conversationId);
  if (!conv) return notFound("Conversation not found");

  if (request.method === "GET") {
    try {
      const client = await getClientById(db, conv.client_id);
      const agent = conv.assigned_agent_id ? await getAgentById(db, conv.assigned_agent_id) : null;
      const messages = await getMessagesForConversation(db, conv.id);

      const now = new Date();
      const risk = recalcRisk(conv, now);
      // Return fresh risk + priority without forcing DB writes for every GET.
      const convView = conversationView(
        { ...conv, risk_flag: risk.riskFlag ? 1 : 0, risk_reasons_json: JSON.stringify(risk.riskReasons) },
        client,
        agent
      ) as any;
      convView.priority_score = risk.priorityScore;
      const anchor = parseIso(conv.last_agent_reply_at) || parseIso(conv.first_user_message_at);
      convView.minutes_since_last_agent_reply = minutesBetween(anchor, now);

      const metrics = conversationMetrics(messages, conv);
      (metrics as any).priority_score = risk.priorityScore;

      const insights = safeJsonParse<any>(conv.summary_json, {});

      return json({
        conversation: convView,
        messages: messages.map((m) => ({
          id: m.id,
          sender: m.sender,
          text: m.text,
          ts: m.ts,
          out_of_hours: Boolean(m.out_of_hours),
          provider: m.provider,
          provider_message_id: m.provider_message_id,
        })),
        metrics,
        insights,
      });
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.toLowerCase().includes("no such table")) {
        return serverError("DB is not initialized. Apply ./d1/schema.sql to your D1 database.");
      }
      return serverError(msg);
    }
  }

  // PATCH
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return badRequest("Invalid JSON payload");
  }

  const nowIso = new Date().toISOString();

  if (payload.assigned_agent_id !== undefined) {
    if (payload.assigned_agent_id === null || payload.assigned_agent_id === "") {
      conv.assigned_agent_id = null;
    } else {
      const agentId = String(payload.assigned_agent_id);
      const agent = await getAgentById(db, agentId);
      if (!agent) return notFound("Assigned agent not found");
      conv.assigned_agent_id = agentId;
    }
  }

  if (payload.status !== undefined && payload.status !== null) {
    const nextStatus = String(payload.status).toUpperCase().trim();
    if (nextStatus && nextStatus !== conv.status) {
      if (conv.status === "CLOSED" && nextStatus !== "CLOSED") {
        conv.reopened_count = (conv.reopened_count || 0) + 1;
        conv.closed_at = null;
      }
      if (nextStatus === "CLOSED" && !conv.closed_at) {
        conv.closed_at = nowIso;
      }
      conv.status = nextStatus as any;
    }
  }

  if (payload.outcome !== undefined && payload.outcome !== null) {
    conv.outcome = String(payload.outcome).toUpperCase().trim() as any;
  }

  conv.updated_at = nowIso;
  const risk = recalcRisk(conv, new Date());
  conv.risk_flag = risk.riskFlag ? 1 : 0;
  conv.risk_reasons_json = JSON.stringify(risk.riskReasons);

  try {
    await dbRun(
      db,
      `UPDATE conversations SET
        status = ?,
        assigned_agent_id = ?,
        outcome = ?,
        updated_at = ?,
        closed_at = ?,
        reopened_count = ?,
        risk_flag = ?,
        risk_reasons_json = ?
       WHERE id = ?`,
      [
        conv.status,
        conv.assigned_agent_id,
        conv.outcome,
        conv.updated_at,
        conv.closed_at,
        conv.reopened_count,
        conv.risk_flag,
        conv.risk_reasons_json,
        conv.id,
      ]
    );

    conv = (await getConversationById(db, conv.id)) as ConversationRow;
    const client = await getClientById(db, conv.client_id);
    const agent = conv.assigned_agent_id ? await getAgentById(db, conv.assigned_agent_id) : null;
    return json({ ok: true, conversation: conversationView(conv, client, agent) });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.toLowerCase().includes("no such table")) {
      return serverError("DB is not initialized. Apply ./d1/schema.sql to your D1 database.");
    }
    return serverError(msg);
  }
}

