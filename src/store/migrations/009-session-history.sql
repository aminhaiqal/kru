CREATE TABLE history_state (id INTEGER PRIMARY KEY CHECK(id=1), initialized_seq INTEGER NOT NULL);
CREATE TABLE message_threads (
  message_id TEXT NOT NULL REFERENCES messages(id), thread_id TEXT NOT NULL REFERENCES threads(id),
  PRIMARY KEY(message_id,thread_id)
) WITHOUT ROWID;
CREATE TABLE history_versions (
  thread_id TEXT NOT NULL REFERENCES threads(id), source_id TEXT NOT NULL, version_seq INTEGER NOT NULL,
  execution_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL, timestamp TEXT NOT NULL,
  outcome TEXT NOT NULL, partial INTEGER NOT NULL, order_seq INTEGER NOT NULL, phase INTEGER NOT NULL,
  item_order INTEGER NOT NULL, source_ids_json TEXT NOT NULL, message_id TEXT, item_id TEXT, sender_kind TEXT,
  sender_agent_id TEXT, sender_routine_id TEXT, reply_to TEXT, chain_id TEXT, hop INTEGER,
  PRIMARY KEY(thread_id,source_id,version_seq)
) WITHOUT ROWID;
CREATE INDEX history_versions_snapshot ON history_versions(thread_id,version_seq);
CREATE TABLE history_gaps (
  thread_id TEXT NOT NULL REFERENCES threads(id), before_seq INTEGER NOT NULL,
  reason TEXT NOT NULL, recorded_at TEXT NOT NULL, recorded_seq INTEGER NOT NULL,
  PRIMARY KEY(thread_id,recorded_seq)
) WITHOUT ROWID;
CREATE TABLE session_generations (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), generation INTEGER NOT NULL CHECK(generation>0),
  provider TEXT NOT NULL, config_hash TEXT NOT NULL, runtime_scope_hash TEXT NOT NULL,
  reason TEXT NOT NULL, previous_id TEXT REFERENCES session_generations(id), status TEXT NOT NULL,
  handoff_id TEXT, created_at TEXT NOT NULL, retired_at TEXT, retired_reason TEXT,
  UNIQUE(thread_id,generation)
);
CREATE UNIQUE INDEX session_generations_active ON session_generations(thread_id) WHERE status='active';
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), generation_id TEXT NOT NULL REFERENCES session_generations(id),
  renderer_version INTEGER NOT NULL, snapshot_seq INTEGER NOT NULL, reason TEXT NOT NULL,
  included_json TEXT NOT NULL, omitted_json TEXT NOT NULL, packet TEXT NOT NULL, packet_hash TEXT NOT NULL,
  char_budget INTEGER NOT NULL, byte_budget INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE handoff_uses (
  execution_id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL REFERENCES handoffs(id),
  generation_id TEXT NOT NULL REFERENCES session_generations(id), confirmed_at TEXT NOT NULL
);
CREATE TABLE turn_generations (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id), generation_id TEXT NOT NULL REFERENCES session_generations(id)
);
ALTER TABLE provider_sessions ADD COLUMN runtime_scope_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE store_identity ADD COLUMN cursor_key TEXT NOT NULL DEFAULT '';
UPDATE store_identity SET cursor_key=lower(hex(randomblob(32)));
CREATE TABLE session_setup_attempts (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), agent_id TEXT NOT NULL,
  lane_key TEXT NOT NULL, provider TEXT NOT NULL, batch_id TEXT, owner_epoch TEXT,
  expected_id TEXT, expected_generation INTEGER NOT NULL, config_hash TEXT NOT NULL,
  runtime_scope_hash TEXT NOT NULL, runtime_token TEXT NOT NULL, config_json TEXT NOT NULL,
  reason TEXT NOT NULL, snapshot_seq INTEGER NOT NULL, packet_json TEXT NOT NULL,
  state TEXT NOT NULL, candidate_native_id TEXT, candidate_prompt_hash TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX session_setup_unresolved ON session_setup_attempts(thread_id)
  WHERE state IN ('creating','candidate','setup_unknown','cleanup_pending');
