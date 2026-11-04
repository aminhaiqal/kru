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
