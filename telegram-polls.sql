ALTER TABLE domashka.polls ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'web' CHECK(channel IN ('web','telegram'));
ALTER TABLE domashka.polls ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE domashka.answers ADD COLUMN IF NOT EXISTS last_update_id BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS domashka.poll_deliveries (
 poll_id TEXT NOT NULL REFERENCES domashka.polls(id),
 member_id TEXT NOT NULL REFERENCES domashka.members(id),
 status TEXT NOT NULL DEFAULT 'pending',
 telegram_poll_id TEXT UNIQUE,
 message_id BIGINT,
 closed INTEGER NOT NULL DEFAULT 0,
 removed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(poll_id,member_id)
);
CREATE INDEX IF NOT EXISTS poll_deliveries_pending_idx ON domashka.poll_deliveries(poll_id,status);
ALTER TABLE domashka.poll_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON domashka.poll_deliveries FROM PUBLIC,anon,authenticated;
