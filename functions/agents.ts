import { requireAuth } from "./_utils/auth";
import { dbAll, dbRun, requireDb } from "./_utils/db";
import { badRequest, json, methodNotAllowed, serverError } from "./_utils/http";
import { type Env } from "./_utils/settings";
import { type AgentRow } from "./_utils/crm";

export async function onRequest(context: any): Promise<Response> {
  const { request, env } = context as { request: Request; env: Env };
  if (!["GET", "POST"].includes(request.method)) return methodNotAllowed(["GET", "POST"]);

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const db = requireDb(env);

  if (request.method === "GET") {
    try {
      const agents = await dbAll<AgentRow>(db, "SELECT id, name, active FROM agents ORDER BY name ASC");
      return json(agents.map((a) => ({ id: a.id, name: a.name, active: Boolean(a.active) })));
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.toLowerCase().includes("no such table")) {
        return serverError("DB is not initialized. Apply ./d1/schema.sql to your D1 database.");
      }
      return serverError(msg);
    }
  }

  // POST
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return badRequest("Invalid JSON payload");
  }
  const name = String(payload?.name || "").trim();
  if (!name) return badRequest("name is required");

  try {
    const id = crypto.randomUUID();
    await dbRun(db, "INSERT INTO agents (id, name, active) VALUES (?, ?, 1)", [id, name]);
    return json({ ok: true, agent: { id, name, active: true } }, { status: 201 });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.toLowerCase().includes("no such table")) {
      return serverError("DB is not initialized. Apply ./d1/schema.sql to your D1 database.");
    }
    return serverError(msg);
  }
}

