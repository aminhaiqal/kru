CREATE TABLE message_routes (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  sender_lane_key TEXT NOT NULL
);
CREATE TABLE delivery_replies (
  delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id),
  message_id TEXT REFERENCES messages(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('sent','suppressed')),
  reason TEXT,
  created_at TEXT NOT NULL
);
