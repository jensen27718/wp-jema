import { getSettings, type Env } from "./settings";

export const SLA_FIRST_REPLY_MINUTES = 10;
export const SLA_OVERDUE_NEW_MINUTES = 15;
export const SLA_OVERDUE_FOLLOW_UP_MINUTES = 60;

export type ConversationStatus =
  | "NEW"
  | "CONTACTED"
  | "INTERESTED"
  | "NEGOTIATION"
  | "CLOSED"
  | "SUPPORT"
  | "REENGAGEMENT";

export type MessageSender = "USER" | "BOT" | "AGENT";
export type Outcome = "UNKNOWN" | "WON" | "LOST" | "UNQUALIFIED";
export type SentimentLabel = "POSITIVE" | "NEUTRAL" | "NEGATIVE";

export type AgentRow = { id: string; name: string; active: number };
export type ClientRow = { id: string; name: string; phone: string; company: string | null; city: string; created_at: string };

export type ConversationRow = {
  id: string;
  client_id: string;
  status: ConversationStatus;
  assigned_agent_id: string | null;
  outcome: Outcome;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  reopened_count: number;
  last_message_at: string;
  first_user_message_at: string | null;
  first_agent_reply_at: string | null;
  last_agent_reply_at: string | null;
  summary_json: string | null;
  sentiment_label: SentimentLabel | null;
  sentiment_score: number | null;
  tags_json: string | null;
  risk_flag: number;
  risk_reasons_json: string | null;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  sender: MessageSender;
  text: string;
  ts: string;
  out_of_hours: number;
  provider: string;
  provider_message_id: string | null;
};

export function utcNowIso(): string {
  return new Date().toISOString();
}

export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function minutesBetween(earlier: Date | null, later: Date | null): number | null {
  if (!earlier || !later) return null;
  const minutes = Math.floor((later.getTime() - earlier.getTime()) / 60000);
  return Math.max(0, minutes);
}

export function isOutOfHours(ts: Date): boolean {
  // Keep same business hours logic as the Python version (interpreting timestamps as local-free).
  const weekday = ts.getUTCDay(); // 0=Sun ... 6=Sat
  const hour = ts.getUTCHours();
  if (weekday === 0) return true; // Sunday
  if (weekday === 6) return hour < 8 || hour >= 13; // Saturday
  return hour < 8 || hour >= 18; // Mon-Fri
}

export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function recalcRisk(conv: ConversationRow, now: Date): { riskFlag: boolean; riskReasons: string[]; priorityScore: number } {
  const reasons: string[] = [];
  const firstUser = parseIso(conv.first_user_message_at);
  const firstAgent = parseIso(conv.first_agent_reply_at);
  const lastAgent = parseIso(conv.last_agent_reply_at);

  if (firstUser && !firstAgent) {
    const ageMin = minutesBetween(firstUser, now) || 0;
    if (ageMin > SLA_OVERDUE_NEW_MINUTES) reasons.push("Sin primera respuesta");
  }

  const followUpStatuses: Set<ConversationStatus> = new Set([
    "CONTACTED",
    "INTERESTED",
    "NEGOTIATION",
    "REENGAGEMENT",
    "SUPPORT",
  ]);
  if (followUpStatuses.has(conv.status) && lastAgent) {
    const staleMin = minutesBetween(lastAgent, now) || 0;
    if (staleMin > SLA_OVERDUE_FOLLOW_UP_MINUTES) reasons.push("Seguimiento congelado");
  }

  if (conv.sentiment_label === "NEGATIVE") reasons.push("Sentimiento negativo");
  if ((conv.reopened_count || 0) > 0) reasons.push("Caso reabierto");

  // Priority score mirrors backend/app/services.py
  const tags = safeJsonParse<string[]>(conv.tags_json, []);
  let score = 0;
  if (reasons.includes("Sin primera respuesta") || reasons.includes("Seguimiento congelado")) score += 40;
  if (conv.sentiment_label === "NEGATIVE") score += 30;
  if ((conv.reopened_count || 0) > 0) score += 20;
  if (tags.includes("plan_pro")) score += 10;

  return { riskFlag: reasons.length > 0, riskReasons: reasons, priorityScore: score };
}

export function minutesWithoutReply(conv: ConversationRow, now: Date): number | null {
  const anchor = parseIso(conv.last_agent_reply_at) || parseIso(conv.first_user_message_at);
  return minutesBetween(anchor, now);
}

export function frtMinutes(conv: ConversationRow): number | null {
  return minutesBetween(parseIso(conv.first_user_message_at), parseIso(conv.first_agent_reply_at));
}

export function computeQualityScore(overdueRate: number, negativeRate: number, reopenRate: number, frtRatio: number): number {
  const score = 100.0 - (40 * overdueRate + 30 * negativeRate + 20 * reopenRate + 10 * frtRatio);
  return Math.max(0.0, Math.min(100.0, score));
}

export function conversationView(conv: ConversationRow, client: ClientRow | null, agent: AgentRow | null) {
  const riskReasons = safeJsonParse<string[]>(conv.risk_reasons_json, []);
  const tags = safeJsonParse<string[]>(conv.tags_json, []);
  return {
    id: conv.id,
    status: conv.status,
    outcome: conv.outcome,
    risk_flag: Boolean(conv.risk_flag),
    risk_reasons: riskReasons,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    last_message_at: conv.last_message_at,
    assigned_agent: agent ? { id: agent.id, name: agent.name } : null,
    client: client
      ? {
          id: client.id,
          name: client.name,
          phone: client.phone,
          company: client.company,
          city: client.city,
        }
      : null,
    sentiment_label: conv.sentiment_label,
    sentiment_score: conv.sentiment_score,
    tags,
  };
}

export function assertConfiguredForProduction(env: Env): void {
  const settings = getSettings(env);
  if (settings.appEnv !== "production") return;
  if (settings.authPassword === "change-me-now" && !settings.authPasswordHash) {
    throw new Error("APP_AUTH_PASSWORD must be changed in production");
  }
  if (settings.jwtSecretKey === "replace-this-secret") {
    throw new Error("JWT_SECRET_KEY must be configured in production");
  }
}

