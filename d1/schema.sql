-- Cloudflare D1 schema for WhatsApp Control Tower CRM (Pages Functions + Workers runtime)
--
-- Apply with (example):
--   wrangler d1 execute <DB_NAME> --file=./d1/schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  company TEXT,
  city TEXT NOT NULL DEFAULT 'Cucuta',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW',
  assigned_agent_id TEXT,
  outcome TEXT NOT NULL DEFAULT 'UNKNOWN',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  reopened_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT NOT NULL,
  first_user_message_at TEXT,
  first_agent_reply_at TEXT,
  last_agent_reply_at TEXT,
  summary_json TEXT,
  sentiment_label TEXT,
  sentiment_score INTEGER,
  tags_json TEXT,
  risk_flag INTEGER NOT NULL DEFAULT 0,
  risk_reasons_json TEXT,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_client_id ON conversations(client_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  ts TEXT NOT NULL,
  out_of_hours INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'mock',
  provider_message_id TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id_ts ON messages(conversation_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_provider_message_id ON messages(provider, provider_message_id);

