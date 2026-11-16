ALTER TABLE domashka.answers ADD COLUMN IF NOT EXISTS remind_at timestamptz;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
SELECT cron.schedule('domashka-poll-reminders','*/5 * * * *',$job$
  SELECT net.http_post(
    url := 'https://skequqvzqzogfuemuzqn.supabase.co/functions/v1/domashka/telegram',
    headers := jsonb_build_object('Content-Type','application/json','X-Telegram-Bot-Api-Secret-Token',decrypted_secret::jsonb->>'WEBHOOK_SECRET'),
    body := '{"domashka_reminders":true}'::jsonb
  )
  FROM vault.decrypted_secrets WHERE name='domashka_runtime'
    AND EXISTS (SELECT 1 FROM domashka.answers WHERE remind_at <= now());
$job$);
