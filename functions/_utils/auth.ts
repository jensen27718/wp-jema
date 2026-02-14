import { base64UrlDecodeToBytes, base64UrlEncode, pbkdf2Sha256, textToBytes, timingSafeEqual, hmacSha256, bytesToBase64 } from "./crypto";
import { unauthorized } from "./http";
import { Env, getSettings } from "./settings";

type JwtPayload = Record<string, unknown> & {
  sub?: string;
  iat?: number;
  exp?: number;
  scope?: string;
};

function jsonStringifyCanonical(value: unknown): string {
  return JSON.stringify(value);
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function parseBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function verifyPassword(password: string, env: Env): Promise<boolean> {
  const settings = getSettings(env);
  const configuredHash = settings.authPasswordHash;
  if (configuredHash) {
    // Format: pbkdf2_sha256$iterations$salt$base64(dk)
    const prefix = "pbkdf2_sha256$";
    if (!configuredHash.startsWith(prefix)) return false;
    const parts = configuredHash.split("$");
    if (parts.length < 4) return false;
    const iterations = Number.parseInt(parts[1] || "", 10);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;
    const salt = parts[2] || "";
    const digest = parts.slice(3).join("$");
    const derived = await pbkdf2Sha256(password, salt, iterations, 32);
    const candidate = bytesToBase64(derived);
    // Compare as bytes to keep timing-constant.
    return timingSafeEqual(textToBytes(candidate), textToBytes(digest));
  }

  return password === settings.authPassword;
}

export async function authenticateUser(username: string, password: string, env: Env): Promise<boolean> {
  const settings = getSettings(env);
  if (username !== settings.authUsername) return false;
  return verifyPassword(password, env);
}

export async function createAccessToken(subject: string, env: Env): Promise<{ access_token: string; token_type: string; expires_in_seconds: number }> {
  const settings = getSettings(env);
  const expiresInSeconds = settings.accessTokenExpireMinutes * 60;
  const iat = nowEpochSeconds();
  const exp = iat + expiresInSeconds;
  const header = { alg: "HS256", typ: "JWT" };
  const payload: JwtPayload = { sub: subject, iat, exp, scope: "api" };
  const headerPart = base64UrlEncode(textToBytes(jsonStringifyCanonical(header)));
  const payloadPart = base64UrlEncode(textToBytes(jsonStringifyCanonical(payload)));
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = await hmacSha256(settings.jwtSecretKey, signingInput);
  const sigPart = base64UrlEncode(signature);
  return {
    access_token: `${signingInput}.${sigPart}`,
    token_type: "bearer",
    expires_in_seconds: expiresInSeconds,
  };
}

export async function requireAuth(request: Request, env: Env): Promise<{ username: string } | Response> {
  const settings = getSettings(env);
  const token = parseBearerToken(request);
  if (!token) return unauthorized("Missing bearer token");

  const parts = token.split(".");
  if (parts.length !== 3) return unauthorized("Invalid token");

  const [headerB64, payloadB64, sigB64] = parts;
  let payload: JwtPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecodeToBytes(payloadB64)));
  } catch {
    return unauthorized("Invalid token");
  }

  const exp = typeof payload.exp === "number" ? payload.exp : null;
  if (!exp || exp <= nowEpochSeconds()) return unauthorized("Invalid or expired token");

  const username = typeof payload.sub === "string" ? payload.sub : null;
  if (!username || username !== settings.authUsername) return unauthorized("Invalid or expired token");

  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = await hmacSha256(settings.jwtSecretKey, signingInput);
  let providedSig: Uint8Array;
  try {
    providedSig = base64UrlDecodeToBytes(sigB64);
  } catch {
    return unauthorized("Invalid token");
  }
  if (!timingSafeEqual(expectedSig, providedSig)) return unauthorized("Invalid or expired token");

  return { username };
}

