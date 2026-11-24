CREATE TABLE conversation_settings (
 thread_id TEXT PRIMARY KEY REFERENCES threads(id), title TEXT NOT NULL,
 provider TEXT CHECK(provider IN ('codex','claude','fake')), model TEXT, effort TEXT, deleted_at TEXT,
 revision INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE conversation_media (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), name TEXT NOT NULL, mime TEXT NOT NULL,
 bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE conversation_message_media (
 message_id TEXT NOT NULL REFERENCES messages(id), media_id TEXT NOT NULL REFERENCES conversation_media(id),
 PRIMARY KEY(message_id,media_id)
);
CREATE INDEX conversation_media_thread ON conversation_media(thread_id,created_at);
