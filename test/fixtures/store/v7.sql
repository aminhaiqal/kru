PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE active_lanes (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  lane_key TEXT NOT NULL,
  batch_id TEXT NOT NULL UNIQUE,
  turn_id TEXT,
  started_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, lane_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS "provider_sessions" (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  lane_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  native_thread_id TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL, thread_id TEXT REFERENCES threads(id), active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)), handoff_pending INTEGER NOT NULL DEFAULT 0 CHECK (handoff_pending IN (0,1)),
  PRIMARY KEY (agent_id, lane_key, provider)
) WITHOUT ROWID;
INSERT INTO provider_sessions VALUES('fixture-agent','','fake','fixture-native-thread','fixture-prefix','fixture-config','2026-11-04T00:00:00.000Z','bbabba3a-681a-47da-b95b-ea50358986ef',1,0);
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  created_at TEXT NOT NULL
);
INSERT INTO agents VALUES('fixture-agent','fixture','fake','{}','2026-11-04T00:00:00.000Z');
INSERT INTO agents VALUES('8b518e15-1c99-4672-8789-7edc87681e89','fixture-recipient','fake','{}','2026-11-04T15:35:49.091Z');
CREATE TABLE command_receipts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  committed_at TEXT NOT NULL
);
INSERT INTO command_receipts VALUES('7e0a96ce-4ad2-4cb0-8dd9-551a2aa702f0','agent.create','null','{}','2026-11-04T15:35:49.091Z');
INSERT INTO command_receipts VALUES('293d7a06-39b2-418f-a4e9-c727cd0d7990','mailbox.claimBatch','null','{"value":{"id":"7c57e119-269a-4301-a5b9-90c0d7d470a9","agentId":"fixture-agent","laneId":null,"deliveries":[{"seq":1,"id":"fixture-delivery","messageId":"fixture-message","recipientAgentId":"fixture-agent","laneId":null,"sender":{"kind":"user"},"text":"retained work","replyToMessageId":null,"expectsReply":false,"status":"starting","batchId":"7c57e119-269a-4301-a5b9-90c0d7d470a9","turnId":null,"error":null,"retryOf":null,"chainId":"fixture-chain","hop":0,"idempotencyKey":null,"createdAt":"2026-11-04T00:00:00.000Z","updatedAt":"2026-11-04T15:35:49.092Z"}]}}','2026-11-04T15:35:49.092Z');
INSERT INTO command_receipts VALUES('9db29238-df50-4bb6-a090-e2100f98e061','mailbox.enqueue','null','{"value":{"messageId":"f5dfe68c-7b74-4820-8d93-4cb96f6f2e25","deliveryIds":["daaf9c83-f771-4b0a-8e1b-7b5dc0579415"],"duplicate":false}}','2026-11-04T15:35:49.098Z');
INSERT INTO command_receipts VALUES('tool:8c7b3b7b3067a073d7b6513614721ae70d91c146dd1dd764f6f238da250d8ab6','tools','{"agentId":"fixture-agent","arguments":{"expectsReply":true,"text":"retained request","to":["8b518e15-1c99-4672-8789-7edc87681e89"]},"batchId":"7c57e119-269a-4301-a5b9-90c0d7d470a9","callId":"fixture-send","laneId":null,"threadId":"fixture-native","tool":"send_message","turnId":"fixture-outbound"}','{"value":{"success":true,"contentItems":[{"type":"inputText","text":"{\"messageId\":\"f5dfe68c-7b74-4820-8d93-4cb96f6f2e25\",\"deliveryIds\":[\"daaf9c83-f771-4b0a-8e1b-7b5dc0579415\"],\"queued\":true,\"expectsReply\":true,\"chainId\":\"fixture-chain\",\"hop\":1}"}]}}','2026-11-04T15:35:49.100Z');
INSERT INTO command_receipts VALUES('142a4752-7fe9-4a40-8f71-d531caee8d90','mailbox.changeBatch','null','{"value":["fixture-delivery"]}','2026-11-04T15:35:49.101Z');
INSERT INTO command_receipts VALUES('43fa174b-2073-47f2-9bdd-397cf7ecdb11','mailbox.claimBatch','null','{"value":{"id":"802c2376-9bee-4fc0-8d48-e293ce271555","agentId":"8b518e15-1c99-4672-8789-7edc87681e89","laneId":null,"deliveries":[{"seq":3,"id":"daaf9c83-f771-4b0a-8e1b-7b5dc0579415","messageId":"f5dfe68c-7b74-4820-8d93-4cb96f6f2e25","recipientAgentId":"8b518e15-1c99-4672-8789-7edc87681e89","laneId":null,"sender":{"kind":"agent","agentId":"fixture-agent"},"text":"retained request","replyToMessageId":null,"expectsReply":true,"status":"starting","batchId":"802c2376-9bee-4fc0-8d48-e293ce271555","turnId":null,"error":null,"retryOf":null,"chainId":"fixture-chain","hop":1,"idempotencyKey":"tool:8c7b3b7b3067a073d7b6513614721ae70d91c146dd1dd764f6f238da250d8ab6","createdAt":"2026-11-04T15:35:49.096Z","updatedAt":"2026-11-04T15:35:49.102Z"}]}}','2026-11-04T15:35:49.102Z');
INSERT INTO command_receipts VALUES('c91e2640-336b-477f-9919-2383ed4ed29e','mailbox.changeBatch','null','{"value":["daaf9c83-f771-4b0a-8e1b-7b5dc0579415"]}','2026-11-04T15:35:49.102Z');
INSERT INTO command_receipts VALUES('39afe926-5ed7-4d98-a4b7-31303e47f044','mailbox.enqueue','null','{"value":{"messageId":"5246fa68-5ba5-4716-b866-78ea08e35680","deliveryIds":["aa000b5b-7efc-459f-972b-c7b1faf9cf74"],"duplicate":false}}','2026-11-04T15:35:49.109Z');
INSERT INTO command_receipts VALUES('reply:daaf9c83-f771-4b0a-8e1b-7b5dc0579415','tools','{"batchId":"802c2376-9bee-4fc0-8d48-e293ce271555","deliveryId":"daaf9c83-f771-4b0a-8e1b-7b5dc0579415"}','{}','2026-11-04T15:35:49.110Z');
INSERT INTO command_receipts VALUES('8539e913-c5fe-4b8b-afb4-c1f41926e4d2','mailbox.changeBatch','null','{"value":["daaf9c83-f771-4b0a-8e1b-7b5dc0579415"]}','2026-11-04T15:35:49.111Z');
INSERT INTO command_receipts VALUES('bc44579e-faeb-4dee-8c24-a5163e6835bc','transaction','null','{}','2026-11-04T15:35:49.111Z');
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
INSERT INTO deliveries VALUES(1,'fixture-delivery','fixture-message','fixture-agent',NULL,'failed',NULL,NULL,NULL,'fixture-chain',0,'2026-11-04T15:35:49.100Z','7c57e119-269a-4301-a5b9-90c0d7d470a9');
INSERT INTO deliveries VALUES(2,'fixture-completed-delivery','fixture-completed-message','fixture-agent',NULL,'completed','fixture-turn',NULL,NULL,'fixture-completed-chain',0,'2026-11-04T00:00:00.000Z','fixture-batch');
INSERT INTO deliveries VALUES(3,'daaf9c83-f771-4b0a-8e1b-7b5dc0579415','f5dfe68c-7b74-4820-8d93-4cb96f6f2e25','8b518e15-1c99-4672-8789-7edc87681e89',NULL,'completed','fixture-reply',NULL,NULL,'fixture-chain',1,'2026-11-04T15:35:49.110Z','802c2376-9bee-4fc0-8d48-e293ce271555');
INSERT INTO deliveries VALUES(4,'aa000b5b-7efc-459f-972b-c7b1faf9cf74','5246fa68-5ba5-4716-b866-78ea08e35680','fixture-agent',NULL,'queued',NULL,NULL,NULL,'fixture-chain',2,'2026-11-04T15:35:49.103Z',NULL);
CREATE TABLE delivery_replies (
  delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id),
  message_id TEXT REFERENCES messages(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('sent','suppressed')),
  reason TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO delivery_replies VALUES('daaf9c83-f771-4b0a-8e1b-7b5dc0579415','5246fa68-5ba5-4716-b866-78ea08e35680','sent',NULL,'2026-11-04T15:35:49.109Z');
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL,
  type TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL
);
INSERT INTO events VALUES(1,'297b296d-ff77-447e-a127-ab10792c8747','migration:4:genesis','price.configured',1,'{"row":{"id":"989b28c0e67140dd7d7dece18c353560b947686a3abea801090c2731a1a45edf","provider":"claude","model":"claude-sonnet-4-6","input_usd":3,"cache_write_5m_usd":3.75,"cache_write_1h_usd":6,"cache_read_usd":0.3,"output_usd":15,"effective_from":"2026-11-04T00:00:00.000Z","source_url":"https://platform.claude.com/docs/en/about-claude/pricing","snapshot_json":"{\"effectiveFrom\":\"2026-11-04T00:00:00.000Z\",\"price\":{\"cacheRead\":0.3,\"cacheWrite1h\":6,\"cacheWrite5m\":3.75,\"currency\":\"USD\",\"input\":3,\"model\":\"claude-sonnet-4-6\",\"output\":15,\"source\":\"https://platform.claude.com/docs/en/about-claude/pricing\",\"unit\":\"million-tokens\",\"verifiedAt\":\"2026-11-04\"},\"provider\":\"claude\"}"}}','2026-11-04T00:00:00.000Z');
INSERT INTO events VALUES(2,'97e6aa6b-5cd0-42f8-b216-5df180400323','migration:4:genesis','price.configured',1,'{"row":{"id":"ad708f520e7c319d0f221c2fd9abfb62f6d648cf51f617094b1ba2ac5582b853","provider":"claude","model":"claude-sonnet-5-5","input_usd":2,"cache_write_5m_usd":2.5,"cache_write_1h_usd":4,"cache_read_usd":0.1,"output_usd":10,"effective_from":"2026-11-04T00:00:00.000Z","source_url":"https://platform.claude.com/docs/en/about-claude/pricing","snapshot_json":"{\"effectiveFrom\":\"2026-11-04T00:00:00.000Z\",\"price\":{\"cacheRead\":0.1,\"cacheWrite1h\":4,\"cacheWrite5m\":2.5,\"currency\":\"USD\",\"input\":2,\"model\":\"claude-sonnet-5-5\",\"output\":10,\"source\":\"https://platform.claude.com/docs/en/about-claude/pricing\",\"unit\":\"million-tokens\",\"verifiedAt\":\"2026-11-04\"},\"provider\":\"claude\"}"}}','2026-11-04T00:00:00.000Z');
INSERT INTO events VALUES(3,'2a2da779-ab27-4bbd-8e23-f4dfa848c13e','migration:4:genesis','price.configured',1,'{"row":{"id":"e19ac00f3437a12196c93472e9f3ee399c44cb8178c7e3e844feb13123ba90d1","provider":"claude","model":"claude-opus-5-5","input_usd":4,"cache_write_5m_usd":5,"cache_write_1h_usd":8,"cache_read_usd":0.2,"output_usd":20,"effective_from":"2026-11-04T00:00:00.000Z","source_url":"https://platform.claude.com/docs/en/about-claude/pricing","snapshot_json":"{\"effectiveFrom\":\"2026-11-04T00:00:00.000Z\",\"price\":{\"cacheRead\":0.2,\"cacheWrite1h\":8,\"cacheWrite5m\":5,\"currency\":\"USD\",\"input\":4,\"model\":\"claude-opus-5-5\",\"output\":20,\"source\":\"https://platform.claude.com/docs/en/about-claude/pricing\",\"unit\":\"million-tokens\",\"verifiedAt\":\"2026-11-04\"},\"provider\":\"claude\"}"}}','2026-11-04T00:00:00.000Z');
INSERT INTO events VALUES(4,'2bdf72a3-23a7-4ad2-8453-03fc5859340e','migration:4:genesis','price.configured',1,'{"row":{"id":"588744f88112801669fb42ae643bb1f67adb4fbbd01aeb1d7f5705bc14c71bc2","provider":"claude","model":"claude-fable-5-1","input_usd":10,"cache_write_5m_usd":12.5,"cache_write_1h_usd":20,"cache_read_usd":0.25,"output_usd":50,"effective_from":"2026-11-04T00:00:00.000Z","source_url":"https://platform.claude.com/docs/en/about-claude/pricing","snapshot_json":"{\"effectiveFrom\":\"2026-11-04T00:00:00.000Z\",\"price\":{\"cacheRead\":0.25,\"cacheWrite1h\":20,\"cacheWrite5m\":12.5,\"currency\":\"USD\",\"input\":10,\"model\":\"claude-fable-5-1\",\"output\":50,\"source\":\"https://platform.claude.com/docs/en/about-claude/pricing\",\"unit\":\"million-tokens\",\"verifiedAt\":\"2026-11-04\"},\"provider\":\"claude\"}"}}','2026-11-04T00:00:00.000Z');
INSERT INTO events VALUES(5,'79a7c1d6-b6da-445e-9def-3c446df13b6d','migration:4:genesis','price.configured',1,'{"row":{"id":"42a1a53df582d390f1ba2592efbb1ce027722c9016de7ef492f8ec49222907a4","provider":"fake","model":"fake","input_usd":0,"cache_write_5m_usd":0,"cache_write_1h_usd":0,"cache_read_usd":0,"output_usd":0,"effective_from":"2026-11-04T00:00:00.000Z","source_url":"Kru deterministic fake: no model calls","snapshot_json":"{\"effectiveFrom\":\"2026-11-04T00:00:00.000Z\",\"price\":{\"cacheRead\":0,\"cacheWrite1h\":0,\"cacheWrite5m\":0,\"currency\":\"USD\",\"input\":0,\"model\":\"fake\",\"output\":0,\"source\":\"Kru deterministic fake: no model calls\",\"unit\":\"million-tokens\",\"verifiedAt\":\"2026-11-04\"},\"provider\":\"fake\"}"}}','2026-11-04T00:00:00.000Z');
INSERT INTO events VALUES(6,'000e4887-5bc2-4f93-954f-6afae743f693','migration:4:genesis','agent.configured',1,'{"row":{"id":"fixture-agent","name":"fixture","provider":"fake","config_json":"{}","created_at":"2026-11-04T00:00:00.000Z"}}','2026-11-04T00:00:00.000Z');
INSERT INTO events VALUES(7,'4cfe3087-0cf5-42a4-a65b-f7728e0c3689','migration:4:genesis','message.imported',1,'{"row":{"id":"fixture-message","sender_kind":"user","sender_agent_id":null,"sender_routine_id":null,"text":"retained work","reply_to":null,"expects_reply":0,"idempotency_key":null,"request_hash":null,"created_at":"2026-11-04T00:00:00.000Z"}}','2026-11-04T00:00:00.000Z');
INSERT INTO events VALUES(8,'51740d48-438d-4fe6-98cf-5f948ff3061e','migration:4:genesis','message.imported',1,'{"row":{"id":"fixture-completed-message","sender_kind":"user","sender_agent_id":null,"sender_routine_id":null,"text":"completed work","reply_to":null,"expects_reply":0,"idempotency_key":null,"request_hash":null,"created_at":"2026-11-04T00:00:00.000Z"}}','2026-11-04T00:00:00.000Z');
INSERT INTO events VALUES(9,'a2174a7f-16f3-4358-9b20-2e370460fb54','migration:4:genesis','delivery.imported',1,'{"row":{"seq":1,"id":"fixture-delivery","message_id":"fixture-message","recipient_id":"fixture-agent","lane_id":null,"status":"queued","turn_id":null,"error":null,"retry_of":null,"chain_id":"fixture-chain","hop":0,"updated_at":"2026-11-04T00:00:00.000Z","batch_id":null}}','2026-11-04T00:00:00.000Z');
INSERT INTO events VALUES(10,'241b1f5e-191d-43f7-be2f-2e176943e281','migration:4:genesis','delivery.imported',1,'{"row":{"seq":2,"id":"fixture-completed-delivery","message_id":"fixture-completed-message","recipient_id":"fixture-agent","lane_id":null,"status":"completed","turn_id":"fixture-turn","error":null,"retry_of":null,"chain_id":"fixture-completed-chain","hop":0,"updated_at":"2026-11-04T00:00:00.000Z","batch_id":"fixture-batch"}}','2026-11-04T00:00:00.000Z');
INSERT INTO events VALUES(11,'cf0eef95-eafc-427b-98eb-a0510b441b21','migration:4:genesis','price.configured',1,'{"row":{"id":"989b28c0e67140dd7d7dece18c353560b947686a3abea801090c2731a1a45edf","provider":"claude","model":"claude-sonnet-4-6","input_usd":3,"cache_write_5m_usd":3.75,"cache_write_1h_usd":6,"cache_read_usd":0.3,"output_usd":15,"effective_from":"2026-11-04T00:00:00.000Z","source_url":"https://platform.claude.com/docs/en/about-claude/pricing","snapshot_json":"{\"effectiveFrom\":\"2026-11-04T00:00:00.000Z\",\"price\":{\"cacheRead\":0.3,\"cacheWrite1h\":6,\"cacheWrite5m\":3.75,\"currency\":\"USD\",\"input\":3,\"model\":\"claude-sonnet-4-6\",\"output\":15,\"source\":\"https://platform.claude.com/docs/en/about-claude/pricing\",\"unit\":\"million-tokens\",\"verifiedAt\":\"2026-11-04\"},\"provider\":\"claude\"}"}}','2026-11-04T00:00:00.000Z');
INSERT INTO events VALUES(12,'fe814b1a-86a0-4570-98cf-ae259ecb78ca','migration:4:genesis','usage.imported',1,'{"row":{"batch_id":"fixture-batch","agent_id":"fixture-agent","provider":"claude","model":"claude-sonnet-4-6","thread_id":"fixture-native-thread","turn_id":"fixture-turn","cause":"user","deliveries_json":"[\"fixture-completed-delivery\"]","chains_json":"[\"fixture-completed-chain\"]","phase":"final","outcome":"completed","usage_json":"{\"last\":{\"inputTotal\":3,\"cachedRead\":0,\"cacheWrite\":0,\"output\":1,\"totalTokens\":4},\"total\":{\"inputTotal\":3,\"cachedRead\":0,\"cacheWrite\":0,\"output\":1,\"totalTokens\":4}}","cost_json":"{\"model\":\"claude-sonnet-4-6\",\"minimumNanoUsd\":24000,\"maximumNanoUsd\":24000,\"unknownCacheWriteTokens\":0,\"estimated\":true,\"scope\":\"main-agent-token-usage\",\"price\":{\"model\":\"claude-sonnet-4-6\",\"input\":3,\"cacheWrite5m\":3.75,\"cacheWrite1h\":6,\"cacheRead\":0.3,\"output\":15,\"source\":\"https://platform.claude.com/docs/en/about-claude/pricing\",\"verifiedAt\":\"2026-11-04\",\"currency\":\"USD\",\"unit\":\"million-tokens\"}}","complete":1,"resolution_json":null,"started_at":"2026-11-04T00:00:00.000Z","updated_at":"2026-11-04T00:00:00.000Z","lane_key":"","price_id":"989b28c0e67140dd7d7dece18c353560b947686a3abea801090c2731a1a45edf","recorded_at":"2026-11-04T00:00:00.000Z","input_total":3,"cached_read":0,"cache_write":0,"cache_write_5m":null,"cache_write_1h":null,"output":1,"cost_usd":0.000024,"estimated":1}}','2026-11-04T00:00:00.000Z');
INSERT INTO events VALUES(13,'0f9043fe-fbbe-4834-820c-99130126885c','7e0a96ce-4ad2-4cb0-8dd9-551a2aa702f0','agent.configured',1,'{"row":{"id":"8b518e15-1c99-4672-8789-7edc87681e89","name":"fixture-recipient","provider":"fake","config_json":"{}","created_at":"2026-11-04T15:35:49.091Z"}}','2026-11-04T15:35:49.091Z');
INSERT INTO events VALUES(14,'88a5e39c-e284-42ed-a3dd-1600304175d9','293d7a06-39b2-418f-a4e9-c727cd0d7990','delivery.claimed',1,'{"row":{"seq":1,"id":"fixture-delivery","message_id":"fixture-message","recipient_id":"fixture-agent","lane_id":null,"status":"starting","turn_id":null,"error":null,"retry_of":null,"chain_id":"fixture-chain","hop":0,"updated_at":"2026-11-04T15:35:49.092Z","batch_id":"7c57e119-269a-4301-a5b9-90c0d7d470a9"}}','2026-11-04T15:35:49.092Z');
INSERT INTO events VALUES(15,'8e41feb5-3c0b-4d92-8458-d8170f7f2cda','tool:8c7b3b7b3067a073d7b6513614721ae70d91c146dd1dd764f6f238da250d8ab6','message.enqueued',1,'{"row":{"id":"f5dfe68c-7b74-4820-8d93-4cb96f6f2e25","sender_kind":"agent","sender_agent_id":"fixture-agent","sender_routine_id":null,"text":"retained request","reply_to":null,"expects_reply":1,"idempotency_key":"tool:8c7b3b7b3067a073d7b6513614721ae70d91c146dd1dd764f6f238da250d8ab6","request_hash":"041cfe056a11ae7c71c87b67bb8746fa21c3ed9dad87639b7eec44cb4c3749f7","created_at":"2026-11-04T15:35:49.096Z"},"deliveries":[{"seq":3,"id":"daaf9c83-f771-4b0a-8e1b-7b5dc0579415","message_id":"f5dfe68c-7b74-4820-8d93-4cb96f6f2e25","recipient_id":"8b518e15-1c99-4672-8789-7edc87681e89","lane_id":null,"status":"queued","chain_id":"fixture-chain","hop":1,"updated_at":"2026-11-04T15:35:49.096Z","turn_id":null,"batch_id":null,"error":null,"retry_of":null}]}','2026-11-04T15:35:49.096Z');
INSERT INTO events VALUES(16,'a3a18313-8878-4993-a9f4-d20aaada3cb1','tool:8c7b3b7b3067a073d7b6513614721ae70d91c146dd1dd764f6f238da250d8ab6','message.routed',1,'{"row":{"message_id":"f5dfe68c-7b74-4820-8d93-4cb96f6f2e25","sender_lane_key":""}}','2026-11-04T15:35:49.098Z');
INSERT INTO events VALUES(17,'92e8bc1d-0f47-4d98-8047-14721bbb8e2c','142a4752-7fe9-4a40-8f71-d531caee8d90','delivery.finished',1,'{"row":{"seq":1,"id":"fixture-delivery","message_id":"fixture-message","recipient_id":"fixture-agent","lane_id":null,"status":"failed","turn_id":null,"error":null,"retry_of":null,"chain_id":"fixture-chain","hop":0,"updated_at":"2026-11-04T15:35:49.100Z","batch_id":"7c57e119-269a-4301-a5b9-90c0d7d470a9"}}','2026-11-04T15:35:49.100Z');
INSERT INTO events VALUES(18,'d8b6ec40-592b-4ac0-9270-232da2db40e7','43fa174b-2073-47f2-9bdd-397cf7ecdb11','delivery.claimed',1,'{"row":{"seq":3,"id":"daaf9c83-f771-4b0a-8e1b-7b5dc0579415","message_id":"f5dfe68c-7b74-4820-8d93-4cb96f6f2e25","recipient_id":"8b518e15-1c99-4672-8789-7edc87681e89","lane_id":null,"status":"starting","turn_id":null,"error":null,"retry_of":null,"chain_id":"fixture-chain","hop":1,"updated_at":"2026-11-04T15:35:49.102Z","batch_id":"802c2376-9bee-4fc0-8d48-e293ce271555"}}','2026-11-04T15:35:49.102Z');
INSERT INTO events VALUES(19,'290cc082-4f4f-4805-bc8b-fb84ec7cf37b','c91e2640-336b-477f-9919-2383ed4ed29e','delivery.running',1,'{"row":{"seq":3,"id":"daaf9c83-f771-4b0a-8e1b-7b5dc0579415","message_id":"f5dfe68c-7b74-4820-8d93-4cb96f6f2e25","recipient_id":"8b518e15-1c99-4672-8789-7edc87681e89","lane_id":null,"status":"running","turn_id":"fixture-reply","error":null,"retry_of":null,"chain_id":"fixture-chain","hop":1,"updated_at":"2026-11-04T15:35:49.102Z","batch_id":"802c2376-9bee-4fc0-8d48-e293ce271555"}}','2026-11-04T15:35:49.102Z');
INSERT INTO events VALUES(20,'8b397cc8-71ef-42cc-915c-82af35a52621','bc44579e-faeb-4dee-8c24-a5163e6835bc','message.enqueued',1,'{"row":{"id":"5246fa68-5ba5-4716-b866-78ea08e35680","sender_kind":"agent","sender_agent_id":"8b518e15-1c99-4672-8789-7edc87681e89","sender_routine_id":null,"text":"retained reply","reply_to":"f5dfe68c-7b74-4820-8d93-4cb96f6f2e25","expects_reply":0,"idempotency_key":"reply:daaf9c83-f771-4b0a-8e1b-7b5dc0579415","request_hash":"0282f1a8d351a922ba57f5b0627940cb982f69daa4adcc0669ddd18bb0ad8dfd","created_at":"2026-11-04T15:35:49.103Z"},"deliveries":[{"seq":4,"id":"aa000b5b-7efc-459f-972b-c7b1faf9cf74","message_id":"5246fa68-5ba5-4716-b866-78ea08e35680","recipient_id":"fixture-agent","lane_id":null,"status":"queued","chain_id":"fixture-chain","hop":2,"updated_at":"2026-11-04T15:35:49.103Z","turn_id":null,"batch_id":null,"error":null,"retry_of":null}]}','2026-11-04T15:35:49.103Z');
INSERT INTO events VALUES(21,'c318fbed-4757-4445-9d0e-9626c794a27e','bc44579e-faeb-4dee-8c24-a5163e6835bc','message.routed',1,'{"row":{"message_id":"5246fa68-5ba5-4716-b866-78ea08e35680","sender_lane_key":""}}','2026-11-04T15:35:49.109Z');
INSERT INTO events VALUES(22,'8e3d0ebf-b07d-472e-8a5f-1818e67d5d0f','bc44579e-faeb-4dee-8c24-a5163e6835bc','delivery.replied',1,'{"row":{"delivery_id":"daaf9c83-f771-4b0a-8e1b-7b5dc0579415","message_id":"5246fa68-5ba5-4716-b866-78ea08e35680","outcome":"sent","reason":null,"created_at":"2026-11-04T15:35:49.109Z"}}','2026-11-04T15:35:49.109Z');
INSERT INTO events VALUES(23,'723a83d1-733d-4bd7-8a53-41991358b13a','bc44579e-faeb-4dee-8c24-a5163e6835bc','delivery.finished',1,'{"row":{"seq":3,"id":"daaf9c83-f771-4b0a-8e1b-7b5dc0579415","message_id":"f5dfe68c-7b74-4820-8d93-4cb96f6f2e25","recipient_id":"8b518e15-1c99-4672-8789-7edc87681e89","lane_id":null,"status":"completed","turn_id":"fixture-reply","error":null,"retry_of":null,"chain_id":"fixture-chain","hop":1,"updated_at":"2026-11-04T15:35:49.110Z","batch_id":"802c2376-9bee-4fc0-8d48-e293ce271555"}}','2026-11-04T15:35:49.110Z');
INSERT INTO events VALUES(24,'87233db9-a5ea-4e84-89fe-ba4c47c006ac','migration:7:threads','thread.created',1,'{"row":{"id":"bbabba3a-681a-47da-b95b-ea50358986ef","agent_id":"fixture-agent","lane_key":"","created_at":"2026-11-04T00:00:00.000Z"}}','2026-11-04T00:00:00.000Z');
INSERT INTO events VALUES(25,'3049228b-690b-416d-b991-9b3b1abf43f1','migration:7:threads','thread.created',1,'{"row":{"id":"b02f19b1-ef74-4c39-b8d7-bf754b5b4ea6","agent_id":"8b518e15-1c99-4672-8789-7edc87681e89","lane_key":"","created_at":"2026-11-04T15:35:49.096Z"}}','2026-11-04T15:35:49.096Z');
CREATE TABLE message_routes (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  sender_lane_key TEXT NOT NULL
);
INSERT INTO message_routes VALUES('f5dfe68c-7b74-4820-8d93-4cb96f6f2e25','');
INSERT INTO message_routes VALUES('5246fa68-5ba5-4716-b866-78ea08e35680','');
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
INSERT INTO messages VALUES('fixture-message','user',NULL,NULL,'retained work',NULL,0,NULL,NULL,'2026-11-04T00:00:00.000Z');
INSERT INTO messages VALUES('fixture-completed-message','user',NULL,NULL,'completed work',NULL,0,NULL,NULL,'2026-11-04T00:00:00.000Z');
INSERT INTO messages VALUES('f5dfe68c-7b74-4820-8d93-4cb96f6f2e25','agent','fixture-agent',NULL,'retained request',NULL,1,'tool:8c7b3b7b3067a073d7b6513614721ae70d91c146dd1dd764f6f238da250d8ab6','041cfe056a11ae7c71c87b67bb8746fa21c3ed9dad87639b7eec44cb4c3749f7','2026-11-04T15:35:49.096Z');
INSERT INTO messages VALUES('5246fa68-5ba5-4716-b866-78ea08e35680','agent','8b518e15-1c99-4672-8789-7edc87681e89',NULL,'retained reply','f5dfe68c-7b74-4820-8d93-4cb96f6f2e25',0,'reply:daaf9c83-f771-4b0a-8e1b-7b5dc0579415','0282f1a8d351a922ba57f5b0627940cb982f69daa4adcc0669ddd18bb0ad8dfd','2026-11-04T15:35:49.103Z');
CREATE TABLE prices (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
  input_usd REAL NOT NULL, cache_write_5m_usd REAL NOT NULL, cache_write_1h_usd REAL NOT NULL,
  cache_read_usd REAL NOT NULL, output_usd REAL NOT NULL,
  effective_from TEXT NOT NULL, source_url TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json))
);
INSERT INTO prices VALUES('989b28c0e67140dd7d7dece18c353560b947686a3abea801090c2731a1a45edf','claude','claude-sonnet-4-6',3.0,3.75,6.0,0.2999999999999999889,15.0,'2026-11-04T00:00:00.000Z','https://platform.claude.com/docs/en/about-claude/pricing','{"effectiveFrom":"2026-11-04T00:00:00.000Z","price":{"cacheRead":0.3,"cacheWrite1h":6,"cacheWrite5m":3.75,"currency":"USD","input":3,"model":"claude-sonnet-4-6","output":15,"source":"https://platform.claude.com/docs/en/about-claude/pricing","unit":"million-tokens","verifiedAt":"2026-11-04"},"provider":"claude"}');
INSERT INTO prices VALUES('ad708f520e7c319d0f221c2fd9abfb62f6d648cf51f617094b1ba2ac5582b853','claude','claude-sonnet-5-5',2.0,2.5,4.0,0.1000000000000000055,10.0,'2026-11-04T00:00:00.000Z','https://platform.claude.com/docs/en/about-claude/pricing','{"effectiveFrom":"2026-11-04T00:00:00.000Z","price":{"cacheRead":0.1,"cacheWrite1h":4,"cacheWrite5m":2.5,"currency":"USD","input":2,"model":"claude-sonnet-5-5","output":10,"source":"https://platform.claude.com/docs/en/about-claude/pricing","unit":"million-tokens","verifiedAt":"2026-11-04"},"provider":"claude"}');
INSERT INTO prices VALUES('e19ac00f3437a12196c93472e9f3ee399c44cb8178c7e3e844feb13123ba90d1','claude','claude-opus-5-5',4.0,5.0,8.0,0.2000000000000000111,20.0,'2026-11-04T00:00:00.000Z','https://platform.claude.com/docs/en/about-claude/pricing','{"effectiveFrom":"2026-11-04T00:00:00.000Z","price":{"cacheRead":0.2,"cacheWrite1h":8,"cacheWrite5m":5,"currency":"USD","input":4,"model":"claude-opus-5-5","output":20,"source":"https://platform.claude.com/docs/en/about-claude/pricing","unit":"million-tokens","verifiedAt":"2026-11-04"},"provider":"claude"}');
INSERT INTO prices VALUES('588744f88112801669fb42ae643bb1f67adb4fbbd01aeb1d7f5705bc14c71bc2','claude','claude-fable-5-1',10.0,12.5,20.0,0.25,50.0,'2026-11-04T00:00:00.000Z','https://platform.claude.com/docs/en/about-claude/pricing','{"effectiveFrom":"2026-11-04T00:00:00.000Z","price":{"cacheRead":0.25,"cacheWrite1h":20,"cacheWrite5m":12.5,"currency":"USD","input":10,"model":"claude-fable-5-1","output":50,"source":"https://platform.claude.com/docs/en/about-claude/pricing","unit":"million-tokens","verifiedAt":"2026-11-04"},"provider":"claude"}');
INSERT INTO prices VALUES('42a1a53df582d390f1ba2592efbb1ce027722c9016de7ef492f8ec49222907a4','fake','fake',0.0,0.0,0.0,0.0,0.0,'2026-11-04T00:00:00.000Z','Kru deterministic fake: no model calls','{"effectiveFrom":"2026-11-04T00:00:00.000Z","price":{"cacheRead":0,"cacheWrite1h":0,"cacheWrite5m":0,"currency":"USD","input":0,"model":"fake","output":0,"source":"Kru deterministic fake: no model calls","unit":"million-tokens","verifiedAt":"2026-11-04"},"provider":"fake"}');
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
INSERT INTO schema_migrations VALUES(1,'2026-11-04T00:00:00.000Z');
INSERT INTO schema_migrations VALUES(2,'2026-11-04T00:00:00.000Z');
INSERT INTO schema_migrations VALUES(3,'2026-11-04T00:00:00.000Z');
INSERT INTO schema_migrations VALUES(4,'2026-11-04T15:00:53.776Z');
INSERT INTO schema_migrations VALUES(5,'2026-11-04T15:35:49.079Z');
INSERT INTO schema_migrations VALUES(6,'2026-11-04T16:54:21.766Z');
INSERT INTO schema_migrations VALUES(7,'2026-11-04T16:54:21.769Z');
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
INSERT INTO usage_records VALUES('fixture-batch','fixture-agent','claude','claude-sonnet-4-6','fixture-native-thread','fixture-turn','user','["fixture-completed-delivery"]','["fixture-completed-chain"]','final','completed','{"last":{"inputTotal":3,"cachedRead":0,"cacheWrite":0,"output":1,"totalTokens":4},"total":{"inputTotal":3,"cachedRead":0,"cacheWrite":0,"output":1,"totalTokens":4}}','{"model":"claude-sonnet-4-6","minimumNanoUsd":24000,"maximumNanoUsd":24000,"unknownCacheWriteTokens":0,"estimated":true,"scope":"main-agent-token-usage","price":{"model":"claude-sonnet-4-6","input":3,"cacheWrite5m":3.75,"cacheWrite1h":6,"cacheRead":0.3,"output":15,"source":"https://platform.claude.com/docs/en/about-claude/pricing","verifiedAt":"2026-11-04","currency":"USD","unit":"million-tokens"}}',1,NULL,'2026-11-04T00:00:00.000Z','2026-11-04T00:00:00.000Z','','989b28c0e67140dd7d7dece18c353560b947686a3abea801090c2731a1a45edf','2026-11-04T00:00:00.000Z',3,0,0,NULL,NULL,1,2.40000000000000006e-05,1);
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  lane_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, lane_key)
);
INSERT INTO threads VALUES('bbabba3a-681a-47da-b95b-ea50358986ef','fixture-agent','','2026-11-04T00:00:00.000Z');
INSERT INTO threads VALUES('b02f19b1-ef74-4c39-b8d7-bf754b5b4ea6','8b518e15-1c99-4672-8789-7edc87681e89','','2026-11-04T15:35:49.096Z');
CREATE TABLE turn_threads (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id),
  thread_id TEXT NOT NULL REFERENCES threads(id)
);
INSERT INTO sqlite_sequence VALUES('deliveries',4);
INSERT INTO sqlite_sequence VALUES('events',25);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
CREATE TRIGGER receipts_no_update BEFORE UPDATE ON command_receipts BEGIN SELECT RAISE(ABORT, 'Receipts are immutable'); END;
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON command_receipts BEGIN SELECT RAISE(ABORT, 'Receipts are immutable'); END;
CREATE INDEX deliveries_queue ON deliveries (recipient_id, lane_id, status, seq);
CREATE INDEX deliveries_message ON deliveries (message_id, seq);
CREATE INDEX deliveries_batch ON deliveries(batch_id);
CREATE INDEX usage_records_agent_day ON usage_records(agent_id, started_at);
CREATE INDEX events_command ON events(command_id, seq);
CREATE INDEX prices_model_time ON prices(provider, model, effective_from);
CREATE INDEX thread_messages_lane ON thread_messages(agent_id, lane_key, seq);
CREATE INDEX usage_records_agent_recorded ON usage_records(agent_id, recorded_at);
CREATE INDEX messages_key_retention ON messages(created_at) WHERE idempotency_key IS NOT NULL;
CREATE INDEX turn_threads_thread ON turn_threads(thread_id, turn_id);
CREATE UNIQUE INDEX provider_sessions_active ON provider_sessions(thread_id) WHERE active = 1;
COMMIT;
