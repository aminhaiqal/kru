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
