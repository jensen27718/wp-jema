from __future__ import annotations

import json
from collections import Counter

from openai import OpenAI

from .config import settings
from .models import SentimentLabel

client = (
    OpenAI(api_key=settings.deepseek_api_key, base_url=settings.deepseek_base_url)
    if settings.deepseek_api_key
    else None
)

NEGATIVE_HINTS = {
    "caro": "precio",
    "demora": "demora",
    "esperando": "demora",
    "molesto": "soporte",
    "cancel": "cancelacion",
    "problema": "soporte",
}

POSITIVE_HINTS = {"gracias", "pagado", "perfecto", "listo", "excelente"}


def analyze_messages(texts: list[str]) -> dict:
    """
    Analyzes conversation messages using DeepSeek API with a fallback to mock logic.
    """
    if client is None:
        return _analyze_mock(texts)
    try:
        return _analyze_with_deepseek(texts)
    except Exception as e:
        print(f"DeepSeek API Error: {e}. Falling back to mock analysis.")
        return _analyze_mock(texts)


def _analyze_with_deepseek(texts: list[str]) -> dict:
    conversation_text = "\n".join(texts)
    
    prompt = f"""
    Analiza la siguiente conversación de ventas/soporte y genera un JSON con insights.
    
    Requisitos de salida (JSON crudo):
    {{
        "summary_bullets": ["breve punto 1", "breve punto 2", "accion sugerida"],
        "sentiment_label": "POSITIVE" | "NEUTRAL" | "NEGATIVE",
        "sentiment_score": (int 1-10),
        "suggested_reply": "Genera una respuesta sugerida para el agente, corta y profesional, orientada a la venta o solucion",
        "key_points": {{
            "need": "necesidad principal del cliente",
            "objection": "objecion principal o vacío",
            "urgency": "alta" | "media" | "baja",
            "next_step": "accion recomendada para el agente"
        }},
        "tags": ["tag1", "tag2", "tag3"]
    }}

    Conversación:
    {conversation_text}
    """

    response = client.chat.completions.create(
        model="deepseek-chat",
        messages=[
            {"role": "system", "content": "Eres un experto analista de CRM. Responde SOLO con JSON válido."},
            {"role": "user", "content": prompt},
        ],
        temperature=0.1,
        max_tokens=500,
        response_format={"type": "json_object"},
    )
    
    content = response.choices[0].message.content.strip()
    # Cleanup markdown code blocks if present
    if content.startswith("```json"):
        content = content[7:]
    if content.endswith("```"):
        content = content[:-3]
        
    data = json.loads(content)
    
    # Ensure keys exist
    return {
        "summary_bullets": data.get("summary_bullets", ["Sin resumen"]),
        "sentiment_label": data.get("sentiment_label", "NEUTRAL"),
        "sentiment_score": data.get("sentiment_score", 5),
        "suggested_reply": data.get("suggested_reply", ""),
        "key_points": {
            "need": data.get("key_points", {}).get("need", "Desconocido"),
            "objection": data.get("key_points", {}).get("objection", ""),
            "urgency": data.get("key_points", {}).get("urgency", "media"),
            "next_step": data.get("key_points", {}).get("next_step", "Revisar caso"),
        },
        "tags": data.get("tags", []),
    }


def _analyze_mock(texts: list[str]) -> dict:
    merged = " ".join(texts).lower()
    tags = []
    for token, tag in NEGATIVE_HINTS.items():
        if token in merged:
            tags.append(tag)

    unique_tags = sorted(set(tags))[:5]
    negative_matches = sum(1 for token in NEGATIVE_HINTS if token in merged)
    positive_matches = sum(1 for token in POSITIVE_HINTS if token in merged)

    if negative_matches > positive_matches:
        sentiment = SentimentLabel.NEGATIVE
        score = max(1, 6 - negative_matches)
        objection = unique_tags[0] if unique_tags else "desconocido"
    elif positive_matches > 0:
        sentiment = SentimentLabel.POSITIVE
        score = min(10, 7 + positive_matches)
        objection = ""
    else:
        sentiment = SentimentLabel.NEUTRAL
        score = 5
        objection = ""

    common_words = Counter(w for w in merged.split() if len(w) > 4).most_common(2)
    bullets = [
        "Contexto sintetizado desde los ultimos mensajes.",
        "Tema principal: " + (common_words[0][0] if common_words else "general"),
        "Priorizar respuesta en esta conversacion.",
    ]

    return {
        "summary_bullets": bullets[:5],
        "sentiment_label": sentiment.value,
        "sentiment_score": score,
        "key_points": {
            "need": "Acompanamiento comercial o soporte.",
            "objection": objection,
            "urgency": "alta" if "urgente" in merged else "media",
            "next_step": "Responder con accion concreta y confirmar cierre.",
        },
        "tags": unique_tags,
    }
