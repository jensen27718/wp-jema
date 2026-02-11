from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field

from .models import ConversationStatus, MessageSender, Outcome


class SeedRequest(BaseModel):
    agents: int = 6
    clients: int = 120
    conversations: int = 220
    min_messages: int = 6
    max_messages: int = 25
    run_ai_on_pct: float = 0.35


class ConversationPatchRequest(BaseModel):
    status: Optional[ConversationStatus] = None
    assigned_agent_id: Optional[UUID] = None
    outcome: Optional[Outcome] = None


class AddMessageRequest(BaseModel):
    sender: MessageSender
    text: str = Field(min_length=1)
    ts: Optional[datetime] = None
    provider: str = "mock"
    provider_message_id: Optional[str] = None


class AnalyzeRequest(BaseModel):
    force: bool = False
    mock: bool = False


class MockWebhookRequest(BaseModel):
    provider: str = "mock"
    wa_id: str
    message_id: str
    timestamp: str
    direction: str = "inbound"
    message_type: str = "text"
    text: str
    sender_role: str = "USER"
