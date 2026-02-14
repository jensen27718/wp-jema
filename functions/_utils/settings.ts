export type Env = Record<string, unknown> & {
  DB?: D1Database;
};

export type Settings = {
  appEnv: string;
  allowDemoRoutes: boolean;
  corsAllowedOrigins: string[];
  authUsername: string;
  authPassword: string;
  authPasswordHash?: string;
  jwtSecretKey: string;
  accessTokenExpireMinutes: number;

  deepseekApiKey?: string;
  deepseekBaseUrl: string;

  wasenderBaseUrl: string;
  wasenderApiKey?: string;
  wasenderSessionId?: string;
  wasenderWebhookToken?: string;
  wasenderPushOutbound: boolean;
};

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asBool(value: unknown, defaultValue: boolean): boolean {
  const raw = asString(value);
  if (!raw) return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function asInt(value: unknown, defaultValue: number, minValue = 1): number {
  const raw = asString(value);
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(minValue, parsed);
}

function asCsv(value: unknown): string[] {
  const raw = asString(value);
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getSettings(env: Env): Settings {
  return {
    appEnv: (asString(env.APP_ENV) || "development").toLowerCase(),
    allowDemoRoutes: asBool(env.ALLOW_DEMO_ROUTES, false),
    corsAllowedOrigins: asCsv(env.CORS_ALLOWED_ORIGINS),
    authUsername: asString(env.APP_AUTH_USERNAME) || "admin",
    authPassword: asString(env.APP_AUTH_PASSWORD) || "change-me-now",
    authPasswordHash: asString(env.APP_AUTH_PASSWORD_HASH),
    jwtSecretKey: asString(env.JWT_SECRET_KEY) || "replace-this-secret",
    accessTokenExpireMinutes: asInt(env.ACCESS_TOKEN_EXPIRE_MINUTES, 480, 1),

    deepseekApiKey: asString(env.DEEPSEEK_API_KEY),
    deepseekBaseUrl: asString(env.DEEPSEEK_BASE_URL) || "https://api.deepseek.com",

    wasenderBaseUrl: asString(env.WASENDER_BASE_URL) || "https://www.wasenderapi.com",
    wasenderApiKey: asString(env.WASENDER_API_KEY),
    wasenderSessionId: asString(env.WASENDER_SESSION_ID),
    wasenderWebhookToken: asString(env.WASENDER_WEBHOOK_TOKEN),
    wasenderPushOutbound: asBool(env.WASENDER_PUSH_OUTBOUND, true),
  };
}

