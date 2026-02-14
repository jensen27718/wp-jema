import { requireAuth } from "../_utils/auth";
import { dbAll, requireDb } from "../_utils/db";
import { badRequest, json, methodNotAllowed, serverError } from "../_utils/http";
import { type Env } from "../_utils/settings";
import { type ClientRow, type ConversationRow } from "../_utils/crm";

export async function onRequest(context: any): Promise<Response> {
  const { request, env } = context as { request: Request; env: Env };
  if (request.method !== "GET") return methodNotAllowed(["GET"]);

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit") || "10";
  const q = url.searchParams.get("q") || "";
  const limit = Math.max(1, Math.min(50, Number.parseInt(limitRaw, 10) || 10));
  const qLower = q.trim().toLowerCase() || null;

  let conversations: ConversationRow[] = [];
  let clients: ClientRow[] = [];
  try {
    const db = requireDb(env);
    conversations = await dbAll<ConversationRow>(db, "SELECT * FROM conversations ORDER BY last_message_at DESC");
    clients = await dbAll<ClientRow>(db, "SELECT id, name, phone, company, city, created_at FROM clients");
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.toLowerCase().includes("no such table")) {
      return serverError("DB is not initialized. Apply ./d1/schema.sql to your D1 database.");
    }
    return serverError(msg);
  }

  const clientsMap = new Map<string, ClientRow>(clients.map((c) => [c.id, c]));

  const withUser = conversations.filter((c) => c.first_user_message_at !== null && c.first_user_message_at !== undefined);
  const withoutUser = conversations.filter((c) => !c.first_user_message_at);
  const ordered = withUser.concat(withoutUser);

  const rows: any[] = [];
  const seenPhones = new Set<string>();
  for (const conv of ordered) {
    const client = clientsMap.get(conv.client_id);
    if (!client) continue;
    if (seenPhones.has(client.phone)) continue;

    if (qLower) {
      const searchable = [client.name, client.phone, client.company || ""].filter(Boolean).join(" ").toLowerCase();
      if (!searchable.includes(qLower)) continue;
    }

    seenPhones.add(client.phone);
    rows.push({
      conversation_id: conv.id,
      client_name: client.name,
      phone: client.phone,
      last_seen_at: conv.last_message_at,
      status: conv.status,
      has_user_message: Boolean(conv.first_user_message_at),
    });
    if (rows.length >= limit) break;
  }

  return json(rows);
}

