from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Iterable

import httpx

from .models import MessageSender

PHONE_CHARS = re.compile(r"\d+")


class WasenderError(RuntimeError):
    pass


@dataclass(frozen=True)
class ProviderMessage:
    wa_id: str
    text: str
    ts: datetime
    sender: MessageSender
    provider_message_id: str | None


def normalize_wa_id(value: Any) -> str:
    if value is None:
        return ""
    raw = str(value).strip()
    if not raw:
        return ""
    if "@" in raw:
        raw = raw.split("@", maxsplit=1)[0]
    digits = "".join(PHONE_CHARS.findall(raw))
    return digits or raw


def parse_provider_timestamp(value: Any) -> datetime:
    now = datetime.now(UTC).replace(tzinfo=None)
    if value is None:
        return now

    if isinstance(value, (int, float)):
        numeric = float(value)
        if numeric > 10_000_000_000:
            numeric = numeric / 1000.0
        return datetime.fromtimestamp(numeric, tz=UTC).replace(tzinfo=None)

    raw = str(value).strip()
    if not raw:
        return now
    if raw.isdigit():
        return parse_provider_timestamp(int(raw))

    normalized = raw.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return now
    if parsed.tzinfo is None:
        return parsed
    return parsed.astimezone(UTC).replace(tzinfo=None)


def _nested_get(data: dict[str, Any], path: str) -> Any:
    value: Any = data
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def _coerce_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    trimmed = value.strip()
    if not trimmed:
        return value
    if not (trimmed.startswith("{") or trimmed.startswith("[")):
        return value
    try:
        return json.loads(trimmed)
    except json.JSONDecodeError:
        return value


def _extract_text(value: Any) -> str | None:
    node = _coerce_json(value)
    if node is None:
        return None
    if isinstance(node, str):
        clean = node.strip()
        return clean or None
    if isinstance(node, list):
        for item in node:
            text = _extract_text(item)
            if text:
                return text
        return None
    if not isinstance(node, dict):
        return None

    direct_keys = ("text", "conversation", "body", "caption", "content")
    for key in direct_keys:
        text = _extract_text(node.get(key))
        if text:
            return text

    message = node.get("message")
    if message is not None:
        text = _extract_text(message)
        if text:
            return text

    extended = node.get("extendedTextMessage")
    if isinstance(extended, dict):
        text = _extract_text(extended.get("text"))
        if text:
            return text

    image = node.get("imageMessage")
    if isinstance(image, dict):
        text = _extract_text(image.get("caption"))
        if text:
            return text

    return None


def _bool_like(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        raw = value.strip().lower()
        if raw in {"1", "true", "yes", "on"}:
            return True
        if raw in {"0", "false", "no", "off"}:
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return None


def normalize_provider_message(
    payload: dict[str, Any],
    default_sender: MessageSender = MessageSender.AGENT,
) -> ProviderMessage | None:
    candidate = _coerce_json(payload)
    if not isinstance(candidate, dict):
        return None

    from_me_flag = _bool_like(
        candidate.get("fromMe")
        or candidate.get("from_me")
        or candidate.get("isOutgoing")
        or _nested_get(candidate, "key.fromMe")
    )
    direction = str(candidate.get("direction") or "").strip().lower()
    if from_me_flag is True or direction in {"outbound", "sent"}:
        sender = MessageSender.AGENT
    elif from_me_flag is False or direction in {"inbound", "received"}:
        sender = MessageSender.USER
    else:
        sender = default_sender

    wa_candidates: list[Any] = []
    if sender == MessageSender.AGENT:
        wa_candidates.extend(
            [
                candidate.get("to"),
                candidate.get("recipient"),
                _nested_get(candidate, "key.remoteJid"),
                candidate.get("jid"),
                candidate.get("wa_id"),
            ]
        )
    else:
        wa_candidates.extend(
            [
                candidate.get("from"),
                candidate.get("author"),
                _nested_get(candidate, "key.remoteJid"),
                _nested_get(candidate, "key.participant"),
                candidate.get("jid"),
                candidate.get("wa_id"),
            ]
        )

    wa_id = ""
    for item in wa_candidates:
        normalized = normalize_wa_id(item)
        if normalized:
            wa_id = normalized
            break
    if not wa_id:
        return None

    text = (
        _extract_text(candidate.get("text"))
        or _extract_text(candidate.get("message"))
        or _extract_text(candidate.get("body"))
        or _extract_text(candidate.get("content"))
        or _extract_text(candidate.get("data"))
        or _extract_text(candidate)
    )
    if not text:
        return None

    ts = parse_provider_timestamp(
        candidate.get("timestamp")
        or candidate.get("messageTimestamp")
        or candidate.get("created_at")
        or candidate.get("updated_at")
        or candidate.get("ts")
        or candidate.get("date")
    )

    provider_message_id = (
        candidate.get("message_id")
        or candidate.get("id")
        or _nested_get(candidate, "key.id")
        or _nested_get(candidate, "message.id")
    )
    provider_message_id = str(provider_message_id) if provider_message_id is not None else None

    return ProviderMessage(
        wa_id=wa_id,
        text=text.strip(),
        ts=ts,
        sender=sender,
        provider_message_id=provider_message_id,
    )


def _extract_data_rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []

    for key in ("data", "items", "results", "rows", "logs", "contacts"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
        if isinstance(value, dict):
            nested = _extract_data_rows(value)
            if nested:
                return nested

    return []


def _message_nodes(payload: Any, depth: int = 0) -> Iterable[dict[str, Any]]:
    if depth > 6:
        return
    if isinstance(payload, list):
        for item in payload:
            yield from _message_nodes(item, depth=depth + 1)
        return
    if not isinstance(payload, dict):
        return

    marker_keys = {
        "message",
        "text",
        "body",
        "fromMe",
        "from",
        "to",
        "key",
        "wa_id",
        "id",
        "jid",
        "conversationTimestamp",
    }
    if marker_keys.intersection(payload.keys()):
        yield payload

    for key in ("data", "payload", "messages", "message", "entry", "changes", "value"):
        nested = payload.get(key)
        if nested is None:
            continue
        yield from _message_nodes(nested, depth=depth + 1)


def extract_webhook_messages(payload: dict[str, Any]) -> list[ProviderMessage]:
    event = str(payload.get("event") or "").strip().lower()
    default_sender = MessageSender.USER if "received" in event or "inbound" in event else MessageSender.AGENT

    parsed: list[ProviderMessage] = []
    seen: set[str] = set()
    for node in _message_nodes(payload):
        message = normalize_provider_message(node, default_sender=default_sender)
        if not message:
            continue
        dedup_key = message.provider_message_id or f"{message.wa_id}|{message.sender.value}|{message.ts.isoformat()}|{message.text}"
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        parsed.append(message)

    parsed.sort(key=lambda item: item.ts)
    return parsed


def extract_webhook_chat_updates(payload: dict[str, Any]) -> list[tuple[str, datetime]]:
    event = str(payload.get("event") or "").strip().lower()
    if "chat" not in event:
        return []

    updates: list[tuple[str, datetime]] = []
    seen: set[str] = set()
    for node in _message_nodes(payload):
        wa_id = normalize_wa_id(
            node.get("id")
            or node.get("jid")
            or _nested_get(node, "key.remoteJid")
            or node.get("wa_id")
        )
        if not wa_id:
            continue
        ts = parse_provider_timestamp(
            node.get("conversationTimestamp")
            or node.get("timestamp")
            or node.get("created_at")
            or node.get("updated_at")
        )
        dedup_key = f"{wa_id}|{ts.isoformat()}"
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        updates.append((wa_id, ts))

    return updates


class WasenderClient:
    def __init__(self, base_url: str, api_key: str, timeout: float = 20.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key.strip()
        self.timeout = timeout

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> Any:
        if not self.api_key:
            raise WasenderError("WASENDER_API_KEY is not configured")

        url = f"{self.base_url}{path}"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
        }
        if json_body is not None:
            headers["Content-Type"] = "application/json"

        try:
            response = httpx.request(
                method=method,
                url=url,
                headers=headers,
                params=params,
                json=json_body,
                timeout=self.timeout,
            )
        except httpx.HTTPError as exc:
            raise WasenderError(f"Wasender request failed: {exc}") from exc

        if response.status_code >= 400:
            excerpt = response.text.strip()
            if len(excerpt) > 240:
                excerpt = excerpt[:240] + "..."
            raise WasenderError(f"Wasender error {response.status_code}: {excerpt}")

        if not response.content:
            return {}
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            return response.json()
        return {"raw": response.text}

    def fetch_message_logs(self, session_id: str, *, page: int, per_page: int) -> list[dict[str, Any]]:
        payload = self._request(
            "GET",
            f"/api/whatsapp-sessions/{session_id}/message-logs",
            params={"page": page, "per_page": per_page},
        )
        return _extract_data_rows(payload)

    def fetch_history_for_phone(
        self,
        *,
        session_id: str,
        phone: str,
        per_page: int = 100,
        max_pages: int = 3,
    ) -> list[ProviderMessage]:
        normalized_phone = normalize_wa_id(phone)
        if not normalized_phone:
            return []

        collected: list[ProviderMessage] = []
        seen: set[str] = set()
        for page in range(1, max_pages + 1):
            rows = self.fetch_message_logs(session_id, page=page, per_page=per_page)
            if not rows:
                break

            for row in rows:
                message = normalize_provider_message(row, default_sender=MessageSender.AGENT)
                if not message or message.wa_id != normalized_phone:
                    continue
                dedup_key = (
                    message.provider_message_id
                    or f"{message.wa_id}|{message.sender.value}|{message.ts.isoformat()}|{message.text}"
                )
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)
                collected.append(message)

            if len(rows) < per_page:
                break

        collected.sort(key=lambda item: item.ts)
        return collected

    def send_text_message(self, *, session_id: str, phone: str, text: str) -> dict[str, Any]:
        payload = self._request(
            "POST",
            f"/api/whatsapp-sessions/{session_id}/messages/text",
            json_body={"to": normalize_wa_id(phone), "text": text},
        )
        return payload if isinstance(payload, dict) else {"raw": str(payload)}
