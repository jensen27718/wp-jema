export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function json(data: JsonValue, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  // Basic hardening headers (keep minimal, compatible with Pages static + Functions).
  if (!headers.has("x-content-type-options")) headers.set("x-content-type-options", "nosniff");
  if (!headers.has("referrer-policy")) headers.set("referrer-policy", "no-referrer");

  return new Response(JSON.stringify(data), { ...init, headers });
}

export function text(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/plain; charset=utf-8");
  }
  if (!headers.has("x-content-type-options")) headers.set("x-content-type-options", "nosniff");
  if (!headers.has("referrer-policy")) headers.set("referrer-policy", "no-referrer");
  return new Response(body, { ...init, headers });
}

export function noContent(init: ResponseInit = {}): Response {
  return new Response(null, { status: 204, ...init });
}

export async function readJson<T = unknown>(request: Request): Promise<T> {
  const raw = await request.text();
  if (!raw) return null as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Invalid JSON payload");
  }
}

export function methodNotAllowed(allowed: string[]): Response {
  return json(
    { ok: false, detail: "Method not allowed" },
    {
      status: 405,
      headers: {
        allow: allowed.join(", "),
      },
    }
  );
}

export function badRequest(detail: string): Response {
  return json({ ok: false, detail }, { status: 400 });
}

export function unauthorized(detail = "Unauthorized"): Response {
  return json({ ok: false, detail }, { status: 401 });
}

export function forbidden(detail = "Forbidden"): Response {
  return json({ ok: false, detail }, { status: 403 });
}

export function notFound(detail = "Not found"): Response {
  return json({ ok: false, detail }, { status: 404 });
}

export function serverError(detail = "Internal error"): Response {
  return json({ ok: false, detail }, { status: 500 });
}

