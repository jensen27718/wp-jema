from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlmodel import Session, select
from sqlalchemy import delete

from .insights import analyze_messages
from .models import (
    Agent,
    Client,
    Conversation,
    ConversationStatus,
    Message,
    MessageSender,
    Outcome,
    SentimentLabel,
)
from .schemas import SeedRequest

SLA_FIRST_REPLY_MINUTES = 10
SLA_OVERDUE_NEW_MINUTES = 15
SLA_OVERDUE_FOLLOW_UP_MINUTES = 60



NAMES_POOL = [
    "Camila Rojas",
    "Juan Pablo Arias",
    "Sara Mendez",
    "Andres Torres",
    "Valentina Suarez",
    "Mateo Pineda",
    "Laura Villamizar",
    "David Hernandez",
    "Natalia Guerra",
    "Santiago Pena",
]

COMPANIES_POOL = [
    "Ferreteria La 30",
    "Boutique Luna",
    "Restaurante El Patio",
    "Clinica Dental Sonrie",
    "Academia FitPro",
    "Tienda TechNova",
    "Inmobiliaria Norte",
    "Pasteleria Dulce Arte",
]

SCENARIOS = [
    ("Hola, cuanto vale?", "Te comparto opciones con descuento."),
    ("Llevo 2 dias esperando respuesta", "Disculpa, ya reviso tu caso."),
    ("Me interesa el plan", "Te comparto link de pago y activacion."),
    ("Lo pense mejor y no", "Entiendo, te ayudo a comparar opciones."),
    ("Volvio el problema", "Vamos a reabrir y priorizarlo hoy."),
]

NEGATIVE_FRAGMENTS = [
    "esta caro",
    "estoy molesto por la demora",
    "necesito solucion urgente",
    "si no responden cancelo",
]


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _is_out_of_hours(ts: datetime) -> bool:
    weekday = ts.weekday()
    hour = ts.hour
    if weekday == 6:
        return True
    if weekday == 5:
        return hour < 8 or hour >= 13
    return hour < 8 or hour >= 18


def _weighted_status() -> ConversationStatus:
    roll = random.random()
    if roll < 0.20:
        return ConversationStatus.NEW
    if roll < 0.35:
        return ConversationStatus.CONTACTED
    if roll < 0.50:
        return ConversationStatus.INTERESTED
    if roll < 0.65:
        return ConversationStatus.NEGOTIATION
    if roll < 0.75:
        return ConversationStatus.REENGAGEMENT
    if roll < 0.85:
        return ConversationStatus.SUPPORT
    return ConversationStatus.CLOSED


def _random_phone(seed: int) -> str:
    return f"57300{seed:06d}"


def _recalc_risk(conv: Conversation, now: datetime | None = None) -> None:
    now = now or _utcnow()
    reasons: list[str] = []

    if conv.first_user_message_at and not conv.first_agent_reply_at:
        age = (now - conv.first_user_message_at).total_seconds() / 60
        if age > SLA_OVERDUE_NEW_MINUTES:
            reasons.append("Sin primera respuesta")

    if conv.status in {
        ConversationStatus.CONTACTED,
        ConversationStatus.INTERESTED,
        ConversationStatus.NEGOTIATION,
        ConversationStatus.REENGAGEMENT,
        ConversationStatus.SUPPORT,
    } and conv.last_agent_reply_at:
        stale = (now - conv.last_agent_reply_at).total_seconds() / 60
        if stale > SLA_OVERDUE_FOLLOW_UP_MINUTES:
            reasons.append("Seguimiento congelado")

    if conv.sentiment_label == SentimentLabel.NEGATIVE:
        reasons.append("Sentimiento negativo")

    if conv.reopened_count > 0:
        reasons.append("Caso reabierto")

    conv.risk_reasons = reasons
    conv.risk_flag = bool(reasons)


def _priority_score(conv: Conversation) -> int:
    reasons = conv.risk_reasons or []
    score = 0
    if "Sin primera respuesta" in reasons or "Seguimiento congelado" in reasons:
        score += 40
    if conv.sentiment_label == SentimentLabel.NEGATIVE:
        score += 30
    if conv.reopened_count > 0:
        score += 20
    if conv.tags and "plan_pro" in conv.tags:
        score += 10
    return score


def seed_database(session: Session, payload: SeedRequest) -> dict[str, Any]:
    random.seed(42)
    now = _utcnow()

    session.exec(delete(Message))
    session.exec(delete(Conversation))
    session.exec(delete(Client))
    session.exec(delete(Agent))
    session.commit()

    agents: list[Agent] = []
    for idx in range(payload.agents):
        agent = Agent(name=f"Agente {idx + 1}")
        session.add(agent)
        agents.append(agent)
    session.commit()

    clients: list[Client] = []
    for idx in range(payload.clients):
        name = random.choice(NAMES_POOL)
        client = Client(
            name=name,
            phone=_random_phone(idx + 1),
            company=random.choice(COMPANIES_POOL),
            city=random.choice(["Bogota", "Medellin", "Cali", "Barranquilla", "Bucaramanga", "Cucuta"]),
            created_at=now - timedelta(days=random.randint(1, 60)),
        )
        session.add(client)
        clients.append(client)
    session.commit()

    analyzed_count = 0
    risk_count = 0
    msg_count = 0

    for _ in range(payload.conversations):
        client = random.choice(clients)
        created_at = now - timedelta(
            days=random.randint(0, 14),
            hours=random.randint(0, 23),
            minutes=random.randint(0, 59),
        )
        status = _weighted_status()
        assigned_agent = random.choice(agents) if random.random() < 0.88 else None
        reopened_count = 1 if random.random() < 0.10 else 0

        conv = Conversation(
            client_id=client.id,
            status=status,
            assigned_agent_id=assigned_agent.id if assigned_agent else None,
            outcome=Outcome.UNKNOWN,
            created_at=created_at,
            updated_at=created_at,
            last_message_at=created_at,
            reopened_count=reopened_count,
        )
        session.add(conv)
        session.commit()
        session.refresh(conv)

        intro_user, intro_agent = random.choice(SCENARIOS)
        message_total = random.randint(payload.min_messages, payload.max_messages)
        no_response = random.random() < 0.08
        slow_first = random.random() < 0.18
        should_be_negative = random.random() < 0.22

        ts = created_at
        for i in range(message_total):
            if i == 0:
                sender = MessageSender.USER
                text = intro_user
                ts = ts + timedelta(minutes=random.randint(1, 5))
            elif i == 1 and not no_response:
                sender = MessageSender.AGENT
                text = intro_agent
                first_reply_delay = random.randint(12, 35) if slow_first else random.randint(1, 9)
                ts = ts + timedelta(minutes=first_reply_delay)
            else:
                sender = random.choices(
                    population=[MessageSender.USER, MessageSender.AGENT, MessageSender.BOT],
                    weights=[0.45, 0.4, 0.15],
                    k=1,
                )[0]
                ts = ts + timedelta(minutes=random.randint(2, 35))
                if sender == MessageSender.USER and should_be_negative and random.random() < 0.5:
                    text = random.choice(NEGATIVE_FRAGMENTS)
                elif sender == MessageSender.USER:
                    text = random.choice(
                        [
                            "me puedes ampliar la info",
                            "que incluye el plan",
                            "podemos agendar demo",
                            "cuando quedaria activo",
                        ]
                    )
                elif sender == MessageSender.AGENT:
                    text = random.choice(
                        [
                            "te apoyo con eso ahora",
                            "ya escale el caso",
                            "te comparto propuesta final",
                            "confirma si cerramos hoy",
                        ]
                    )
                else:
                    text = random.choice(
                        [
                            "elige opcion 1 para ventas o 2 para soporte",
                            "gracias por escribir a TheTeta",
                            "estamos procesando tu solicitud",
                        ]
                    )

            message = Message(
                conversation_id=conv.id,
                sender=sender,
                text=text,
                ts=ts,
                out_of_hours=_is_out_of_hours(ts),
                provider="mock",
            )
            session.add(message)
            msg_count += 1

            conv.last_message_at = ts
            if sender == MessageSender.USER and not conv.first_user_message_at:
                conv.first_user_message_at = ts
            if sender == MessageSender.AGENT:
                if not conv.first_agent_reply_at:
                    conv.first_agent_reply_at = ts
                conv.last_agent_reply_at = ts

        if status == ConversationStatus.CLOSED:
            conv.closed_at = conv.last_message_at + timedelta(minutes=random.randint(5, 180))
            conv.outcome = Outcome.LOST if random.random() < 0.18 else Outcome.WON

        if should_be_negative:
            conv.sentiment_label = SentimentLabel.NEGATIVE
            conv.sentiment_score = random.randint(2, 4)
            conv.tags = random.choice(
                [
                    ["demora", "soporte"],
                    ["precio", "descuento"],
                    ["cancelacion"],
                ]
            )
        elif conv.outcome == Outcome.WON:
            conv.sentiment_label = SentimentLabel.POSITIVE
            conv.sentiment_score = random.randint(7, 9)
            conv.tags = ["plan_pro", "demo"]
        else:
            conv.sentiment_label = SentimentLabel.NEUTRAL
            conv.sentiment_score = 5
            conv.tags = ["seguimiento"]

        if random.random() < payload.run_ai_on_pct:
            texts = [
                row.text
                for row in session.exec(
                    select(Message).where(Message.conversation_id == conv.id).order_by(Message.ts)
                ).all()[-30:]
            ]
            conv.summary_json = analyze_messages(texts)
            analyzed_count += 1

        _recalc_risk(conv, now=now)
        if conv.risk_flag:
            risk_count += 1
        conv.updated_at = now
        session.add(conv)
        session.commit()

    return {
        "agents": payload.agents,
        "clients": payload.clients,
        "conversations": payload.conversations,
        "messages": msg_count,
        "at_risk": risk_count,
        "analyzed": analyzed_count,
    }


def compute_quality_score(overdue_rate: float, negative_rate: float, reopen_rate: float, frt_ratio: float) -> float:
    score = 100.0 - (40 * overdue_rate + 30 * negative_rate + 20 * reopen_rate + 10 * frt_ratio)
    return max(0.0, min(100.0, score))


def conversation_view(conv: Conversation, client: Client | None, agent: Agent | None) -> dict[str, Any]:
    return {
        "id": str(conv.id),
        "status": conv.status.value,
        "outcome": conv.outcome.value,
        "risk_flag": conv.risk_flag,
        "risk_reasons": conv.risk_reasons or [],
        "created_at": conv.created_at.isoformat(),
        "updated_at": conv.updated_at.isoformat(),
        "last_message_at": conv.last_message_at.isoformat(),
        "assigned_agent": {"id": str(agent.id), "name": agent.name} if agent else None,
        "client": {
            "id": str(client.id),
            "name": client.name,
            "phone": client.phone,
            "company": client.company,
            "city": client.city,
        }
        if client
        else None,
        "sentiment_label": conv.sentiment_label.value if conv.sentiment_label else None,
        "sentiment_score": conv.sentiment_score,
        "tags": conv.tags or [],
    }


def priority_for_conversation(conv: Conversation) -> int:
    return _priority_score(conv)


def recalc_risk(conv: Conversation, now: datetime | None = None) -> None:
    _recalc_risk(conv, now=now)
