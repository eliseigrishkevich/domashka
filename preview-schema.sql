ALTER TABLE domashka.broadcasts ADD COLUMN IF NOT EXISTS media_thumbnail_file_id TEXT;
SELECT count(*) FILTER (WHERE media_type='video_note') AS circles, count(media_thumbnail_file_id) AS saved_thumbnails FROM domashka.broadcasts;
