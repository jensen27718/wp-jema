import { type Env, getSettings } from "./_utils/settings";
import { noContent } from "./_utils/http";

function withCorsHeaders(request: Request, env: Env, response: Response): Response {
  const settings = getSettings(env);
  const origin = request.headers.get("origin");
  if (!origin) return response;
  if (!settings.corsAllowedOrigins.length) return response;
  if (!settings.corsAllowedOrigins.includes(origin)) return response;

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  headers.set("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,content-type,x-webhook-token");
  return new Response(response.body, { ...response, headers });
}

export async function onRequest(context: any): Promise<Response> {
  const { request, env, next } = context as { request: Request; env: Env; next: () => Promise<Response> };

  if (request.method === "OPTIONS") {
    const res = noContent();
    return withCorsHeaders(request, env, res);
  }

  const response = await next();
  return withCorsHeaders(request, env, response);
}

