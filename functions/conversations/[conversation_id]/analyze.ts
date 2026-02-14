import { requireAuth } from "../../_utils/auth";
import { recalcRisk, safeJsonParse, type ConversationRow } from "../../_utils/crm";
import { analyzeMessages } from "../../_utils/insights";
import { dbRun, getConversationById, getMessagesForConversation, requireDb } from "../../_utils/db";
import { badRequest, json, methodNotAllowed, notFound, serverError } from "../../_utils/http";
import { type Env } from "../../_utils/settings";

type AnalyzeRequest = { force?: boolean };

export async function onRequest(context: any): Promise<Response> {
  const { request, env, params } = context as { request: Request; env: Env; params: Record<string, string> };
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const conversationId = String(params.conversation_id || "").trim();
  if (!conversationId) return badRequest("conversation_id is required");

  let payload: AnalyzeRequest = {};
  try {
    payload = (await request.json()) as AnalyzeRequest;
  } catch {
    // body is optional; keep default
  }

  const db = requireDb(env);
  try {
    const conv = await getConversationById(db, conversationId);
    if (!conv) return notFound("Conversation not found");

    if (conv.summary_json && !payload.force) {
      return json(safeJsonParse<any>(conv.summary_json, {}));
    }

    const messages = await getMessagesForConversation(db, conv.id);
    const texts = messages.map((m) => m.text).slice(-30);
    if (!texts.length) return badRequest("Conversation has no messages");

    const insights = await analyzeMessages(texts, env);
    const sentimentLabel = insights?.sentiment_label ? String(insights.sentiment_label).toUpperCase() : null;
    const sentimentScore = typeof insights?.sentiment_score === "number" ? insights.sentiment_score : null;
    const tags = Array.isArray(insights?.tags) ? insights.tags.map((t: any) => String(t)).slice(0, 10) : [];

    const updated: ConversationRow = { ...conv };
    updated.summary_json = JSON.stringify(insights || {});
    updated.sentiment_label = sentimentLabel as any;
    updated.sentiment_score = sentimentScore as any;
    updated.tags_json = JSON.stringify(tags);
    updated.updated_at = new Date().toISOString();

    const risk = recalcRisk(updated, new Date());
    updated.risk_flag = risk.riskFlag ? 1 : 0;
    updated.risk_reasons_json = JSON.stringify(risk.riskReasons);

    await dbRun(
      db,
      `UPDATE conversations SET
        summary_json = ?,
        sentiment_label = ?,
        sentiment_score = ?,
        tags_json = ?,
        updated_at = ?,
        risk_flag = ?,
        risk_reasons_json = ?
       WHERE id = ?`,
      [
        updated.summary_json,
        updated.sentiment_label,
        updated.sentiment_score,
        updated.tags_json,
        updated.updated_at,
        updated.risk_flag,
        updated.risk_reasons_json,
        updated.id,
      ]
    );

    return json({ ok: true, insights });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.toLowerCase().includes("no such table")) {
      return serverError("DB is not initialized. Apply ./d1/schema.sql to your D1 database.");
    }
    return serverError(msg);
  }
}

