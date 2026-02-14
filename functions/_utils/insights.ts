import { type SentimentLabel } from "./crm";
import { type Env, getSettings } from "./settings";

const NEGATIVE_HINTS: Record<string, string> = {
  caro: "precio",
  demora: "demora",
  esperando: "demora",
  molesto: "soporte",
  cancel: "cancelacion",
  problema: "soporte",
};

const POSITIVE_HINTS = new Set(["gracias", "pagado", "perfecto", "listo", "excelente"]);

export async function analyzeMessages(texts: string[], env: Env): Promise<any> {
  const settings = getSettings(env);
  if (!settings.deepseekApiKey) return analyzeMock(texts);
  try {
    return await analyzeWithDeepseek(texts, settings.deepseekApiKey, settings.deepseekBaseUrl);
  } catch {
    return analyzeMock(texts);
  }
}

async function analyzeWithDeepseek(texts: string[], apiKey: string, baseUrl: string): Promise<any> {
  const conversationText = texts.join("\n");
  const prompt = `
Analiza la siguiente conversacion de ventas/soporte y genera un JSON con insights.

Requisitos de salida (JSON crudo):
{
  "summary_bullets": ["breve punto 1", "breve punto 2", "accion sugerida"],
  "sentiment_label": "POSITIVE" | "NEUTRAL" | "NEGATIVE",
  "sentiment_score": (int 1-10),
  "suggested_reply": "Genera una respuesta sugerida para el agente, corta y profesional, orientada a la venta o solucion",
  "key_points": {
    "need": "necesidad principal del cliente",
    "objection": "objecion principal o vacio",
    "urgency": "alta" | "media" | "baja",
    "next_step": "accion recomendada para el agente"
  },
  "tags": ["tag1", "tag2", "tag3"]
}

Conversacion:
${conversationText}
`.trim();

  const url = `${baseUrl.replace(/\\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "Eres un experto analista de CRM. Responde SOLO con JSON valido." },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" },
    }),
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`DeepSeek error ${res.status}: ${raw.slice(0, 200)}`);

  const data = raw ? JSON.parse(raw) : {};
  const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
  let cleaned = content;
  if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7).trim();
  if (cleaned.startsWith("```")) cleaned = cleaned.slice(3).trim();
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3).trim();
  const parsed = cleaned ? JSON.parse(cleaned) : {};

  return {
    summary_bullets: Array.isArray(parsed.summary_bullets) ? parsed.summary_bullets.slice(0, 5) : ["Sin resumen"],
    sentiment_label: parsed.sentiment_label || "NEUTRAL",
    sentiment_score: typeof parsed.sentiment_score === "number" ? parsed.sentiment_score : 5,
    suggested_reply: parsed.suggested_reply || "",
    key_points: {
      need: parsed?.key_points?.need || "Desconocido",
      objection: parsed?.key_points?.objection || "",
      urgency: parsed?.key_points?.urgency || "media",
      next_step: parsed?.key_points?.next_step || "Revisar caso",
    },
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 10) : [],
  };
}

function analyzeMock(texts: string[]): any {
  const merged = texts.join(" ").toLowerCase();
  const tags: string[] = [];
  for (const [token, tag] of Object.entries(NEGATIVE_HINTS)) {
    if (merged.includes(token)) tags.push(tag);
  }

  const uniqueTags = Array.from(new Set(tags)).slice(0, 5);
  const negativeMatches = Object.keys(NEGATIVE_HINTS).filter((t) => merged.includes(t)).length;
  const positiveMatches = Array.from(POSITIVE_HINTS).filter((t) => merged.includes(t)).length;

  let sentiment: SentimentLabel = "NEUTRAL";
  let score = 5;
  let objection = "";

  if (negativeMatches > positiveMatches) {
    sentiment = "NEGATIVE";
    score = Math.max(1, 6 - negativeMatches);
    objection = uniqueTags[0] || "desconocido";
  } else if (positiveMatches > 0) {
    sentiment = "POSITIVE";
    score = Math.min(10, 7 + positiveMatches);
  }

  const commonWords = merged
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .slice(0, 200)
    .reduce<Record<string, number>>((acc, w) => {
      acc[w] = (acc[w] || 0) + 1;
      return acc;
    }, {});
  const top = Object.entries(commonWords).sort((a, b) => b[1] - a[1]).slice(0, 2);
  const bullets = [
    "Contexto sintetizado desde los ultimos mensajes.",
    `Tema principal: ${top[0]?.[0] || "general"}`,
    "Priorizar respuesta en esta conversacion.",
  ];

  return {
    summary_bullets: bullets.slice(0, 5),
    sentiment_label: sentiment,
    sentiment_score: score,
    key_points: {
      need: "Acompanamiento comercial o soporte.",
      objection,
      urgency: merged.includes("urgente") ? "alta" : "media",
      next_step: "Responder con accion concreta y confirmar cierre.",
    },
    tags: uniqueTags,
  };
}

