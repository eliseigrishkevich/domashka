ALTER TABLE domashka.members ADD COLUMN IF NOT EXISTS is_core INTEGER NOT NULL DEFAULT 0 CHECK (is_core IN (0,1));
ALTER TABLE domashka.polls ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','core'));
ALTER TABLE domashka.broadcasts ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','core'));
ALTER TABLE domashka.broadcasts ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'text' CHECK (media_type IN ('text','voice','video_note'));
ALTER TABLE domashka.broadcasts ADD COLUMN IF NOT EXISTS media_file_id TEXT;
ALTER TABLE domashka.broadcasts ADD COLUMN IF NOT EXISTS source_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS broadcast_source_message_idx ON domashka.broadcasts(source_message_id) WHERE source_message_id IS NOT NULL;
ALTER TABLE domashka.broadcasts ADD COLUMN IF NOT EXISTS queue_token TEXT;
