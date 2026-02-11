# Backend MVP

API FastAPI para el MVP "WhatsApp Control Tower CRM".

## Requisitos

- Python 3.11+ (probado en 3.13)
- Dependencias en `requirements.txt`

## Ejecutar local

```bash
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

La UI estatica se sirve en `http://localhost:8000/`.
La documentacion interactiva esta en `http://localhost:8000/docs`.

## Endpoints implementados

- `POST /seed`
- `GET /dashboard/summary`
- `GET /conversations`
- `GET /conversations/{id}`
- `PATCH /conversations/{id}`
- `POST /conversations/{id}/messages`
- `POST /conversations/{id}/analyze`
- `POST /webhook/mock`
- `GET /health`

## Variables de entorno

- `DATABASE_URL` (default: `sqlite:///./control_tower.db`)
- `AUTO_SEED_ON_STARTUP` (`true/false`)

Si `AUTO_SEED_ON_STARTUP=true` y la base esta vacia, se genera dataset demo.

Variables opcionales para ese auto-seed:

- `AUTO_SEED_AGENTS`
- `AUTO_SEED_CLIENTS`
- `AUTO_SEED_CONVERSATIONS`
- `AUTO_SEED_MIN_MESSAGES`
- `AUTO_SEED_MAX_MESSAGES`
- `AUTO_SEED_RUN_AI_PCT`

En Render Free conviene usar volumen moderado (ej: 20 clientes, 25 conversaciones) y luego ejecutar `/seed` para dataset grande cuando ya este arriba.

## Deploy en Render Free

Este repo incluye `render.yaml` en la raiz.

Pasos:

1. Sube el repo a GitHub.
2. En Render: `New +` -> `Blueprint`.
3. Conecta el repo y rama.
4. Render detecta `render.yaml` y crea el servicio.
5. Espera deploy y abre la URL publica.

Configuracion del servicio:

- `rootDir`: `backend`
- `buildCommand`: `pip install -r requirements.txt`
- `startCommand`: `python -m uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- `healthCheckPath`: `/health`

Nota: en Free el filesystem es efimero. Si se reinicia, SQLite puede resetearse. El auto-seed evita una demo vacia.
