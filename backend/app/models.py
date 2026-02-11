from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import Column
from sqlalchemy.dialects.sqlite import JSON
from sqlmodel import Field, SQLModel


class ConversationStatus(str, Enum):
    NEW = "NEW"  # Nuevo Lead
    CONTACTED = "CONTACTED"  # Contactado
    INTERESTED = "INTERESTED"  # Interesado
    NEGOTIATION = "NEGOTIATION"  # En Negociacion
    CLOSED = "CLOSED"  # Cerrado
    SUPPORT = "SUPPORT"  # Soporte
    REENGAGEMENT = "REENGAGEMENT"  # Reenganche / Follow-up antigu


class MessageSender(str, Enum):
    USER = "USER"
    BOT = "BOT"
    AGENT = "AGENT"


class Outcome(str, Enum):
    UNKNOWN = "UNKNOWN"
    WON = "WON"
    LOST = "LOST"
    UNQUALIFIED = "UNQUALIFIED"


class SentimentLabel(str, Enum):
    POSITIVE = "POSITIVE"
    NEUTRAL = "NEUTRAL"
    NEGATIVE = "NEGATIVE"


class Agent(SQLModel, table=True):
    __tablename__ = "agents"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    name: str
    active: bool = True


class Client(SQLModel, table=True):
    __tablename__ = "clients"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    name: str
    phone: str = Field(unique=True, index=True)
    company: Optional[str] = None
    city: str = "Cucuta"
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Conversation(SQLModel, table=True):
    __tablename__ = "conversations"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    client_id: UUID = Field(index=True, foreign_key="clients.id")
    status: ConversationStatus = Field(default=ConversationStatus.NEW)
    assigned_agent_id: Optional[UUID] = Field(default=None, foreign_key="agents.id")
    outcome: Outcome = Field(default=Outcome.UNKNOWN)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    closed_at: Optional[datetime] = None
    reopened_count: int = 0
    last_message_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    first_user_message_at: Optional[datetime] = None
    first_agent_reply_at: Optional[datetime] = None
    last_agent_reply_at: Optional[datetime] = None
    summary_json: Optional[dict] = Field(default=None, sa_column=Column(JSON))
    sentiment_label: Optional[SentimentLabel] = None
    sentiment_score: Optional[int] = None
    tags: Optional[list[str]] = Field(default=None, sa_column=Column(JSON))
    risk_flag: bool = False
    risk_reasons: Optional[list[str]] = Field(default=None, sa_column=Column(JSON))


class Message(SQLModel, table=True):
    __tablename__ = "messages"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    conversation_id: UUID = Field(index=True, foreign_key="conversations.id")
    sender: MessageSender
    text: str
    ts: datetime = Field(default_factory=datetime.utcnow, index=True)
    out_of_hours: bool = False
    provider: str = "mock"
    provider_message_id: Optional[str] = None
