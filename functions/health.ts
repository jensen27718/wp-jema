import { json, methodNotAllowed } from "./_utils/http";

export async function onRequest(context: any): Promise<Response> {
  const { request } = context as { request: Request };
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  return json({ status: "ok" });
}

