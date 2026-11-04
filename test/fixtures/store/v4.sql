-- Frozen v4: migrated v3 mailbox and usage, with genesis events and immutable prices.
BEGIN TRANSACTION;
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
INSERT INTO "agent_sessions" VALUES('fixture-agent','','fake','fixture-native-thread','fixture-prefix','fixture-config','2026-11-04T00:00:00.000Z');
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  created_at TEXT NOT NULL
);
INSERT INTO "agents" VALUES('fixture-agent','fixture','fake','{}','2026-11-04T00:00:00.000Z');
CREATE TABLE command_receipts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  committed_at TEXT NOT NULL
);
CREATE TABLE daemon_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  start_identity TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  status_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(status_json))
);
CREATE TABLE deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL REFERENCES messages(id),
  recipient_id TEXT NOT NULL REFERENCES agents(id),
  lane_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','starting','running','completed','failed','interrupted','cancelled')),
  turn_id TEXT,
  error TEXT,
  retry_of TEXT REFERENCES deliveries(id),
  chain_id TEXT NOT NULL,
  hop INTEGER NOT NULL DEFAULT 0 CHECK (hop >= 0),
  updated_at TEXT NOT NULL
, batch_id TEXT);
INSERT INTO "deliveries" VALUES(1,'fixture-delivery','fixture-message','fixture-agent',NULL,'queued',NULL,NULL,NULL,'fixture-chain',0,'2026-11-04T00:00:00.000Z',NULL);
INSERT INTO "deliveries" VALUES(2,'fixture-completed-delivery','fixture-completed-message','fixture-agent',NULL,'completed','fixture-turn',NULL,NULL,'fixture-completed-chain',0,'2026-11-04T00:00:00.000Z','fixture-batch');
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL,
  type TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL
);
INSERT INTO "events" VALUES(1,'297b296d-ff77-447e-a127-ab10792c8747','migration:4:genesis','price.configured',1,'{"row":{"id":"989b28c0e67140dd7d7dece18c353560b947686a3abea801090c2731a1a45edf","provider":"claude","model":"claude-sonnet-4-6","input_usd":3,"cache_write_5m_usd":3.75,"cache_write_1h_usd":6,"cache_read_usd":0.3,"output_usd":15,"effective_from":"2026-11-04T00:00:00.000Z","source_url":"https://platform.claude.com/docs/en/about-claude/pricing","snapshot_json":"{\"effectiveFrom\":\"2026-11-04T00:00:00.000Z\",\"price\":{\"cacheRead\":0.3,\"cacheWrite1h\":6,\"cacheWrite5m\":3.75,\"currency\":\"USD\",\"input\":3,\"model\":\"claude-sonnet-4-6\",\"output\":15,\"source\":\"https://platform.claude.com/docs/en/about-claude/pricing\",\"unit\":\"million-tokens\",\"verifiedAt\":\"2026-11-04\"},\"provider\":\"claude\"}"}}','2026-11-04T00:00:00.000Z');
INSERT INTO "events" VALUES(2,'97e6aa6b-5cd0-42f8-b216-5df180400323','migration:4:genesis','price.configured',1,'{"row":{"id":"ad708f520e7c319d0f221c2fd9abfb62f6d648cf51f617094b1ba2ac5582b853","provider":"claude","model":"claude-sonnet-5-5","input_usd":2,"cache_write_5m_usd":2.5,"cache_write_1h_usd":4,"cache_read_usd":0.1,"output_usd":10,"effective_from":"2026-11-04T00:00:00.000Z","source_url":"https://platform.claude.com/docs/en/about-claude/pricing","snapshot_json":"{\"effectiveFrom\":\"2026-11-04T00:00:00.000Z\",\"price\":{\"cacheRead\":0.1,\"cacheWrite1h\":4,\"cacheWrite5m\":2.5,\"currency\":\"USD\",\"input\":2,\"model\":\"claude-sonnet-5-5\",\"output\":10,\"source\":\"https://platform.claude.com/docs/en/about-claude/pricing\",\"unit\":\"million-tokens\",\"verifiedAt\":\"2026-11-04\"},\"provider\":\"claude\"}"}}','2026-11-04T00:00:00.000Z');
INSERT INTO "events" VALUES(3,'2a2da779-ab27-4bbd-8e23-f4dfa848c13e','migration:4:genesis','price.configured',1,'{"row":{"id":"e19ac00f3437a12196c93472e9f3ee399c44cb8178c7e3e844feb13123ba90d1","provider":"claude","model":"claude-opus-5-5","input_usd":4,"cache_write_5m_usd":5,"cache_write_1h_usd":8,"cache_read_usd":0.2,"output_usd":20,"effective_from":"2026-11-04T00:00:00.000Z","source_url":"https://platform.claude.com/docs/en/about-claude/pricing","snapshot_json":"{\"effectiveFrom\":\"2026-11-04T00:00:00.000Z\",\"price\":{\"cacheRead\":0.2,\"cacheWrite1h\":8,\"cacheWrite5m\":5,\"currency\":\"USD\",\"input\":4,\"model\":\"claude-opus-5-5\",\"output\":20,\"source\":\"https://platform.claude.com/docs/en/about-claude/pricing\",\"unit\":\"million-tokens\",\"verifiedAt\":\"2026-11-04\"},\"provider\":\"claude\"}"}}','2026-11-04T00:00:00.000Z');
INSERT INTO "events" VALUES(4,'2bdf72a3-23a7-4ad2-8453-03fc5859340e','migration:4:genesis','price.configured',1,'{"row":{"id":"588744f88112801669fb42ae643bb1f67adb4fbbd01aeb1d7f5705bc14c71bc2","provider":"claude","model":"claude-fable-5-1","input_usd":10,"cache_write_5m_usd":12.5,"cache_write_1h_usd":20,"cache_read_usd":0.25,"output_usd":50,"effective_from":"2026-11-04T00:00:00.000Z","source_url":"https://platform.claude.com/docs/en/about-claude/pricing","snapshot_json":"{\"effectiveFrom\":\"2026-11-04T00:00:00.000Z\",\"price\":{\"cacheRead\":0.25,\"cacheWrite1h\":20,\"cacheWrite5m\":12.5,\"currency\":\"USD\",\"input\":10,\"model\":\"claude-fable-5-1\",\"output\":50,\"source\":\"https://platform.claude.com/docs/en/about-claude/pricing\",\"unit\":\"million-tokens\",\"verifiedAt\":\"2026-11-04\"},\"provider\":\"claude\"}"}}','2026-11-04T00:00:00.000Z');
INSERT INTO "events" VALUES(5,'79a7c1d6-b6da-445e-9def-3c446df13b6d','migration:4:genesis','price.configured',1,'{"row":{"id":"42a1a53df582d390f1ba2592efbb1ce027722c9016de7ef492f8ec49222907a4","provider":"fake","model":"fake","input_usd":0,"cache_write_5m_usd":0,"cache_write_1h_usd":0,"cache_read_usd":0,"output_usd":0,"effective_from":"2026-11-04T00:00:00.000Z","source_url":"Kru deterministic fake: no model calls","snapshot_json":"{\"effectiveFrom\":\"2026-11-04T00:00:00.000Z\",\"price\":{\"cacheRead\":0,\"cacheWrite1h\":0,\"cacheWrite5m\":0,\"currency\":\"USD\",\"input\":0,\"model\":\"fake\",\"output\":0,\"source\":\"Kru deterministic fake: no model calls\",\"unit\":\"million-tokens\",\"verifiedAt\":\"2026-11-04\"},\"provider\":\"fake\"}"}}','2026-11-04T00:00:00.000Z');
INSERT INTO "events" VALUES(6,'000e4887-5bc2-4f93-954f-6afae743f693','migration:4:genesis','agent.configured',1,'{"row":{"id":"fixture-agent","name":"fixture","provider":"fake","config_json":"{}","created_at":"2026-11-04T00:00:00.000Z"}}','2026-11-04T00:00:00.000Z');
INSERT INTO "events" VALUES(7,'4cfe3087-0cf5-42a4-a65b-f7728e0c3689','migration:4:genesis','message.imported',1,'{"row":{"id":"fixture-message","sender_kind":"user","sender_agent_id":null,"sender_routine_id":null,"text":"retained work","reply_to":null,"expects_reply":0,"idempotency_key":null,"request_hash":null,"created_at":"2026-11-04T00:00:00.000Z"}}','2026-11-04T00:00:00.000Z');
INSERT INTO "events" VALUES(8,'51740d48-438d-4fe6-98cf-5f948ff3061e','migration:4:genesis','message.imported',1,'{"row":{"id":"fixture-completed-message","sender_kind":"user","sender_agent_id":null,"sender_routine_id":null,"text":"completed work","reply_to":null,"expects_reply":0,"idempotency_key":null,"request_hash":null,"created_at":"2026-11-04T00:00:00.000Z"}}','2026-11-04T00:00:00.000Z');
INSERT INTO "events" VALUES(9,'a2174a7f-16f3-4358-9b20-2e370460fb54','migration:4:genesis','delivery.imported',1,'{"row":{"seq":1,"id":"fixture-delivery","message_id":"fixture-message","recipient_id":"fixture-agent","lane_id":null,"status":"queued","turn_id":null,"error":null,"retry_of":null,"chain_id":"fixture-chain","hop":0,"updated_at":"2026-11-04T00:00:00.000Z","batch_id":null}}','2026-11-04T00:00:00.000Z');
INSERT INTO "events" VALUES(10,'241b1f5e-191d-43f7-be2f-2e176943e281','migration:4:genesis','delivery.imported',1,'{"row":{"seq":2,"id":"fixture-completed-delivery","message_id":"fixture-completed-message","recipient_id":"fixture-agent","lane_id":null,"status":"completed","turn_id":"fixture-turn","error":null,"retry_of":null,"chain_id":"fixture-completed-chain","hop":0,"updated_at":"2026-11-04T00:00:00.000Z","batch_id":"fixture-batch"}}','2026-11-04T00:00:00.000Z');
INSERT INTO "events" VALUES(11,'cf0eef95-eafc-427b-98eb-a0510b441b21','migration:4:genesis','price.configured',1,'{"row":{"id":"989b28c0e67140dd7d7dece18c353560b947686a3abea801090c2731a1a45edf","provider":"claude","model":"claude-sonnet-4-6","input_usd":3,"cache_write_5m_usd":3.75,"cache_write_1h_usd":6,"cache_read_usd":0.3,"output_usd":15,"effective_from":"2026-11-04T00:00:00.000Z","source_url":"https://platform.claude.com/docs/en/about-claude/pricing","snapshot_json":"{\"effectiveFrom\":\"2026-11-04T00:00:00.000Z\",\"price\":{\"cacheRead\":0.3,\"cacheWrite1h\":6,\"cacheWrite5m\":3.75,\"currency\":\"USD\",\"input\":3,\"model\":\"claude-sonnet-4-6\",\"output\":15,\"source\":\"https://platform.claude.com/docs/en/about-claude/pricing\",\"unit\":\"million-tokens\",\"verifiedAt\":\"2026-11-04\"},\"provider\":\"claude\"}"}}','2026-11-04T00:00:00.000Z');
INSERT INTO "events" VALUES(12,'fe814b1a-86a0-4570-98cf-ae259ecb78ca','migration:4:genesis','usage.imported',1,'{"row":{"batch_id":"fixture-batch","agent_id":"fixture-agent","provider":"claude","model":"claude-sonnet-4-6","thread_id":"fixture-native-thread","turn_id":"fixture-turn","cause":"user","deliveries_json":"[\"fixture-completed-delivery\"]","chains_json":"[\"fixture-completed-chain\"]","phase":"final","outcome":"completed","usage_json":"{\"last\":{\"inputTotal\":3,\"cachedRead\":0,\"cacheWrite\":0,\"output\":1,\"totalTokens\":4},\"total\":{\"inputTotal\":3,\"cachedRead\":0,\"cacheWrite\":0,\"output\":1,\"totalTokens\":4}}","cost_json":"{\"model\":\"claude-sonnet-4-6\",\"minimumNanoUsd\":24000,\"maximumNanoUsd\":24000,\"unknownCacheWriteTokens\":0,\"estimated\":true,\"scope\":\"main-agent-token-usage\",\"price\":{\"model\":\"claude-sonnet-4-6\",\"input\":3,\"cacheWrite5m\":3.75,\"cacheWrite1h\":6,\"cacheRead\":0.3,\"output\":15,\"source\":\"https://platform.claude.com/docs/en/about-claude/pricing\",\"verifiedAt\":\"2026-11-04\",\"currency\":\"USD\",\"unit\":\"million-tokens\"}}","complete":1,"resolution_json":null,"started_at":"2026-11-04T00:00:00.000Z","updated_at":"2026-11-04T00:00:00.000Z","lane_key":"","price_id":"989b28c0e67140dd7d7dece18c353560b947686a3abea801090c2731a1a45edf","recorded_at":"2026-11-04T00:00:00.000Z","input_total":3,"cached_read":0,"cache_write":0,"cache_write_5m":null,"cache_write_1h":null,"output":1,"cost_usd":0.000024,"estimated":1}}','2026-11-04T00:00:00.000Z');
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('user','agent','routine')),
  sender_agent_id TEXT REFERENCES agents(id),
  sender_routine_id TEXT,
  text TEXT NOT NULL,
  reply_to TEXT REFERENCES messages(id),
  expects_reply INTEGER NOT NULL DEFAULT 0 CHECK (expects_reply IN (0,1)),
  idempotency_key TEXT UNIQUE,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  CHECK ((sender_kind = 'agent' AND sender_agent_id IS NOT NULL AND sender_routine_id IS NULL)
    OR (sender_kind = 'routine' AND sender_routine_id IS NOT NULL AND sender_agent_id IS NULL)
    OR (sender_kind = 'user' AND sender_agent_id IS NULL AND sender_routine_id IS NULL)),
  CHECK ((idempotency_key IS NULL AND request_hash IS NULL)
    OR (idempotency_key IS NOT NULL AND request_hash IS NOT NULL))
);
INSERT INTO "messages" VALUES('fixture-message','user',NULL,NULL,'retained work',NULL,0,NULL,NULL,'2026-11-04T00:00:00.000Z');
INSERT INTO "messages" VALUES('fixture-completed-message','user',NULL,NULL,'completed work',NULL,0,NULL,NULL,'2026-11-04T00:00:00.000Z');
CREATE TABLE prices (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
  input_usd REAL NOT NULL, cache_write_5m_usd REAL NOT NULL, cache_write_1h_usd REAL NOT NULL,
  cache_read_usd REAL NOT NULL, output_usd REAL NOT NULL,
  effective_from TEXT NOT NULL, source_url TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json))
);
INSERT INTO "prices" VALUES('989b28c0e67140dd7d7dece18c353560b947686a3abea801090c2731a1a45edf','claude','claude-sonnet-4-6',3.0,3.75,6.0,0.3,15.0,'2026-11-04T00:00:00.000Z','https://platform.claude.com/docs/en/about-claude/pricing','{"effectiveFrom":"2026-11-04T00:00:00.000Z","price":{"cacheRead":0.3,"cacheWrite1h":6,"cacheWrite5m":3.75,"currency":"USD","input":3,"model":"claude-sonnet-4-6","output":15,"source":"https://platform.claude.com/docs/en/about-claude/pricing","unit":"million-tokens","verifiedAt":"2026-11-04"},"provider":"claude"}');
INSERT INTO "prices" VALUES('ad708f520e7c319d0f221c2fd9abfb62f6d648cf51f617094b1ba2ac5582b853','claude','claude-sonnet-5-5',2.0,2.5,4.0,0.1,10.0,'2026-11-04T00:00:00.000Z','https://platform.claude.com/docs/en/about-claude/pricing','{"effectiveFrom":"2026-11-04T00:00:00.000Z","price":{"cacheRead":0.1,"cacheWrite1h":4,"cacheWrite5m":2.5,"currency":"USD","input":2,"model":"claude-sonnet-5-5","output":10,"source":"https://platform.claude.com/docs/en/about-claude/pricing","unit":"million-tokens","verifiedAt":"2026-11-04"},"provider":"claude"}');
INSERT INTO "prices" VALUES('e19ac00f3437a12196c93472e9f3ee399c44cb8178c7e3e844feb13123ba90d1','claude','claude-opus-5-5',4.0,5.0,8.0,0.2,20.0,'2026-11-04T00:00:00.000Z','https://platform.claude.com/docs/en/about-claude/pricing','{"effectiveFrom":"2026-11-04T00:00:00.000Z","price":{"cacheRead":0.2,"cacheWrite1h":8,"cacheWrite5m":5,"currency":"USD","input":4,"model":"claude-opus-5-5","output":20,"source":"https://platform.claude.com/docs/en/about-claude/pricing","unit":"million-tokens","verifiedAt":"2026-11-04"},"provider":"claude"}');
INSERT INTO "prices" VALUES('588744f88112801669fb42ae643bb1f67adb4fbbd01aeb1d7f5705bc14c71bc2','claude','claude-fable-5-1',10.0,12.5,20.0,0.25,50.0,'2026-11-04T00:00:00.000Z','https://platform.claude.com/docs/en/about-claude/pricing','{"effectiveFrom":"2026-11-04T00:00:00.000Z","price":{"cacheRead":0.25,"cacheWrite1h":20,"cacheWrite5m":12.5,"currency":"USD","input":10,"model":"claude-fable-5-1","output":50,"source":"https://platform.claude.com/docs/en/about-claude/pricing","unit":"million-tokens","verifiedAt":"2026-11-04"},"provider":"claude"}');
INSERT INTO "prices" VALUES('42a1a53df582d390f1ba2592efbb1ce027722c9016de7ef492f8ec49222907a4','fake','fake',0.0,0.0,0.0,0.0,0.0,'2026-11-04T00:00:00.000Z','Kru deterministic fake: no model calls','{"effectiveFrom":"2026-11-04T00:00:00.000Z","price":{"cacheRead":0,"cacheWrite1h":0,"cacheWrite5m":0,"currency":"USD","input":0,"model":"fake","output":0,"source":"Kru deterministic fake: no model calls","unit":"million-tokens","verifiedAt":"2026-11-04"},"provider":"fake"}');
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
INSERT INTO "schema_migrations" VALUES(1,'2026-11-04T00:00:00.000Z');
INSERT INTO "schema_migrations" VALUES(2,'2026-11-04T00:00:00.000Z');
INSERT INTO "schema_migrations" VALUES(3,'2026-11-04T00:00:00.000Z');
INSERT INTO "schema_migrations" VALUES(4,'2026-11-04T15:00:53.776Z');
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('deliveries',2);
INSERT INTO "sqlite_sequence" VALUES('events',12);
CREATE TABLE thread_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL REFERENCES turns(id), item_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id), lane_key TEXT NOT NULL,
  type TEXT NOT NULL, text TEXT, details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  completed_at TEXT NOT NULL, UNIQUE(turn_id, item_id)
);
CREATE TABLE turn_scratch (
  turn_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, lane_key TEXT NOT NULL,
  items_json TEXT NOT NULL CHECK (json_valid(items_json)), updated_at TEXT NOT NULL
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), lane_key TEXT NOT NULL,
  provider TEXT NOT NULL, native_thread_id TEXT NOT NULL, native_turn_id TEXT,
  model TEXT NOT NULL, profile TEXT NOT NULL, prefix_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting','running','completed','failed','interrupted')),
  error TEXT, started_at TEXT NOT NULL, completed_at TEXT, duration_ms INTEGER,
  deliveries_json TEXT NOT NULL CHECK (json_valid(deliveries_json)),
  chains_json TEXT NOT NULL CHECK (json_valid(chains_json))
);
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
  updated_at TEXT NOT NULL, lane_key TEXT NOT NULL DEFAULT '', price_id TEXT REFERENCES prices(id), recorded_at TEXT, input_total INTEGER, cached_read INTEGER, cache_write INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER, output INTEGER, cost_usd REAL, estimated INTEGER NOT NULL DEFAULT 1,
  UNIQUE (provider, thread_id, turn_id)
);
INSERT INTO "usage_records" VALUES('fixture-batch','fixture-agent','claude','claude-sonnet-4-6','fixture-native-thread','fixture-turn','user','["fixture-completed-delivery"]','["fixture-completed-chain"]','final','completed','{"last":{"inputTotal":3,"cachedRead":0,"cacheWrite":0,"output":1,"totalTokens":4},"total":{"inputTotal":3,"cachedRead":0,"cacheWrite":0,"output":1,"totalTokens":4}}','{"model":"claude-sonnet-4-6","minimumNanoUsd":24000,"maximumNanoUsd":24000,"unknownCacheWriteTokens":0,"estimated":true,"scope":"main-agent-token-usage","price":{"model":"claude-sonnet-4-6","input":3,"cacheWrite5m":3.75,"cacheWrite1h":6,"cacheRead":0.3,"output":15,"source":"https://platform.claude.com/docs/en/about-claude/pricing","verifiedAt":"2026-11-04","currency":"USD","unit":"million-tokens"}}',1,NULL,'2026-11-04T00:00:00.000Z','2026-11-04T00:00:00.000Z','','989b28c0e67140dd7d7dece18c353560b947686a3abea801090c2731a1a45edf','2026-11-04T00:00:00.000Z',3,0,0,NULL,NULL,1,2.4e-05,1);
CREATE INDEX deliveries_queue ON deliveries (recipient_id, lane_id, status, seq);
CREATE INDEX deliveries_message ON deliveries (message_id, seq);
CREATE INDEX deliveries_batch ON deliveries(batch_id);
CREATE INDEX usage_records_agent_day ON usage_records(agent_id, started_at);
CREATE INDEX events_command ON events(command_id, seq);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
CREATE TRIGGER receipts_no_update BEFORE UPDATE ON command_receipts BEGIN SELECT RAISE(ABORT, 'Receipts are immutable'); END;
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON command_receipts BEGIN SELECT RAISE(ABORT, 'Receipts are immutable'); END;
CREATE INDEX prices_model_time ON prices(provider, model, effective_from);
CREATE INDEX thread_messages_lane ON thread_messages(agent_id, lane_key, seq);
CREATE INDEX usage_records_agent_recorded ON usage_records(agent_id, recorded_at);
COMMIT;
