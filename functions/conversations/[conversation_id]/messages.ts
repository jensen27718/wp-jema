import { requireAuth } from "../../_utils/auth";
import { type MessageSender } from "../../_utils/crm";
import { appendMessage, getClientById, getConversationById, requireDb } from "../../_utils/db";
import { badRequest, json, methodNotAllowed, notFound, serverError } from "../../_utils/http";
import { type Env, getSettings } from "../../_utils/settings";
import { wasenderSendTextMessage, WasenderError } from "../../_utils/wasender";

type AddMessageRequest = {
  sender?: MessageSender;
  text?: string;
  provider?: string;
  provider_message_id?: string | null;
  ts?: string | null;
};

export async function onRequest(context: any): Promise<Response> {
  const { request, env, params } = context as { request: Request; env: Env; params: Record<string, string> };
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const conversationId = String(params.conversation_id || "").trim();
  if (!conversationId) return badRequest("conversation_id is required");

  let payload: AddMessageRequest;
  try {
    payload = (await request.json()) as AddMessageRequest;
  } catch {
    return badRequest("Invalid JSON payload");
  }

  const sender = String(payload.sender || "").toUpperCase().trim() as MessageSender;
  const text = String(payload.text || "").trim();
  const provider = String(payload.provider || "mock").trim() || "mock";
  const tsIso = payload.ts ? String(payload.ts) : new Date().toISOString();
  let providerMessageId = payload.provider_message_id ? String(payload.provider_message_id) : null;

  if (!sender || !["USER", "AGENT", "BOT"].includes(sender)) return badRequest("sender must be USER, AGENT or BOT");
  if (!text) return badRequest("Message text cannot be empty");

  const settings = getSettings(env);
  const db = requireDb(env);

  try {
    const conv = await getConversationById(db, conversationId);
    if (!conv) return notFound("Conversation not found");

    const client = await getClientById(db, conv.client_id);
    if (!client) return notFound("Client not found");

    // If this is an agent/bot message, optionally push outbound via Wasender.
    if ((sender === "AGENT" || sender === "BOT") && settings.wasenderPushOutbound) {
      if (!settings.wasenderApiKey || !settings.wasenderSessionId) {
        return badRequest("WASENDER_API_KEY and WASENDER_SESSION_ID are required to send outbound messages");
      }
      const { messageId } = await wasenderSendTextMessage({
        baseUrl: settings.wasenderBaseUrl,
        apiKey: settings.wasenderApiKey,
        sessionId: settings.wasenderSessionId,
        phone: client.phone,
        text,
      });
      providerMessageId = messageId;
    }

    const appended = await appendMessage(db, conv, sender, text, tsIso, provider, providerMessageId);
    if (!appended) {
      // Dedupe hit; still return ok with conversation id.
      return json({ conversation_id: conv.id, message_id: null });
    }
    return json({ conversation_id: conv.id, message_id: appended.message.id });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.toLowerCase().includes("no such table")) {
      return serverError("DB is not initialized. Apply ./d1/schema.sql to your D1 database.");
    }
    if (err instanceof WasenderError) {
      return json({ ok: false, detail: msg }, { status: 502 });
    }
    return serverError(msg);
  }
}

