CREATE TABLE workspace_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('task','routine','connector','approval','memory','skill')),
  agent_id TEXT REFERENCES agents(id),
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX workspace_kind_agent ON workspace_records(kind,agent_id,created_at);
