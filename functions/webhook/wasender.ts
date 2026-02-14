import { recalcRisk, parseIso, type ConversationRow } from "../_utils/crm";
import { appendMessage, createConversation, dbRun, findOpenConversation, getConversationById, requireDb, upsertClientByPhone } from "../_utils/db";
import { badRequest, json, methodNotAllowed, serverError, unauthorized } from "../_utils/http";
import { type Env, getSettings } from "../_utils/settings";
import { extractWebhookChatUpdates, extractWebhookMessages } from "../_utils/wasender";

function verifyWebhookToken(providedToken: string | null, env: Env): Response | null {
  const settings = getSettings(env);
  const expected = settings.wasenderWebhookToken;
  if (!expected) return json({ ok: false, detail: "Webhook token is not configured" }, { status: 503 });
  if (!providedToken || providedToken !== expected) return unauthorized("Invalid webhook token");
  return null;
}

export async function onRequest(context: any): Promise<Response> {
  const { request, env } = context as { request: Request; env: Env };
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const url = new URL(request.url);
  const webhookToken = request.headers.get("x-webhook-token") || url.searchParams.get("token");
  const tokenErr = verifyWebhookToken(webhookToken, env);
  if (tokenErr) return tokenErr;

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return badRequest("Invalid JSON payload");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return badRequest("Invalid JSON payload");

  const db = requireDb(env);
  try {
    const providerMessages = extractWebhookMessages(payload as Record<string, unknown>);
    const chatUpdates = extractWebhookChatUpdates(payload as Record<string, unknown>);

    let inserted = 0;
    const conversationIds = new Set<string>();

    for (const pm of providerMessages) {
      const client = await upsertClientByPhone(db, pm.wa_id);
      const conv = (await findOpenConversation(db, client.id)) || (await createConversation(db, client.id, pm.ts));
      const result = await appendMessage(db, conv, pm.sender, pm.text, pm.ts, "wasender", pm.provider_message_id);
      if (result) {
        inserted += 1;
        conversationIds.add(result.conversation.id);
      }
    }

    for (const update of chatUpdates) {
      const client = await upsertClientByPhone(db, update.wa_id);
      const conv = (await findOpenConversation(db, client.id)) || (await createConversation(db, client.id, update.ts));
      const incomingTs = parseIso(update.ts);
      const last = parseIso(conv.last_message_at);
      if (incomingTs && (!last || incomingTs.getTime() > last.getTime())) {
        const updated: ConversationRow = { ...conv };
        updated.last_message_at = update.ts;
        updated.updated_at = new Date().toISOString();
        const risk = recalcRisk(updated, new Date());
        updated.risk_flag = risk.riskFlag ? 1 : 0;
        updated.risk_reasons_json = JSON.stringify(risk.riskReasons);
        await dbRun(
          db,
          "UPDATE conversations SET last_message_at = ?, updated_at = ?, risk_flag = ?, risk_reasons_json = ? WHERE id = ?",
          [updated.last_message_at, updated.updated_at, updated.risk_flag, updated.risk_reasons_json, updated.id]
        );
        conversationIds.add(updated.id);
      }
    }

    return json({ ok: true, inserted_messages: inserted, conversations_touched: conversationIds.size });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.toLowerCase().includes("no such table")) {
      return serverError("DB is not initialized. Apply ./d1/schema.sql to your D1 database.");
    }
    return serverError(msg);
  }
}

