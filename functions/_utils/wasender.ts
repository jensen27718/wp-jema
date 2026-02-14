import { type MessageSender } from "./crm";

const PHONE_CHARS = /\d+/g;

export type ProviderMessage = {
  wa_id: string;
  text: string;
  ts: string; // ISO
  sender: MessageSender;
  provider_message_id: string | null;
};

export class WasenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WasenderError";
  }
}

export function normalizeWaId(value: unknown): string {
  if (value === null || value === undefined) return "";
  let raw = String(value).trim();
  if (!raw) return "";
  if (raw.includes("@")) raw = raw.split("@", 1)[0];
  const matches = raw.match(PHONE_CHARS);
  const digits = matches ? matches.join("") : "";
  return digits || raw;
}

export function parseProviderTimestamp(value: unknown): string {
  const now = new Date();
  if (value === null || value === undefined) return now.toISOString();

  if (typeof value === "number") {
    let numeric = value;
    if (numeric > 10_000_000_000) numeric = numeric / 1000.0; // ms -> s
    const d = new Date(numeric * 1000);
    return Number.isNaN(d.getTime()) ? now.toISOString() : d.toISOString();
  }

  const raw = String(value).trim();
  if (!raw) return now.toISOString();
  if (/^\d+$/.test(raw)) return parseProviderTimestamp(Number(raw));

  const normalized = raw.replace("Z", "+00:00");
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? now.toISOString() : d.toISOString();
}

export function nestedGet(data: Record<string, unknown>, path: string): unknown {
  let value: unknown = data;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function coerceJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractText(value: unknown): string | null {
  const node = coerceJson(value);
  if (node === null || node === undefined) return null;
  if (typeof node === "string") {
    const clean = node.trim();
    return clean ? clean : null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const text = extractText(item);
      if (text) return text;
    }
    return null;
  }
  if (typeof node !== "object") return null;

  const dict = node as Record<string, unknown>;
  const directKeys = ["text", "conversation", "body", "caption", "content"];
  for (const key of directKeys) {
    const found = extractText(dict[key]);
    if (found) return found;
  }

  if (dict.message !== undefined) {
    const found = extractText(dict.message);
    if (found) return found;
  }

  const extended = dict.extendedTextMessage;
  if (extended && typeof extended === "object") {
    const found = extractText((extended as Record<string, unknown>).text);
    if (found) return found;
  }

  const image = dict.imageMessage;
  if (image && typeof image === "object") {
    const found = extractText((image as Record<string, unknown>).caption);
    if (found) return found;
  }

  return null;
}

function boolLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
  }
  if (typeof value === "number") return Boolean(value);
  return null;
}

export function normalizeProviderMessage(payload: Record<string, unknown>, defaultSender: MessageSender): ProviderMessage | null {
  const candidate = coerceJson(payload);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const dict = candidate as Record<string, unknown>;

  const fromMeFlag = boolLike(dict.fromMe ?? dict.from_me ?? dict.isOutgoing ?? nestedGet(dict, "key.fromMe"));
  const direction = String(dict.direction ?? "").trim().toLowerCase();
  let sender: MessageSender;
  if (fromMeFlag === true || ["outbound", "sent"].includes(direction)) sender = "AGENT";
  else if (fromMeFlag === false || ["inbound", "received"].includes(direction)) sender = "USER";
  else sender = defaultSender;

  const waCandidates: unknown[] = [];
  if (sender === "AGENT") {
    waCandidates.push(dict.to, dict.recipient, nestedGet(dict, "key.remoteJid"), dict.jid, dict.wa_id);
  } else {
    waCandidates.push(dict.from, dict.author, nestedGet(dict, "key.remoteJid"), nestedGet(dict, "key.participant"), dict.jid, dict.wa_id);
  }

  let waId = "";
  for (const item of waCandidates) {
    const normalized = normalizeWaId(item);
    if (normalized) {
      waId = normalized;
      break;
    }
  }
  if (!waId) return null;

  const text =
    extractText(dict.text) ||
    extractText(dict.message) ||
    extractText(dict.body) ||
    extractText(dict.content) ||
    extractText(dict.data) ||
    extractText(dict);
  if (!text) return null;

  const ts = parseProviderTimestamp(dict.timestamp ?? dict.messageTimestamp ?? dict.created_at ?? dict.updated_at ?? dict.ts ?? dict.date);
  let providerMessageId = dict.message_id ?? dict.id ?? nestedGet(dict, "key.id") ?? nestedGet(dict, "message.id");
  providerMessageId = providerMessageId === undefined || providerMessageId === null ? null : String(providerMessageId);

  return {
    wa_id: waId,
    text: text.trim(),
    ts,
    sender,
    provider_message_id: providerMessageId,
  };
}

export function* messageNodes(payload: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 6) return;
  if (Array.isArray(payload)) {
    for (const item of payload) yield* messageNodes(item, depth + 1);
    return;
  }
  if (!payload || typeof payload !== "object") return;
  const dict = payload as Record<string, unknown>;

  const markerKeys = new Set([
    "message",
    "text",
    "body",
    "fromMe",
    "from",
    "to",
    "key",
    "wa_id",
    "id",
    "jid",
    "conversationTimestamp",
  ]);
  for (const key of Object.keys(dict)) {
    if (markerKeys.has(key)) {
      yield dict;
      break;
    }
  }

  for (const key of ["data", "payload", "messages", "message", "entry", "changes", "value"]) {
    const nested = dict[key];
    if (nested === undefined || nested === null) continue;
    yield* messageNodes(nested, depth + 1);
  }
}

export function extractWebhookMessages(payload: Record<string, unknown>): ProviderMessage[] {
  const event = String(payload.event ?? "").trim().toLowerCase();
  const defaultSender: MessageSender = event.includes("received") || event.includes("inbound") ? "USER" : "AGENT";

  const parsed: ProviderMessage[] = [];
  const seen = new Set<string>();
  for (const node of messageNodes(payload)) {
    const msg = normalizeProviderMessage(node, defaultSender);
    if (!msg) continue;
    const dedupKey = msg.provider_message_id || `${msg.wa_id}|${msg.sender}|${msg.ts}|${msg.text}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    parsed.push(msg);
  }

  parsed.sort((a, b) => a.ts.localeCompare(b.ts));
  return parsed;
}

export function extractWebhookChatUpdates(payload: Record<string, unknown>): Array<{ wa_id: string; ts: string }> {
  const event = String(payload.event ?? "").trim().toLowerCase();
  if (!event.includes("chat")) return [];

  const updates: Array<{ wa_id: string; ts: string }> = [];
  const seen = new Set<string>();
  for (const node of messageNodes(payload)) {
    const waId = normalizeWaId(node.id ?? node.jid ?? nestedGet(node, "key.remoteJid") ?? node.wa_id);
    if (!waId) continue;
    const ts = parseProviderTimestamp(
      node.conversationTimestamp ?? node.timestamp ?? node.created_at ?? node.updated_at
    );
    const dedupKey = `${waId}|${ts}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    updates.push({ wa_id: waId, ts });
  }
  return updates;
}

export async function wasenderSendTextMessage(opts: {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  phone: string;
  text: string;
}): Promise<{ payload: any; messageId: string | null }> {
  const url = `${opts.baseUrl.replace(/\\/$/, "")}/api/whatsapp-sessions/${opts.sessionId}/messages/text`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to: normalizeWaId(opts.phone), text: opts.text }),
  });
  const text = await res.text();
  if (!res.ok) {
    const excerpt = text.length > 240 ? text.slice(0, 240) + "..." : text;
    throw new WasenderError(`Wasender error ${res.status}: ${excerpt}`);
  }
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  let messageId: any = payload?.message_id ?? payload?.id;
  if (messageId && typeof messageId === "object") messageId = messageId.id;
  const normalized = messageId === undefined || messageId === null ? null : String(messageId);
  return { payload, messageId: normalized };
}

