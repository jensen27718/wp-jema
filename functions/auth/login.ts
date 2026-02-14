import { authenticateUser, createAccessToken } from "../_utils/auth";
import { assertConfiguredForProduction } from "../_utils/crm";
import { badRequest, json, methodNotAllowed, unauthorized } from "../_utils/http";
import { type Env } from "../_utils/settings";

type LoginRequest = { username?: string; password?: string };

export async function onRequest(context: any): Promise<Response> {
  const { request, env } = context as { request: Request; env: Env };
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  try {
    assertConfiguredForProduction(env);
  } catch (err: any) {
    return json({ ok: false, detail: String(err?.message || err) }, { status: 500 });
  }

  let payload: LoginRequest;
  try {
    payload = (await request.json()) as LoginRequest;
  } catch {
    return badRequest("Invalid JSON payload");
  }

  const username = String(payload.username || "").trim();
  const password = String(payload.password || "");
  if (!username || !password) return badRequest("username and password are required");

  const ok = await authenticateUser(username, password, env);
  if (!ok) return unauthorized("Invalid username or password");

  const token = await createAccessToken(username, env);
  return json(token);
}

