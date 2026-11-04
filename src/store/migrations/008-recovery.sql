CREATE TABLE store_identity (id INTEGER PRIMARY KEY CHECK(id=1), database_id TEXT NOT NULL);
INSERT INTO store_identity VALUES(1,lower(hex(randomblob(16))));
ALTER TABLE daemon_lock ADD COLUMN epoch TEXT NOT NULL DEFAULT '';
CREATE TABLE boot_runs (
  epoch TEXT PRIMARY KEY, database_id TEXT NOT NULL, host_id TEXT NOT NULL,
  pid INTEGER NOT NULL, start_identity TEXT NOT NULL, phase TEXT NOT NULL,
  cutoff_seq INTEGER NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  error TEXT, report_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(report_json))
);
CREATE TABLE execution_owners (
  execution_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, runtime_id TEXT NOT NULL,
  generation_id TEXT, native_thread_id TEXT
);
ALTER TABLE provider_sessions ADD COLUMN generation_id TEXT NOT NULL DEFAULT '';
UPDATE provider_sessions SET generation_id=lower(hex(randomblob(16)));
ALTER TABLE turn_scratch ADD COLUMN checkpoint_seq INTEGER NOT NULL DEFAULT 0;
CREATE TABLE cleanup_journal (
  runtime_id TEXT PRIMARY KEY, owner_epoch TEXT, record_path TEXT NOT NULL,
  record_json TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE recoveries (
  execution_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), lane_key TEXT NOT NULL,
  old_epoch TEXT, recovered_epoch TEXT NOT NULL, delivery_ids_json TEXT NOT NULL,
  reason TEXT NOT NULL, recovered_at TEXT NOT NULL, checkpoint_at TEXT,
  runtime_id TEXT, generation_id TEXT
);
CREATE TABLE session_quarantines (
  generation_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), lane_key TEXT NOT NULL,
  provider TEXT NOT NULL, native_thread_id TEXT NOT NULL, execution_id TEXT NOT NULL REFERENCES recoveries(execution_id),
  reason TEXT NOT NULL, quarantined_at TEXT NOT NULL
);
CREATE TABLE recovery_usage (
  execution_id TEXT PRIMARY KEY REFERENCES recoveries(execution_id), agent_id TEXT NOT NULL REFERENCES agents(id),
  provider TEXT NOT NULL, model TEXT NOT NULL, lane_key TEXT NOT NULL, recorded_at TEXT NOT NULL,
  chains_json TEXT NOT NULL, deliveries_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('partial','missing')),
  usage_json TEXT, cost_json TEXT, price_id TEXT, resolution_json TEXT
);
