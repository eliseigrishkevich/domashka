ALTER TABLE domashka.deliveries ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE domashka.deliveries ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT;
ALTER TABLE domashka.poll_deliveries ADD COLUMN IF NOT EXISTS last_error TEXT;
