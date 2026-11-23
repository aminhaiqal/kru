CREATE TABLE workflow_definitions (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), name TEXT NOT NULL, description TEXT NOT NULL,
 graph_json TEXT NOT NULL CHECK(json_valid(graph_json)), active INTEGER NOT NULL, interval_minutes INTEGER,
 next_run_at TEXT, legacy_skill_id TEXT UNIQUE, revision INTEGER NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE workflow_runs (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id), agent_id TEXT NOT NULL REFERENCES agents(id),
 name TEXT NOT NULL, graph_json TEXT NOT NULL CHECK(json_valid(graph_json)), input_json TEXT NOT NULL CHECK(json_valid(input_json)),
 status TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE workflow_node_runs (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), node_id TEXT NOT NULL, status TEXT NOT NULL,
 input_json TEXT NOT NULL CHECK(json_valid(input_json)), output_json TEXT NOT NULL CHECK(json_valid(output_json)),
 binding_json TEXT, error TEXT, task_id TEXT REFERENCES workspace_records(id), approval_id TEXT REFERENCES workspace_records(id),
 started_at TEXT, ended_at TEXT, UNIQUE(run_id,node_id)
);
CREATE INDEX workflow_runs_status ON workflow_runs(status,started_at);
CREATE INDEX workflow_nodes_run ON workflow_node_runs(run_id,node_id);
CREATE INDEX workflow_nodes_task ON workflow_node_runs(task_id);
