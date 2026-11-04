-- Expiry is always original created_at + 30 days; reads never extend it.
CREATE INDEX messages_key_retention ON messages(created_at) WHERE idempotency_key IS NOT NULL;
