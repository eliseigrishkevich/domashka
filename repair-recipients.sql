DO $repair$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='domashka' AND table_name='members' AND column_name='broadcast_opt_out') THEN
  ALTER TABLE domashka.members ADD COLUMN broadcast_opt_out INTEGER NOT NULL DEFAULT 0 CHECK(broadcast_opt_out IN (0,1));
  -- Preserve explicit preferences from the original registration form.
  UPDATE domashka.members SET broadcast_opt_out=1 WHERE subscribed=0 AND NOT(days='[]' AND times='[]');
  -- Repair only records created by the short form with its erroneous zero default.
  UPDATE domashka.members SET subscribed=1 WHERE subscribed=0 AND days='[]' AND times='[]';
 END IF;
END $repair$;
SELECT count(*) AS total_members,count(*) FILTER(WHERE subscribed=1) AS broadcast_recipients,
 count(*) FILTER(WHERE broadcast_opt_out=1) AS explicitly_disabled FROM domashka.members;
