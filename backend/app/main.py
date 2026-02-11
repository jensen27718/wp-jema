from __future__ import annotations

import os
from collections import Counter
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from statistics import median
from typing import Any
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session, select

from .database import create_db_and_tables, engine, get_session
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
from .schemas import (
    AddMessageRequest,
    AnalyzeRequest,
    ConversationPatchRequest,
    MockWebhookRequest,
    SeedRequest,
)
from .services import (
    SLA_FIRST_REPLY_MINUTES,
    compute_quality_score,
    conversation_view,
    priority_for_conversation,
    recalc_risk,
    seed_database,
)


def _env_int(name: str, default: int, min_value: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(min_value, value)


def _env_float(name: str, default: float, min_value: float = 0.0, max_value: float = 1.0) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return max(min_value, min(max_value, value))


def _auto_seed_request_from_env() -> SeedRequest:
    min_messages = _env_int("AUTO_SEED_MIN_MESSAGES", 4)
    max_messages = _env_int("AUTO_SEED_MAX_MESSAGES", 10)
    if max_messages < min_messages:
        max_messages = min_messages
    return SeedRequest(
        agents=_env_int("AUTO_SEED_AGENTS", 4),
        clients=_env_int("AUTO_SEED_CLIENTS", 20),
        conversations=_env_int("AUTO_SEED_CONVERSATIONS", 25),
        min_messages=min_messages,
        max_messages=max_messages,
        run_ai_on_pct=_env_float("AUTO_SEED_RUN_AI_PCT", 0.1),
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    create_db_and_tables()
    auto_seed = os.getenv("AUTO_SEED_ON_STARTUP", "false").strip().lower() in {"1", "true", "yes"}
    if auto_seed:
        with Session(engine) as session:
            has_any_conversation = session.exec(select(Conversation.id).limit(1)).first()
            if not has_any_conversation:
                seed_database(session, _auto_seed_request_from_env())
    yield


app = FastAPI(
    title="WhatsApp Control Tower CRM API",
    version="0.1.0",
    description="Hackathon MVP API for dashboard, inbox, agents and WhatsApp simulator.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _to_naive_utc(ts: datetime) -> datetime:
    if ts.tzinfo is None:
        return ts
    return ts.astimezone(UTC).replace(tzinfo=None)


def _parse_timestamp(value: str | None) -> datetime:
    if not value:
        return _utcnow()
    normalized = value.replace("Z", "+00:00")
    try:
        return _to_naive_utc(datetime.fromisoformat(normalized))
    except ValueError:
        return _utcnow()


def _is_out_of_hours(ts: datetime) -> bool:
    weekday = ts.weekday()
    hour = ts.hour
    if weekday == 6:
        return True
    if weekday == 5:
        return hour < 8 or hour >= 13
    return hour < 8 or hour >= 18


def _minutes_between(earlier: datetime | None, later: datetime | None) -> int | None:
    if not earlier or not later:
        return None
    minutes = int((later - earlier).total_seconds() // 60)
    return max(0, minutes)


def _frt_minutes(conv: Conversation) -> int | None:
    return _minutes_between(conv.first_user_message_at, conv.first_agent_reply_at)


def _minutes_without_reply(conv: Conversation, now: datetime | None = None) -> int | None:
    now = now or _utcnow()
    anchor = conv.last_agent_reply_at or conv.first_user_message_at
    if not anchor:
        return None
    return max(0, int((now - anchor).total_seconds() // 60))


def _message_row(msg: Message) -> dict[str, Any]:
    return {
        "id": str(msg.id),
        "sender": msg.sender.value,
        "text": msg.text,
        "ts": msg.ts.isoformat(),
        "out_of_hours": msg.out_of_hours,
        "provider": msg.provider,
        "provider_message_id": msg.provider_message_id,
    }


def _refresh_risk_flags(session: Session, conversations: list[Conversation], now: datetime | None = None) -> None:
    now = now or _utcnow()
    changed = False
    for conv in conversations:
        before_flag = conv.risk_flag
        before_reasons = conv.risk_reasons or []
        recalc_risk(conv, now=now)
        if conv.risk_flag != before_flag or (conv.risk_reasons or []) != before_reasons:
            conv.updated_at = now
            session.add(conv)
            changed = True
    if changed:
        session.commit()


def _upsert_client_by_phone(session: Session, wa_id: str) -> Client:
    client = session.exec(select(Client).where(Client.phone == wa_id)).first()
    if client:
        return client

    suffix = wa_id[-4:] if len(wa_id) >= 4 else wa_id
    client = Client(
        name=f"Cliente {suffix}",
        phone=wa_id,
        company=None,
        city="Cucuta",
        created_at=_utcnow(),
    )
    session.add(client)
    session.commit()
    session.refresh(client)
    return client


def _find_open_conversation(session: Session, client_id: UUID) -> Conversation | None:
    statement = (
        select(Conversation)
        .where(Conversation.client_id == client_id, Conversation.status != ConversationStatus.CLOSED)
        .order_by(Conversation.last_message_at.desc())
    )
    return session.exec(statement).first()


def _create_conversation(session: Session, client_id: UUID, now: datetime | None = None) -> Conversation:
    now = now or _utcnow()
    conv = Conversation(
        client_id=client_id,
        status=ConversationStatus.NEW,
        outcome=Outcome.UNKNOWN,
        created_at=now,
        updated_at=now,
        last_message_at=now,
    )
    session.add(conv)
    session.commit()
    session.refresh(conv)
    return conv


def _apply_message_to_conversation(
    conv: Conversation,
    sender: MessageSender,
    message_ts: datetime,
) -> None:
    if sender == MessageSender.USER and conv.status == ConversationStatus.CLOSED:
        conv.status = ConversationStatus.FOLLOW_UP
        conv.closed_at = None
        conv.reopened_count += 1

    if sender == MessageSender.USER and not conv.first_user_message_at:
        conv.first_user_message_at = message_ts

    if sender == MessageSender.AGENT:
        if conv.first_user_message_at and not conv.first_agent_reply_at:
            conv.first_agent_reply_at = message_ts
        conv.last_agent_reply_at = message_ts

    conv.last_message_at = message_ts
    conv.updated_at = _utcnow()


def _append_message(
    session: Session,
    conv: Conversation,
    sender: MessageSender,
    text: str,
    ts: datetime,
    provider: str = "mock",
    provider_message_id: str | None = None,
) -> Message:
    message = Message(
        conversation_id=conv.id,
        sender=sender,
        text=text,
        ts=ts,
        out_of_hours=_is_out_of_hours(ts),
        provider=provider,
        provider_message_id=provider_message_id,
    )
    session.add(message)
    _apply_message_to_conversation(conv, sender=sender, message_ts=ts)
    recalc_risk(conv, now=_utcnow())
    session.add(conv)
    session.commit()
    session.refresh(message)
    session.refresh(conv)
    return message


def _conv_lookup_maps(session: Session) -> tuple[dict[UUID, Client], dict[UUID, Agent]]:
    clients = {row.id: row for row in session.exec(select(Client)).all()}
    agents = {row.id: row for row in session.exec(select(Agent)).all()}
    return clients, agents


def _at_risk_table(
    conversations: list[Conversation],
    clients_map: dict[UUID, Client],
    agents_map: dict[UUID, Agent],
) -> list[dict[str, Any]]:
    now = _utcnow()
    rows: list[dict[str, Any]] = []
    for conv in conversations:
        if not conv.risk_flag:
            continue
        client = clients_map.get(conv.client_id)
        agent = agents_map.get(conv.assigned_agent_id) if conv.assigned_agent_id else None
        reason = (conv.risk_reasons or [""])[0]
        rows.append(
            {
                "conversation_id": str(conv.id),
                "cliente": client.name if client else "N/A",
                "telefono": client.phone if client else "",
                "estado": conv.status.value,
                "agente": agent.name if agent else None,
                "min_sin_respuesta": _minutes_without_reply(conv, now=now),
                "sentimiento": conv.sentiment_label.value if conv.sentiment_label else "UNKNOWN",
                "motivo_tag": (conv.tags or [reason])[0] if conv.tags or reason else "",
                "accion": "abrir",
                "priority_score": priority_for_conversation(conv),
            }
        )
    rows.sort(key=lambda r: (r["priority_score"], r["min_sin_respuesta"] or 0), reverse=True)
    return rows[:25]


def _agent_ranking(conversations: list[Conversation], agents_map: dict[UUID, Agent]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for agent in agents_map.values():
        assigned = [c for c in conversations if c.assigned_agent_id == agent.id]
        replied = [c for c in assigned if _frt_minutes(c) is not None]
        frt_values = [_frt_minutes(c) for c in replied]
        frt_values = [v for v in frt_values if v is not None]
        frt_median = round(float(median(frt_values)), 2) if frt_values else None

        sla_hits = sum(1 for c in replied if (_frt_minutes(c) or 0) <= SLA_FIRST_REPLY_MINUTES)
        sla_compliance = round((sla_hits / len(replied) * 100), 2) if replied else 0.0

        backlog = sum(1 for c in assigned if c.status != ConversationStatus.CLOSED)
        analyzed = [c for c in assigned if c.sentiment_label is not None]
        negative = sum(1 for c in analyzed if c.sentiment_label == SentimentLabel.NEGATIVE)
        negative_rate = (negative / len(analyzed)) if analyzed else 0.0

        closed = [c for c in assigned if c.closed_at is not None or c.status == ConversationStatus.CLOSED]
        reopened = sum(1 for c in closed if c.reopened_count > 0)
        reopen_rate = (reopened / len(closed)) if closed else 0.0

        overdue = sum(
            1
            for c in assigned
            if any(reason in {"Sin primera respuesta", "Seguimiento congelado"} for reason in (c.risk_reasons or []))
        )
        overdue_rate = (overdue / len(assigned)) if assigned else 0.0
        frt_ratio = ((frt_median or SLA_FIRST_REPLY_MINUTES) / SLA_FIRST_REPLY_MINUTES) if assigned else 0.0
        quality_score = round(
            compute_quality_score(
                overdue_rate=overdue_rate,
                negative_rate=negative_rate,
                reopen_rate=reopen_rate,
                frt_ratio=frt_ratio,
            ),
            2,
        )

        rows.append(
            {
                "agent_id": str(agent.id),
                "agente": agent.name,
                "sla_compliance": sla_compliance,
                "frt_median": frt_median,
                "backlog_asignado": backlog,
                "negative_rate": round(negative_rate * 100, 2),
                "reopen_rate": round(reopen_rate * 100, 2),
                "quality_score": quality_score,
            }
        )

    rows.sort(key=lambda item: item["quality_score"])
    return rows


def _messages_by_hour(messages: list[Message]) -> list[dict[str, Any]]:
    counter = Counter(msg.ts.hour for msg in messages if msg.sender == MessageSender.USER)
    return [{"hour": hour, "count": counter.get(hour, 0)} for hour in range(24)]


def _summary_payload(session: Session) -> dict[str, Any]:
    now = _utcnow()
    conversations = session.exec(select(Conversation)).all()
    _refresh_risk_flags(session, conversations, now=now)

    clients_map, agents_map = _conv_lookup_maps(session)
    messages = session.exec(select(Message)).all()

    new_today = sum(1 for c in conversations if c.created_at.date() == now.date())
    yesterday = now.date().toordinal() - 1
    new_yesterday = sum(1 for c in conversations if c.created_at.date().toordinal() == yesterday)
    backlog = [c for c in conversations if c.status != ConversationStatus.CLOSED]
    at_risk = [c for c in conversations if c.risk_flag]
    frt_values = [_frt_minutes(c) for c in conversations]
    frt_values = [v for v in frt_values if v is not None]
    frt_median = round(float(median(frt_values)), 2) if frt_values else None

    replied = [c for c in conversations if _frt_minutes(c) is not None]
    sla_hits = sum(1 for c in replied if (_frt_minutes(c) or 0) <= SLA_FIRST_REPLY_MINUTES)
    sla_compliance = round((sla_hits / len(replied) * 100), 2) if replied else 0.0

    analyzed = [c for c in conversations if c.sentiment_label is not None]
    negative_count = sum(1 for c in analyzed if c.sentiment_label == SentimentLabel.NEGATIVE)
    negative_rate = round((negative_count / len(analyzed) * 100), 2) if analyzed else 0.0

    reason_counter: Counter[str] = Counter()
    for conv in at_risk:
        reason_counter.update(conv.risk_reasons or [])
    reason_split = [{"reason": reason, "count": count} for reason, count in reason_counter.most_common(5)]

    tag_counter: Counter[str] = Counter()
    for conv in conversations:
        if conv.sentiment_label == SentimentLabel.NEGATIVE or conv.outcome == Outcome.LOST:
            tag_counter.update(conv.tags or [])

    funnel_counts = {
        ConversationStatus.NEW.value: sum(1 for c in conversations if c.status == ConversationStatus.NEW),
        ConversationStatus.CONTACTED.value: sum(1 for c in conversations if c.status == ConversationStatus.CONTACTED),
        ConversationStatus.INTERESTED.value: sum(1 for c in conversations if c.status == ConversationStatus.INTERESTED),
        ConversationStatus.NEGOTIATION.value: sum(1 for c in conversations if c.status == ConversationStatus.NEGOTIATION),
        ConversationStatus.REENGAGEMENT.value: sum(1 for c in conversations if c.status == ConversationStatus.REENGAGEMENT),
        ConversationStatus.SUPPORT.value: sum(1 for c in conversations if c.status == ConversationStatus.SUPPORT),
        ConversationStatus.CLOSED.value: sum(1 for c in conversations if c.status == ConversationStatus.CLOSED),
    }
    backlog_breakdown = {
        status: count for status, count in funnel_counts.items() if status != ConversationStatus.CLOSED.value and count > 0
    }

    user_messages = [m for m in messages if m.sender == MessageSender.USER]
    out_of_hours_count = sum(1 for m in user_messages if m.out_of_hours)
    out_of_hours_rate = round((out_of_hours_count / len(user_messages) * 100), 2) if user_messages else 0.0

    top_cards = [
        {
            "kpi_id": "KPI_NEW_TODAY",
            "label": "Conversaciones nuevas (hoy)",
            "value": new_today,
            "delta_vs_yesterday": new_today - new_yesterday,
        },
        {
            "kpi_id": "KPI_BACKLOG_PENDING",
            "label": "Pendientes (Backlog)",
            "value": len(backlog),
            "breakdown_by_status": backlog_breakdown,
        },
        {
            "kpi_id": "KPI_AT_RISK",
            "label": "En riesgo",
            "value": len(at_risk),
            "reason_split": reason_split,
        },
        {
            "kpi_id": "KPI_FRT_MEDIAN",
            "label": "Primera respuesta (mediana)",
            "value_minutes": frt_median,
            "sla_minutes": SLA_FIRST_REPLY_MINUTES,
            "sla_badge": "OK" if frt_median is not None and frt_median <= SLA_FIRST_REPLY_MINUTES else "ALERTA",
        },
        {
            "kpi_id": "KPI_SLA_COMPLIANCE",
            "label": "% Cumplimiento SLA",
            "value_pct": sla_compliance,
        },
        {
            "kpi_id": "KPI_NEGATIVE_RATE",
            "label": "% Sentimiento negativo",
            "value_pct": negative_rate,
        },
    ]

    return {
        "top_cards": top_cards,
        "at_risk_table": _at_risk_table(conversations, clients_map, agents_map),
        "top_fail_tags": [{"tag": tag, "count": count} for tag, count in tag_counter.most_common(5)],
        "status_funnel": funnel_counts,
        "agent_ranking": _agent_ranking(conversations, agents_map),
        "out_of_hours_rate": out_of_hours_rate,
        "messages_by_hour": _messages_by_hour(messages),
    }


def _conversation_row(
    conv: Conversation,
    client: Client | None,
    agent: Agent | None,
    now: datetime | None = None,
) -> dict[str, Any]:
    row = conversation_view(conv, client=client, agent=agent)
    row["priority_score"] = priority_for_conversation(conv)
    row["minutes_since_last_agent_reply"] = _minutes_without_reply(conv, now=now)
    return row


def _conversation_metrics(messages: list[Message], conv: Conversation) -> dict[str, Any]:
    sorted_messages = sorted(messages, key=lambda item: item.ts)
    response_times: list[int] = []
    waiting_user_ts: datetime | None = None

    for msg in sorted_messages:
        if msg.sender == MessageSender.USER:
            waiting_user_ts = msg.ts
        elif msg.sender == MessageSender.AGENT and waiting_user_ts:
            delta = int((msg.ts - waiting_user_ts).total_seconds() // 60)
            response_times.append(max(0, delta))
            waiting_user_ts = None

    art_avg = round(sum(response_times) / len(response_times), 2) if response_times else None
    time_to_resolution = _minutes_between(conv.created_at, conv.closed_at)

    return {
        "frt_minutes": _frt_minutes(conv),
        "art_avg_minutes": art_avg,
        "time_to_resolution_minutes": time_to_resolution,
        "priority_score": priority_for_conversation(conv),
    }


@app.get("/", include_in_schema=False)
def root():
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"name": "WhatsApp Control Tower CRM API", "docs": "/docs"}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/seed")
def seed(payload: SeedRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    stats = seed_database(session, payload)
    return {"ok": True, "stats": stats}


@app.get("/dashboard/summary")
def dashboard_summary(session: Session = Depends(get_session)) -> dict[str, Any]:
    return _summary_payload(session)


@app.get("/conversations")
def list_conversations(
    status: ConversationStatus | None = None,
    assigned_agent_id: UUID | None = None,
    risk_flag: bool | None = None,
    q: str | None = Query(default=None, min_length=1),
    session: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    now = _utcnow()
    conversations = session.exec(select(Conversation).order_by(Conversation.last_message_at.desc())).all()
    _refresh_risk_flags(session, conversations, now=now)
    clients_map, agents_map = _conv_lookup_maps(session)

    q_lower = q.strip().lower() if q else None
    rows: list[dict[str, Any]] = []
    for conv in conversations:
        if status and conv.status != status:
            continue
        if assigned_agent_id and conv.assigned_agent_id != assigned_agent_id:
            continue
        if risk_flag is not None and conv.risk_flag != risk_flag:
            continue

        client = clients_map.get(conv.client_id)
        agent = agents_map.get(conv.assigned_agent_id) if conv.assigned_agent_id else None

        if q_lower:
            searchable = " ".join(
                filter(
                    None,
                    [
                        client.name if client else "",
                        client.phone if client else "",
                        client.company if client else "",
                        conv.id.hex,
                    ],
                )
            ).lower()
            if q_lower not in searchable:
                continue

        rows.append(_conversation_row(conv, client=client, agent=agent, now=now))
    return rows


@app.get("/conversations/{conversation_id}")
def get_conversation_detail(
    conversation_id: UUID,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    conv = session.get(Conversation, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    recalc_risk(conv, now=_utcnow())
    session.add(conv)
    session.commit()
    session.refresh(conv)

    client = session.get(Client, conv.client_id)
    agent = session.get(Agent, conv.assigned_agent_id) if conv.assigned_agent_id else None
    messages = session.exec(
        select(Message).where(Message.conversation_id == conv.id).order_by(Message.ts.asc())
    ).all()

    return {
        "conversation": _conversation_row(conv, client=client, agent=agent),
        "messages": [_message_row(message) for message in messages],
        "metrics": _conversation_metrics(messages, conv),
        "insights": conv.summary_json,
    }


@app.patch("/conversations/{conversation_id}")
def patch_conversation(
    conversation_id: UUID,
    payload: ConversationPatchRequest,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    conv = session.get(Conversation, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    if payload.assigned_agent_id is not None:
        agent = session.get(Agent, payload.assigned_agent_id)
        if not agent:
            raise HTTPException(status_code=404, detail="Assigned agent not found")
        conv.assigned_agent_id = payload.assigned_agent_id

    if payload.status is not None and payload.status != conv.status:
        if conv.status == ConversationStatus.CLOSED and payload.status != ConversationStatus.CLOSED:
            conv.reopened_count += 1
            conv.closed_at = None
        if payload.status == ConversationStatus.CLOSED and conv.closed_at is None:
            conv.closed_at = _utcnow()
        conv.status = payload.status

    if payload.outcome is not None:
        conv.outcome = payload.outcome

    conv.updated_at = _utcnow()
    recalc_risk(conv, now=conv.updated_at)
    session.add(conv)
    session.commit()
    session.refresh(conv)

    client = session.get(Client, conv.client_id)
    agent = session.get(Agent, conv.assigned_agent_id) if conv.assigned_agent_id else None

    return {"ok": True, "conversation": _conversation_row(conv, client=client, agent=agent)}


@app.post("/conversations/{conversation_id}/messages")
def add_message(
    conversation_id: UUID,
    payload: AddMessageRequest,
    session: Session = Depends(get_session),
) -> dict[str, str]:
    conv = session.get(Conversation, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    clean_text = payload.text.strip()
    if not clean_text:
        raise HTTPException(status_code=400, detail="Message text cannot be empty")

    ts = _to_naive_utc(payload.ts) if payload.ts else _utcnow()
    message = _append_message(
        session=session,
        conv=conv,
        sender=payload.sender,
        text=clean_text,
        ts=ts,
        provider=payload.provider,
        provider_message_id=payload.provider_message_id,
    )
    return {"conversation_id": str(conv.id), "message_id": str(message.id)}


@app.post("/webhook/mock")
def webhook_mock(payload: MockWebhookRequest, session: Session = Depends(get_session)) -> dict[str, str]:
    sender_role = payload.sender_role.upper().strip()
    try:
        sender = MessageSender[sender_role]
    except KeyError as exc:
        raise HTTPException(status_code=400, detail="sender_role must be USER, BOT or AGENT") from exc

    client = _upsert_client_by_phone(session, payload.wa_id)
    conv = _find_open_conversation(session, client.id) or _create_conversation(session, client.id)
    ts = _parse_timestamp(payload.timestamp)
    clean_text = payload.text.strip()
    if not clean_text:
        raise HTTPException(status_code=400, detail="Message text cannot be empty")

    message = _append_message(
        session=session,
        conv=conv,
        sender=sender,
        text=clean_text,
        ts=ts,
        provider=payload.provider,
        provider_message_id=payload.message_id,
    )

    return {"conversation_id": str(conv.id), "message_id": str(message.id)}


@app.post("/conversations/{conversation_id}/analyze")
def analyze_conversation(
    conversation_id: UUID,
    payload: AnalyzeRequest,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    conv = session.get(Conversation, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    if conv.summary_json and not payload.force:
        return conv.summary_json

    messages = session.exec(
        select(Message).where(Message.conversation_id == conv.id).order_by(Message.ts.asc())
    ).all()
    if not messages:
        raise HTTPException(status_code=400, detail="Conversation has no messages")

    texts = [row.text for row in messages][-30:]
    analysis = analyze_messages(texts)

    conv.summary_json = analysis
    raw_sentiment = str(analysis.get("sentiment_label", "")).upper()
    conv.tags = [str(tag) for tag in analysis.get("tags", [])][:5]
    try:
        conv.sentiment_score = int(analysis.get("sentiment_score", 5))
    except (TypeError, ValueError):
        conv.sentiment_score = 5
    try:
        conv.sentiment_label = SentimentLabel(raw_sentiment)
    except ValueError:
        conv.sentiment_label = SentimentLabel.NEUTRAL

    conv.updated_at = _utcnow()
    recalc_risk(conv, now=conv.updated_at)
    session.add(conv)
    session.commit()

    return analysis
