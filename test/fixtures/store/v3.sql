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
CREATE TABLE active_lanes (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  lane_key TEXT NOT NULL,
  batch_id TEXT NOT NULL UNIQUE,
  turn_id TEXT,
  started_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, lane_key)
) WITHOUT ROWID;
CREATE TABLE agent_sessions (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  lane_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  native_thread_id TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, lane_key, provider)
) WITHOUT ROWID;
CREATE TABLE daemon_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  start_identity TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  status_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(status_json))
);
ALTER TABLE deliveries ADD COLUMN batch_id TEXT;
CREATE INDEX deliveries_batch ON deliveries(batch_id);
INSERT INTO schema_migrations VALUES (2, '2026-11-04T00:00:00.000Z');
INSERT INTO agent_sessions (agent_id, lane_key, provider, native_thread_id, prompt_hash, config_hash, updated_at)
VALUES ('fixture-agent', '', 'fake', 'fixture-native-thread', 'fixture-prefix', 'fixture-config', '2026-11-04T00:00:00.000Z');
CREATE TABLE usage_records (
  batch_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thread_id TEXT,
  turn_id TEXT,
  cause TEXT NOT NULL CHECK (cause IN ('user','agent','routine')),
  deliveries_json TEXT NOT NULL CHECK (json_valid(deliveries_json)),
  chains_json TEXT NOT NULL CHECK (json_valid(chains_json)),
  phase TEXT NOT NULL CHECK (phase IN ('prepared','submitted','final')),
  outcome TEXT,
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  cost_json TEXT CHECK (cost_json IS NULL OR json_valid(cost_json)),
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1)),
  resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, thread_id, turn_id)
);
CREATE INDEX usage_records_agent_day ON usage_records(agent_id, started_at);
INSERT INTO schema_migrations VALUES (3, '2026-11-04T00:00:00.000Z');
INSERT INTO messages (id, sender_kind, text, created_at) VALUES ('fixture-completed-message', 'user', 'completed work', '2026-11-04T00:00:00.000Z');
INSERT INTO deliveries (id, message_id, recipient_id, status, turn_id, chain_id, updated_at, batch_id)
VALUES ('fixture-completed-delivery', 'fixture-completed-message', 'fixture-agent', 'completed', 'fixture-turn', 'fixture-completed-chain', '2026-11-04T00:00:00.000Z', 'fixture-batch');
INSERT INTO usage_records (batch_id, agent_id, provider, model, thread_id, turn_id, cause, deliveries_json, chains_json, phase,
  outcome, usage_json, cost_json, complete, started_at, updated_at)
VALUES ('fixture-batch', 'fixture-agent', 'claude', 'claude-sonnet-4-6', 'fixture-native-thread', 'fixture-turn', 'user',
  '["fixture-completed-delivery"]', '["fixture-completed-chain"]', 'final', 'completed',
  '{"last":{"inputTotal":3,"cachedRead":0,"cacheWrite":0,"output":1,"totalTokens":4},"total":{"inputTotal":3,"cachedRead":0,"cacheWrite":0,"output":1,"totalTokens":4}}',
  '{"model":"claude-sonnet-4-6","minimumNanoUsd":24000,"maximumNanoUsd":24000,"unknownCacheWriteTokens":0,"estimated":true,"scope":"main-agent-token-usage","price":{"model":"claude-sonnet-4-6","input":3,"cacheWrite5m":3.75,"cacheWrite1h":6,"cacheRead":0.3,"output":15,"source":"https://platform.claude.com/docs/en/about-claude/pricing","verifiedAt":"2026-11-04","currency":"USD","unit":"million-tokens"}}',
  1, '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
