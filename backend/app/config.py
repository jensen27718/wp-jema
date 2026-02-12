from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


def _load_dotenv_files() -> None:
    root_dir = Path(__file__).resolve().parents[2]
    load_dotenv(root_dir / ".env")
    load_dotenv(root_dir / "backend" / ".env")


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _as_int(value: str | None, default: int, min_value: int = 1) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return max(min_value, parsed)


def _as_csv(value: str | None, default: list[str]) -> list[str]:
    if not value:
        return default
    entries = [item.strip() for item in value.split(",")]
    return [item for item in entries if item]


@dataclass(frozen=True)
class Settings:
    app_env: str
    cors_allowed_origins: list[str]
    allow_demo_routes: bool
    auth_username: str
    auth_password: str
    auth_password_hash: str | None
    jwt_secret_key: str
    access_token_expire_minutes: int
    deepseek_api_key: str | None
    deepseek_base_url: str
    wasender_base_url: str
    wasender_api_key: str | None
    wasender_session_id: str | None
    wasender_webhook_token: str | None
    wasender_sync_enabled: bool
    wasender_sync_page_size: int
    wasender_sync_max_pages: int
    wasender_push_outbound: bool


def _build_settings() -> Settings:
    _load_dotenv_files()
    return Settings(
        app_env=os.getenv("APP_ENV", "development").strip().lower(),
        cors_allowed_origins=_as_csv(
            os.getenv("CORS_ALLOWED_ORIGINS"),
            ["http://localhost:8000", "http://127.0.0.1:8000"],
        ),
        allow_demo_routes=_as_bool(os.getenv("ALLOW_DEMO_ROUTES"), default=False),
        auth_username=os.getenv("APP_AUTH_USERNAME", "admin"),
        auth_password=os.getenv("APP_AUTH_PASSWORD", "change-me-now"),
        auth_password_hash=os.getenv("APP_AUTH_PASSWORD_HASH"),
        jwt_secret_key=os.getenv("JWT_SECRET_KEY", "replace-this-secret"),
        access_token_expire_minutes=_as_int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES"), 480),
        deepseek_api_key=os.getenv("DEEPSEEK_API_KEY"),
        deepseek_base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        wasender_base_url=os.getenv("WASENDER_BASE_URL", "https://www.wasenderapi.com"),
        wasender_api_key=os.getenv("WASENDER_API_KEY"),
        wasender_session_id=os.getenv("WASENDER_SESSION_ID"),
        wasender_webhook_token=os.getenv("WASENDER_WEBHOOK_TOKEN"),
        wasender_sync_enabled=_as_bool(os.getenv("WASENDER_SYNC_ENABLED"), default=True),
        wasender_sync_page_size=_as_int(os.getenv("WASENDER_SYNC_PAGE_SIZE"), 100),
        wasender_sync_max_pages=_as_int(os.getenv("WASENDER_SYNC_MAX_PAGES"), 3),
        wasender_push_outbound=_as_bool(os.getenv("WASENDER_PUSH_OUTBOUND"), default=True),
    )


settings = _build_settings()


def validate_runtime_security() -> None:
    if settings.app_env == "production":
        if settings.auth_password == "change-me-now" and not settings.auth_password_hash:
            raise RuntimeError("APP_AUTH_PASSWORD must be changed in production")
        if settings.jwt_secret_key == "replace-this-secret":
            raise RuntimeError("JWT_SECRET_KEY must be configured in production")
