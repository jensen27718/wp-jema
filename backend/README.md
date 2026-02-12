# Backend CRM WhatsApp (FastAPI)

Backend para operar con datos reales de WhatsApp por `wasenderapi.com` (no demo por defecto).

## Requisitos

- Python 3.11+
- Dependencias en `requirements.txt`

## Configuracion de entorno

1. Copia `.env.example` a `.env`.
2. Configura como minimo:

- `APP_AUTH_USERNAME`
- `APP_AUTH_PASSWORD` (o `APP_AUTH_PASSWORD_HASH`)
- `JWT_SECRET_KEY`
- `WASENDER_API_KEY`
- `WASENDER_SESSION_ID`
- `WASENDER_WEBHOOK_TOKEN`

## Ejecutar local

```bash
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

UI: `http://localhost:8000/`  
Docs: `http://localhost:8000/docs`

## Flujo implementado

- Login con JWT (`POST /auth/login`).
- Primera carga de inbox: `GET /conversations/recent-clients?limit=10` (solo numeros/clientes).
- Al abrir una conversacion (`GET /conversations/{id}`), se sincroniza historial disponible desde Wasender (message logs) y se persiste en BD.
- Nuevos mensajes entrantes por webhook: `POST /webhook/wasender` (token requerido).
- Mensajes salientes desde la plataforma: `POST /conversations/{id}/messages` (envio real a Wasender + registro local).

## Seguridad

- Endpoints de negocio protegidos con Bearer token.
- CORS restringido por `CORS_ALLOWED_ORIGINS`.
- Webhook protegido por `X-Webhook-Token` o query `?token=...`.
- Rutas demo (`/seed`, `/webhook/mock`) deshabilitadas por defecto (`ALLOW_DEMO_ROUTES=false`).

Para usar hash de password en lugar de texto plano:

```bash
cd backend
python scripts/generate_password_hash.py
```

Luego pega el valor en `APP_AUTH_PASSWORD_HASH` y deja vacio `APP_AUTH_PASSWORD`.

## Endpoints principales

- `POST /auth/login`
- `GET /dashboard/summary`
- `GET /conversations/recent-clients`
- `GET /conversations`
- `GET /conversations/{id}`
- `PATCH /conversations/{id}`
- `POST /conversations/{id}/messages`
- `POST /conversations/{id}/analyze`
- `POST /webhook/wasender`
- `GET /health`
