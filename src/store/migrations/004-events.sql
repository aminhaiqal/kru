CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL,
  type TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL
);
CREATE INDEX events_command ON events(command_id, seq);
CREATE TABLE command_receipts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  committed_at TEXT NOT NULL
);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
CREATE TRIGGER receipts_no_update BEFORE UPDATE ON command_receipts BEGIN SELECT RAISE(ABORT, 'Receipts are immutable'); END;
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON command_receipts BEGIN SELECT RAISE(ABORT, 'Receipts are immutable'); END;
CREATE TABLE prices (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
  input_usd REAL NOT NULL, cache_write_5m_usd REAL NOT NULL, cache_write_1h_usd REAL NOT NULL,
  cache_read_usd REAL NOT NULL, output_usd REAL NOT NULL,
  effective_from TEXT NOT NULL, source_url TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json))
);
CREATE INDEX prices_model_time ON prices(provider, model, effective_from);
CREATE TABLE turns (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), lane_key TEXT NOT NULL,
  provider TEXT NOT NULL, native_thread_id TEXT NOT NULL, native_turn_id TEXT,
  model TEXT NOT NULL, profile TEXT NOT NULL, prefix_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting','running','completed','failed','interrupted')),
  error TEXT, started_at TEXT NOT NULL, completed_at TEXT, duration_ms INTEGER,
  deliveries_json TEXT NOT NULL CHECK (json_valid(deliveries_json)),
  chains_json TEXT NOT NULL CHECK (json_valid(chains_json))
);
CREATE TABLE thread_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL REFERENCES turns(id), item_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id), lane_key TEXT NOT NULL,
  type TEXT NOT NULL, text TEXT, details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  completed_at TEXT NOT NULL, UNIQUE(turn_id, item_id)
);
CREATE INDEX thread_messages_lane ON thread_messages(agent_id, lane_key, seq);
CREATE TABLE turn_scratch (
  turn_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, lane_key TEXT NOT NULL,
  items_json TEXT NOT NULL CHECK (json_valid(items_json)), updated_at TEXT NOT NULL
);
ALTER TABLE usage_records ADD COLUMN lane_key TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_records ADD COLUMN price_id TEXT REFERENCES prices(id);
ALTER TABLE usage_records ADD COLUMN recorded_at TEXT;
ALTER TABLE usage_records ADD COLUMN input_total INTEGER;
ALTER TABLE usage_records ADD COLUMN cached_read INTEGER;
ALTER TABLE usage_records ADD COLUMN cache_write INTEGER;
ALTER TABLE usage_records ADD COLUMN cache_write_5m INTEGER;
ALTER TABLE usage_records ADD COLUMN cache_write_1h INTEGER;
ALTER TABLE usage_records ADD COLUMN output INTEGER;
ALTER TABLE usage_records ADD COLUMN cost_usd REAL;
ALTER TABLE usage_records ADD COLUMN estimated INTEGER NOT NULL DEFAULT 1;
CREATE INDEX usage_records_agent_recorded ON usage_records(agent_id, recorded_at);
