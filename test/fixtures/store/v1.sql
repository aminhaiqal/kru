CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('user','agent','routine')),
  sender_agent_id TEXT REFERENCES agents(id),
  sender_routine_id TEXT,
  text TEXT NOT NULL,
  reply_to TEXT REFERENCES messages(id),
  expects_reply INTEGER NOT NULL DEFAULT 0 CHECK (expects_reply IN (0,1)),
  idempotency_key TEXT UNIQUE,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  CHECK ((sender_kind = 'agent' AND sender_agent_id IS NOT NULL AND sender_routine_id IS NULL)
    OR (sender_kind = 'routine' AND sender_routine_id IS NOT NULL AND sender_agent_id IS NULL)
    OR (sender_kind = 'user' AND sender_agent_id IS NULL AND sender_routine_id IS NULL)),
  CHECK ((idempotency_key IS NULL AND request_hash IS NULL)
    OR (idempotency_key IS NOT NULL AND request_hash IS NOT NULL))
);
CREATE TABLE deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL REFERENCES messages(id),
  recipient_id TEXT NOT NULL REFERENCES agents(id),
  lane_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','starting','running','completed','failed','interrupted','cancelled')),
  turn_id TEXT,
  error TEXT,
  retry_of TEXT REFERENCES deliveries(id),
  chain_id TEXT NOT NULL,
  hop INTEGER NOT NULL DEFAULT 0 CHECK (hop >= 0),
  updated_at TEXT NOT NULL
);
CREATE INDEX deliveries_queue ON deliveries (recipient_id, lane_id, status, seq);
CREATE INDEX deliveries_message ON deliveries (message_id, seq);
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
INSERT INTO schema_migrations VALUES (1, '2026-11-04T00:00:00.000Z');
INSERT INTO agents VALUES ('fixture-agent', 'fixture', 'fake', '{}', '2026-11-04T00:00:00.000Z');
INSERT INTO messages (id, sender_kind, text, created_at) VALUES ('fixture-message', 'user', 'retained work', '2026-11-04T00:00:00.000Z');
INSERT INTO deliveries (id, message_id, recipient_id, status, chain_id, updated_at)
VALUES ('fixture-delivery', 'fixture-message', 'fixture-agent', 'queued', 'fixture-chain', '2026-11-04T00:00:00.000Z');
