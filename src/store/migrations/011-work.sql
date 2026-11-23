CREATE TABLE work_projects (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, description TEXT NOT NULL,
  stages_json TEXT NOT NULL CHECK(json_valid(stages_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE work_items (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES work_projects(id),
  number INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  stage_id TEXT NOT NULL, priority TEXT NOT NULL,
  assignee_id TEXT REFERENCES agents(id), due_date TEXT,
  labels_json TEXT NOT NULL CHECK(json_valid(labels_json)),
  criteria TEXT NOT NULL, max_turns INTEGER NOT NULL,
  task_id TEXT REFERENCES workspace_records(id), revision INTEGER NOT NULL,
  archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(project_id,number)
);
CREATE TABLE work_runs (
  task_id TEXT PRIMARY KEY REFERENCES workspace_records(id),
  item_id TEXT NOT NULL REFERENCES work_items(id), stage_id TEXT NOT NULL,
  settled_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE work_activity (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES work_items(id),
  kind TEXT NOT NULL, actor_id TEXT, body TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)), occurred_at TEXT NOT NULL
);
CREATE INDEX work_items_project_stage ON work_items(project_id,stage_id,updated_at);
CREATE INDEX work_activity_item ON work_activity(item_id,occurred_at,id);
CREATE INDEX work_runs_item ON work_runs(item_id,created_at);
