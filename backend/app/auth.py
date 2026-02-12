from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel

from .config import settings

PBKDF2_PREFIX = "pbkdf2_sha256"
DEFAULT_PBKDF2_ITERATIONS = 390000

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in_seconds: int


class AuthUser(BaseModel):
    username: str


def build_password_hash(password: str, iterations: int = DEFAULT_PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations)
    digest = base64.b64encode(dk).decode("ascii")
    return f"{PBKDF2_PREFIX}${iterations}${salt}${digest}"


def _verify_pbkdf2(password: str, encoded_hash: str) -> bool:
    try:
        _, iterations_raw, salt, digest = encoded_hash.split("$", maxsplit=3)
        iterations = int(iterations_raw)
    except ValueError:
        return False

    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations)
    candidate = base64.b64encode(dk).decode("ascii")
    return hmac.compare_digest(candidate, digest)


def verify_password(password: str) -> bool:
    configured_hash = settings.auth_password_hash
    if configured_hash:
        if not configured_hash.startswith(f"{PBKDF2_PREFIX}$"):
            return False
        return _verify_pbkdf2(password, configured_hash)

    return hmac.compare_digest(password, settings.auth_password)


def authenticate_user(username: str, password: str) -> bool:
    username_ok = hmac.compare_digest(username, settings.auth_username)
    if not username_ok:
        return False
    return verify_password(password)


def create_access_token(subject: str) -> TokenResponse:
    expires_delta = timedelta(minutes=settings.access_token_expire_minutes)
    now = datetime.now(UTC)
    exp = now + expires_delta
    payload: dict[str, Any] = {
        "sub": subject,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "scope": "api",
    }
    token = jwt.encode(payload, settings.jwt_secret_key, algorithm="HS256")
    return TokenResponse(
        access_token=token,
        expires_in_seconds=int(expires_delta.total_seconds()),
    )


def require_auth(token: str = Depends(oauth2_scheme)) -> AuthUser:
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=["HS256"])
    except jwt.InvalidTokenError as exc:
        raise credentials_error from exc

    username = payload.get("sub")
    if not isinstance(username, str) or not username:
        raise credentials_error

    if not hmac.compare_digest(username, settings.auth_username):
        raise credentials_error

    return AuthUser(username=username)
