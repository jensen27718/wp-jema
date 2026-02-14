# Cloudflare Pages + Workers (Pages Functions)

This repo now supports deploying the frontend to **Cloudflare Pages** and the backend API/webhooks as **Pages Functions** (Workers runtime) with **D1** as the database.

## Deploy (Pages)

1. Create a Cloudflare Pages project connected to this GitHub repo.
2. Build settings:
   - Build command: none
   - Output directory: `frontend`
3. Create a D1 database and bind it to the Pages project as:
   - Binding name: `DB`
4. Apply the D1 schema:
   - Use `./d1/schema.sql` in the D1 console or with Wrangler.

## Required Env Vars (Pages project)

Auth/JWT:
- `APP_AUTH_USERNAME`
- `APP_AUTH_PASSWORD` (or `APP_AUTH_PASSWORD_HASH`)
- `JWT_SECRET_KEY`
- `ACCESS_TOKEN_EXPIRE_MINUTES` (optional, default `480`)

Wasender:
- `WASENDER_WEBHOOK_TOKEN` (required for webhook)
- `WASENDER_BASE_URL` (optional, default `https://www.wasenderapi.com`)
- `WASENDER_API_KEY` (required only if you want to send outbound messages)
- `WASENDER_SESSION_ID` (required only if you want to send outbound messages)
- `WASENDER_PUSH_OUTBOUND` (optional, default `true`)

AI (optional):
- `DEEPSEEK_API_KEY`
- `DEEPSEEK_BASE_URL` (optional, default `https://api.deepseek.com`)

## Endpoints

- Health: `GET /health`
- Login: `POST /auth/login`
- Summary: `GET /dashboard/summary`
- Recent clients: `GET /conversations/recent-clients?limit=10&q=...`
- Conversation detail / patch: `GET|PATCH /conversations/:conversation_id`
- Send message: `POST /conversations/:conversation_id/messages`
- Analyze: `POST /conversations/:conversation_id/analyze`
- Wasender webhook: `POST /webhook/wasender` (send `X-Webhook-Token` header or `?token=...`)

