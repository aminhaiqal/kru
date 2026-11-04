CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  lane_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, lane_key)
);
CREATE TABLE turn_threads (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id),
  thread_id TEXT NOT NULL REFERENCES threads(id)
);
CREATE INDEX turn_threads_thread ON turn_threads(thread_id, turn_id);
ALTER TABLE agent_sessions RENAME TO provider_sessions;
ALTER TABLE provider_sessions ADD COLUMN thread_id TEXT REFERENCES threads(id);
ALTER TABLE provider_sessions ADD COLUMN active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1));
ALTER TABLE provider_sessions ADD COLUMN handoff_pending INTEGER NOT NULL DEFAULT 0 CHECK (handoff_pending IN (0,1));
CREATE UNIQUE INDEX provider_sessions_active ON provider_sessions(thread_id) WHERE active = 1;
