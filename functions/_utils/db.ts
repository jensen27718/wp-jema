import {
  type AgentRow,
  type ClientRow,
  type ConversationRow,
  type MessageRow,
  type MessageSender,
  type ConversationStatus,
  utcNowIso,
  parseIso,
  isOutOfHours,
  recalcRisk,
  safeJsonParse,
} from "./crm";
import { type Env } from "./settings";

function isD1Error(err: unknown): err is Error {
  return err instanceof Error;
}

function normalizeDbError(err: unknown): string {
  if (!isD1Error(err)) return "Database error";
  return err.message || "Database error";
}

export function requireDb(env: Env): D1Database {
  if (!env.DB) throw new Error("DB binding is missing. Bind a D1 database as 'DB'.");
  return env.DB;
}

export async function dbFirst<T = any>(db: D1Database, sql: string, params: unknown[] = []): Promise<T | null> {
  const stmt = db.prepare(sql);
  const res = params.length ? await stmt.bind(...params).first<T>() : await stmt.first<T>();
  return (res as T) ?? null;
}

export async function dbAll<T = any>(db: D1Database, sql: string, params: unknown[] = []): Promise<T[]> {
  const stmt = db.prepare(sql);
  const res = params.length ? await stmt.bind(...params).all<T>() : await stmt.all<T>();
  return (res?.results as T[]) || [];
}

export async function dbRun(db: D1Database, sql: string, params: unknown[] = []): Promise<D1Result> {
  const stmt = db.prepare(sql);
  return params.length ? await stmt.bind(...params).run() : await stmt.run();
}

export async function getAgentById(db: D1Database, id: string): Promise<AgentRow | null> {
  return dbFirst<AgentRow>(db, "SELECT id, name, active FROM agents WHERE id = ? LIMIT 1", [id]);
}

export async function getClientById(db: D1Database, id: string): Promise<ClientRow | null> {
  return dbFirst<ClientRow>(
    db,
    "SELECT id, name, phone, company, city, created_at FROM clients WHERE id = ? LIMIT 1",
    [id]
  );
}

export async function getConversationById(db: D1Database, id: string): Promise<ConversationRow | null> {
  return dbFirst<ConversationRow>(db, "SELECT * FROM conversations WHERE id = ? LIMIT 1", [id]);
}

export async function getMessagesForConversation(db: D1Database, conversationId: string): Promise<MessageRow[]> {
  return dbAll<MessageRow>(db, "SELECT * FROM messages WHERE conversation_id = ? ORDER BY ts ASC", [conversationId]);
}

export async function upsertClientByPhone(db: D1Database, phone: string): Promise<ClientRow> {
  const existing = await dbFirst<ClientRow>(
    db,
    "SELECT id, name, phone, company, city, created_at FROM clients WHERE phone = ? LIMIT 1",
    [phone]
  );
  if (existing) return existing;

  const id = crypto.randomUUID();
  const suffix = phone.length >= 4 ? phone.slice(-4) : phone;
  const createdAt = utcNowIso();
  const name = `Cliente ${suffix}`;
  const city = "Cucuta";

  await dbRun(
    db,
    "INSERT INTO clients (id, name, phone, company, city, created_at) VALUES (?, ?, ?, NULL, ?, ?)",
    [id, name, phone, city, createdAt]
  );

  return {
    id,
    name,
    phone,
    company: null,
    city,
    created_at: createdAt,
  };
}

export async function findOpenConversation(db: D1Database, clientId: string): Promise<ConversationRow | null> {
  return dbFirst<ConversationRow>(
    db,
    "SELECT * FROM conversations WHERE client_id = ? AND status != 'CLOSED' ORDER BY last_message_at DESC LIMIT 1",
    [clientId]
  );
}

export async function createConversation(db: D1Database, clientId: string, nowIso: string): Promise<ConversationRow> {
  const id = crypto.randomUUID();
  const status: ConversationStatus = "NEW";
  const outcome = "UNKNOWN";
  const updatedAt = utcNowIso();
  await dbRun(
    db,
    `INSERT INTO conversations (
      id, client_id, status, assigned_agent_id, outcome,
      created_at, updated_at, closed_at, reopened_count,
      last_message_at, first_user_message_at, first_agent_reply_at, last_agent_reply_at,
      summary_json, sentiment_label, sentiment_score, tags_json, risk_flag, risk_reasons_json
    ) VALUES (
      ?, ?, ?, NULL, ?,
      ?, ?, NULL, 0,
      ?, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, 0, NULL
    )`,
    [id, clientId, status, outcome, nowIso, updatedAt, nowIso]
  );
  const created = await getConversationById(db, id);
  if (!created) throw new Error("Failed to create conversation");
  return created;
}

export async function messageExists(
  db: D1Database,
  conversationId: string,
  provider: string,
  providerMessageId: string | null,
  sender: MessageSender | null,
  text: string | null,
  tsIso: string | null
): Promise<boolean> {
  if (providerMessageId) {
    const hit = await dbFirst<{ id: string }>(
      db,
      "SELECT id FROM messages WHERE conversation_id = ? AND provider = ? AND provider_message_id = ? LIMIT 1",
      [conversationId, provider, providerMessageId]
    );
    if (hit) return true;
  }
  if (!sender || !text || !tsIso) return false;
  const fallback = await dbFirst<{ id: string }>(
    db,
    "SELECT id FROM messages WHERE conversation_id = ? AND sender = ? AND text = ? AND ts = ? LIMIT 1",
    [conversationId, sender, text, tsIso]
  );
  return Boolean(fallback);
}

export async function appendMessage(
  db: D1Database,
  conv: ConversationRow,
  sender: MessageSender,
  text: string,
  tsIso: string,
  provider: string,
  providerMessageId: string | null
): Promise<{ message: MessageRow; conversation: ConversationRow } | null> {
  const tsDate = parseIso(tsIso) || new Date();

  const exists = await messageExists(db, conv.id, provider, providerMessageId, sender, text, tsIso);
  if (exists) return null;

  const messageId = crypto.randomUUID();
  const outOfHours = isOutOfHours(tsDate) ? 1 : 0;

  // Insert message first.
  await dbRun(
    db,
    `INSERT INTO messages (id, conversation_id, sender, text, ts, out_of_hours, provider, provider_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [messageId, conv.id, sender, text, tsIso, outOfHours, provider, providerMessageId]
  );

  // Update conversation aggregates similar to backend/app/main.py
  const now = new Date();
  const nowIso = utcNowIso();

  const updated: ConversationRow = { ...conv };
  const lastMessageAt = parseIso(updated.last_message_at);
  const isNewestMessage = !lastMessageAt || tsDate.getTime() >= lastMessageAt.getTime();

  if (sender === "USER" && updated.status === "CLOSED" && isNewestMessage) {
    updated.status = "REENGAGEMENT";
    updated.closed_at = null;
    updated.reopened_count = (updated.reopened_count || 0) + 1;
  }

  if (sender === "USER") {
    const firstUser = parseIso(updated.first_user_message_at);
    if (!firstUser || tsDate.getTime() < firstUser.getTime()) {
      updated.first_user_message_at = tsIso;
    }
  }

  if (sender === "AGENT") {
    const firstUser = parseIso(updated.first_user_message_at);
    if (firstUser) {
      const firstAgent = parseIso(updated.first_agent_reply_at);
      if (!firstAgent || tsDate.getTime() < firstAgent.getTime()) {
        updated.first_agent_reply_at = tsIso;
      }
    }
    const lastAgent = parseIso(updated.last_agent_reply_at);
    if (!lastAgent || tsDate.getTime() > lastAgent.getTime()) {
      updated.last_agent_reply_at = tsIso;
    }
  }

  if (!lastMessageAt || tsDate.getTime() > lastMessageAt.getTime()) {
    updated.last_message_at = tsIso;
  }
  updated.updated_at = nowIso;

  const risk = recalcRisk(updated, now);
  updated.risk_flag = risk.riskFlag ? 1 : 0;
  updated.risk_reasons_json = JSON.stringify(risk.riskReasons);

  await dbRun(
    db,
    `UPDATE conversations SET
      status = ?,
      assigned_agent_id = ?,
      outcome = ?,
      updated_at = ?,
      closed_at = ?,
      reopened_count = ?,
      last_message_at = ?,
      first_user_message_at = ?,
      first_agent_reply_at = ?,
      last_agent_reply_at = ?,
      risk_flag = ?,
      risk_reasons_json = ?
     WHERE id = ?`,
    [
      updated.status,
      updated.assigned_agent_id,
      updated.outcome,
      updated.updated_at,
      updated.closed_at,
      updated.reopened_count,
      updated.last_message_at,
      updated.first_user_message_at,
      updated.first_agent_reply_at,
      updated.last_agent_reply_at,
      updated.risk_flag,
      updated.risk_reasons_json,
      updated.id,
    ]
  );

  const updatedConv = await getConversationById(db, updated.id);
  if (!updatedConv) throw new Error("Failed to refresh conversation after append");

  const message: MessageRow = {
    id: messageId,
    conversation_id: conv.id,
    sender,
    text,
    ts: tsIso,
    out_of_hours: outOfHours,
    provider,
    provider_message_id: providerMessageId,
  };

  return { message, conversation: updatedConv };
}

export async function refreshRiskFlags(db: D1Database, conversations: ConversationRow[], now: Date): Promise<void> {
  // Keep it simple: update rows that changed. For small datasets this is fine.
  const updates: Array<Promise<any>> = [];
  for (const conv of conversations) {
    const currentReasons = safeJsonParse<string[]>(conv.risk_reasons_json, []);
    const risk = recalcRisk(conv, now);
    const riskFlag = risk.riskFlag ? 1 : 0;
    const reasonsJson = JSON.stringify(risk.riskReasons);
    const changed = riskFlag !== (conv.risk_flag ? 1 : 0) || JSON.stringify(currentReasons) !== JSON.stringify(risk.riskReasons);
    if (!changed) continue;
    updates.push(
      dbRun(
        db,
        "UPDATE conversations SET risk_flag = ?, risk_reasons_json = ?, updated_at = ? WHERE id = ?",
        [riskFlag, reasonsJson, utcNowIso(), conv.id]
      )
    );
  }
  if (updates.length) await Promise.all(updates);
}

export async function ensureDefaultAgent(db: D1Database): Promise<void> {
  const existing = await dbFirst<{ id: string }>(db, "SELECT id FROM agents LIMIT 1");
  if (existing) return;
  const id = crypto.randomUUID();
  await dbRun(db, "INSERT INTO agents (id, name, active) VALUES (?, ?, 1)", [id, "Agente 1"]);
}

