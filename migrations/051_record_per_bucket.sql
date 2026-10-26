-- Migration 051: one set of Record fields per bucket (5 min and 20 min)
--
-- A game is one row, but it can go through Record twice: 5 min in one batch, then
-- pulled in again for 20 min a few batches later. The row had one confirmation, one
-- video, one upload time and one batch for both rounds, so the second round started
-- out "confirmed" (the first round's Confirm), the first round's video was replaced
-- by the second's, the first round moved into the new batch, and Report credited only
-- the bucket the game sits in now.
--
-- Each bucket now has its own:
--   record_<b>_confirmed_at   the manager's Confirm for that round
--   youtube_<b>_link          that round's video
--   youtube_<b>_uploaded_at   when that video was uploaded (VN local, as 034)
--   record_<b>_batch          the batch the round belonged to, frozen when the game
--                             leaves that bucket (kept for good once the round has
--                             its video). Until then the round follows ge.batch
--                             like the Record tab does.
--
-- The old columns stay and are kept equal to the OWN bucket's values by a trigger:
--   record_confirmed_at  = record_<own>_confirmed_at
--   youtube_uploaded_at  = youtube_<own>_uploaded_at
-- so everything that reads them (Record tab, record queue, panel lock) keeps meaning
-- "this round". A write to an old column (a build from before this change) is copied
-- into the own bucket's column. youtube_link stays the game's demo link (20 min
-- preferred); Signal Sense reads it by game_id.
-- Own bucket = the Record tab rule: record_bucket if '5min'/'20min', else Priority IV
-- is 20 min, everything else 5 min.
--
-- BACKFILL: the own bucket gets the row's current confirmation and upload time. The
-- stored link goes to the bucket of its upload in ytb_uploads (by YouTube id), except
-- a video typed with the wrong duration that is the own bucket's (see below); a link
-- that is not in ytb_uploads (old Smartsheet links) goes to the own bucket. An own
-- bucket with an upload time but no link of its own gets its exact title match from
-- ytb_uploads; reconcile-recorders fills the rest the next time the Record tab opens.
--
-- ORDER: additive. Apply BEFORE the build that reads the new columns. The build from
-- before keeps working against it (trigger above).
-- Idempotent: columns/indexes IF NOT EXISTS, backfill only fills NULLs, trigger
-- replaced.
--
-- ROLLBACK:
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_game_evaluations_record_slots ON game_evaluations;
--   DROP FUNCTION IF EXISTS game_evaluations_record_slots();
--   DROP INDEX IF EXISTS idx_game_evaluations_recorded_5min_at;
--   DROP INDEX IF EXISTS idx_game_evaluations_recorded_20min_at;
--   ALTER TABLE game_evaluations
--     DROP COLUMN IF EXISTS record_5min_confirmed_at, DROP COLUMN IF EXISTS record_20min_confirmed_at,
--     DROP COLUMN IF EXISTS youtube_5min_link, DROP COLUMN IF EXISTS youtube_20min_link,
--     DROP COLUMN IF EXISTS youtube_5min_uploaded_at, DROP COLUMN IF EXISTS youtube_20min_uploaded_at,
--     DROP COLUMN IF EXISTS record_5min_batch, DROP COLUMN IF EXISTS record_20min_batch;
--   COMMIT;
-- then redeploy the build before this change. The old columns were kept current the
-- whole time, so nothing else needs restoring.

-- Two transactions. The first only adds the columns: ALTER TABLE takes the lock that
-- blocks reads too, so it holds it for milliseconds. The second installs the trigger
-- before it fills anything (a write from the running build then waits on the trigger's
-- lock instead of slipping past the copy) and does the backfill.
BEGIN;

ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS record_5min_confirmed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS record_20min_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS youtube_5min_link         text,
  ADD COLUMN IF NOT EXISTS youtube_20min_link        text,
  ADD COLUMN IF NOT EXISTS youtube_5min_uploaded_at  timestamptz,
  ADD COLUMN IF NOT EXISTS youtube_20min_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS record_5min_batch         text,
  ADD COLUMN IF NOT EXISTS record_20min_batch        text;

COMMIT;

BEGIN;

CREATE OR REPLACE FUNCTION game_evaluations_record_slots()
RETURNS TRIGGER AS $$
DECLARE
  old_own text := CASE WHEN OLD.record_bucket IN ('5min','20min') THEN OLD.record_bucket
                       WHEN OLD.final_conclusion = 'Priority IV' THEN '20min' ELSE '5min' END;
  new_own text := CASE WHEN NEW.record_bucket IN ('5min','20min') THEN NEW.record_bucket
                       WHEN NEW.final_conclusion = 'Priority IV' THEN '20min' ELSE '5min' END;
BEGIN
  -- 1. A write to an old column with the own bucket's column untouched comes from a
  --    build that only knows the old column: carry it into the own bucket.
  IF NEW.record_confirmed_at IS DISTINCT FROM OLD.record_confirmed_at THEN
    IF new_own = '5min' AND NEW.record_5min_confirmed_at IS NOT DISTINCT FROM OLD.record_5min_confirmed_at THEN
      NEW.record_5min_confirmed_at := NEW.record_confirmed_at;
    ELSIF new_own = '20min' AND NEW.record_20min_confirmed_at IS NOT DISTINCT FROM OLD.record_20min_confirmed_at THEN
      NEW.record_20min_confirmed_at := NEW.record_confirmed_at;
    END IF;
  END IF;
  IF NEW.youtube_uploaded_at IS DISTINCT FROM OLD.youtube_uploaded_at THEN
    IF new_own = '5min' AND NEW.youtube_5min_uploaded_at IS NOT DISTINCT FROM OLD.youtube_5min_uploaded_at THEN
      NEW.youtube_5min_uploaded_at := NEW.youtube_uploaded_at;
    ELSIF new_own = '20min' AND NEW.youtube_20min_uploaded_at IS NOT DISTINCT FROM OLD.youtube_20min_uploaded_at THEN
      NEW.youtube_20min_uploaded_at := NEW.youtube_uploaded_at;
    END IF;
  END IF;

  -- 2. The game left a bucket: that round keeps the batch it was in. A round that
  --    already has its video keeps the batch it was first frozen with, so dragging
  --    the game into that bucket and out again does not move it. The bucket it moved
  --    into, if its round is still open, follows ge.batch again.
  IF old_own <> new_own THEN
    IF old_own = '5min' THEN
      IF NEW.youtube_5min_uploaded_at IS NULL OR NEW.record_5min_batch IS NULL THEN
        NEW.record_5min_batch := OLD.batch;
      END IF;
      IF NEW.youtube_20min_uploaded_at IS NULL THEN NEW.record_20min_batch := NULL; END IF;
    ELSE
      IF NEW.youtube_20min_uploaded_at IS NULL OR NEW.record_20min_batch IS NULL THEN
        NEW.record_20min_batch := OLD.batch;
      END IF;
      IF NEW.youtube_5min_uploaded_at IS NULL THEN NEW.record_5min_batch := NULL; END IF;
    END IF;
  END IF;

  -- 3. The old columns always read as the own bucket's round.
  IF new_own = '5min' THEN
    NEW.record_confirmed_at := NEW.record_5min_confirmed_at;
    NEW.youtube_uploaded_at := NEW.youtube_5min_uploaded_at;
  ELSE
    NEW.record_confirmed_at := NEW.record_20min_confirmed_at;
    NEW.youtube_uploaded_at := NEW.youtube_20min_uploaded_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_game_evaluations_record_slots ON game_evaluations;
CREATE TRIGGER trg_game_evaluations_record_slots
  BEFORE UPDATE ON game_evaluations
  FOR EACH ROW EXECUTE FUNCTION game_evaluations_record_slots();

-- Backfill. Each CTE is MATERIALIZED and filtered to the rows it fills: inlined, the
-- planner re-ran the ytb_uploads lookups per joined row (a minute on 101k rows).
-- With the trigger in place a copy into the own bucket leaves the old columns as
-- they are (they are what is being copied). updated_at is left alone: these rows
-- were not edited, and the panel shows that time as "Updated ... by".
ALTER TABLE game_evaluations DISABLE TRIGGER trg_game_evaluations_updated;

WITH own AS MATERIALIZED (
  SELECT id, CASE WHEN record_bucket IN ('5min','20min') THEN record_bucket
                  WHEN final_conclusion = 'Priority IV' THEN '20min' ELSE '5min' END AS b
  FROM game_evaluations
  WHERE record_confirmed_at IS NOT NULL OR youtube_uploaded_at IS NOT NULL
)
UPDATE game_evaluations ge SET
  record_5min_confirmed_at  = CASE WHEN own.b = '5min'  THEN COALESCE(ge.record_5min_confirmed_at,  ge.record_confirmed_at) ELSE ge.record_5min_confirmed_at END,
  record_20min_confirmed_at = CASE WHEN own.b = '20min' THEN COALESCE(ge.record_20min_confirmed_at, ge.record_confirmed_at) ELSE ge.record_20min_confirmed_at END,
  youtube_5min_uploaded_at  = CASE WHEN own.b = '5min'  THEN COALESCE(ge.youtube_5min_uploaded_at,  ge.youtube_uploaded_at) ELSE ge.youtube_5min_uploaded_at END,
  youtube_20min_uploaded_at = CASE WHEN own.b = '20min' THEN COALESCE(ge.youtube_20min_uploaded_at, ge.youtube_uploaded_at) ELSE ge.youtube_20min_uploaded_at END
FROM own
WHERE own.id = ge.id;

-- The stored link into the bucket of its upload; unknown uploads into the own bucket.
-- One exception: the game has its own bucket's video (youtube_uploaded_at) and the
-- sheet has no upload of that title in that bucket. Then the link IS that video,
-- typed with the wrong duration ("15" for a 5-min clip) and matched across buckets by
-- the recorder sync; filed under the sheet's bucket it would read as the other round.
-- Titles compare as the sync's loose key does: lower case, letters and digits only.
WITH link_rows AS MATERIALIZED (
  SELECT id, game_id, youtube_link, youtube_uploaded_at IS NOT NULL AS own_uploaded,
    CASE WHEN record_bucket IN ('5min','20min') THEN record_bucket
         WHEN final_conclusion = 'Priority IV' THEN '20min' ELSE '5min' END AS own,
    COALESCE(substring(youtube_link from '(?:youtu\.be/|[?&]v=|/embed/|/shorts/|/live/)([A-Za-z0-9_-]{11})'),
             btrim(youtube_link)) AS yid
  FROM game_evaluations
  WHERE youtube_link IS NOT NULL AND btrim(youtube_link) <> ''
), link AS MATERIALIZED (
  SELECT r.*, regexp_replace(lower(COALESCE(gi.title, '')), '[^a-z0-9]+', '', 'g') AS t
  FROM link_rows r LEFT JOIN game_info gi ON gi.game_id = r.game_id
), uploads AS MATERIALIZED (
  SELECT youtube_id, uploaded_at, regexp_replace(lower(COALESCE(game_title, '')), '[^a-z0-9]+', '', 'g') AS t,
    CASE WHEN COALESCE(substring(duration from '^\s*(\d+)')::int, 0) >= 15 THEN '20min' ELSE '5min' END AS bucket
  FROM ytb_uploads
  WHERE COALESCE(youtube_id, '') <> ''
), sheet AS MATERIALIZED (
  SELECT DISTINCT ON (youtube_id) youtube_id, bucket
  FROM uploads ORDER BY youtube_id, uploaded_at NULLS LAST
), titled AS MATERIALIZED (
  SELECT DISTINCT t, bucket FROM uploads WHERE t <> ''
), placed AS MATERIALIZED (
  SELECT link.id, link.youtube_link,
    CASE WHEN sheet.bucket IS NULL THEN link.own
         WHEN sheet.bucket <> link.own AND link.own_uploaded
              AND NOT EXISTS (SELECT 1 FROM titled WHERE titled.t = link.t AND titled.bucket = link.own) THEN link.own
         ELSE sheet.bucket END AS bucket
  FROM link LEFT JOIN sheet ON sheet.youtube_id = link.yid
)
UPDATE game_evaluations ge SET
  youtube_5min_link  = CASE WHEN placed.bucket = '5min'  THEN COALESCE(ge.youtube_5min_link,  placed.youtube_link) ELSE ge.youtube_5min_link END,
  youtube_20min_link = CASE WHEN placed.bucket = '20min' THEN COALESCE(ge.youtube_20min_link, placed.youtube_link) ELSE ge.youtube_20min_link END
FROM placed
WHERE placed.id = ge.id;

-- Own bucket uploaded but its link went to the other bucket (the demo link prefers
-- 20 min): take the own bucket's exact title match, earliest upload.
WITH need_rows AS MATERIALIZED (
  SELECT id, game_id,
    CASE WHEN record_bucket IN ('5min','20min') THEN record_bucket
         WHEN final_conclusion = 'Priority IV' THEN '20min' ELSE '5min' END AS own,
    youtube_5min_link, youtube_20min_link
  FROM game_evaluations
  WHERE youtube_uploaded_at IS NOT NULL
), need AS MATERIALIZED (
  SELECT n.id, n.own, lower(btrim(gi.title)) AS t
  FROM need_rows n JOIN game_info gi ON gi.game_id = n.game_id
  WHERE CASE n.own WHEN '5min' THEN n.youtube_5min_link IS NULL ELSE n.youtube_20min_link IS NULL END
), uploads AS MATERIALIZED (
  SELECT DISTINCT ON (t, bucket) t, bucket, youtube_id
  FROM (SELECT lower(btrim(game_title)) AS t, youtube_id, uploaded_at,
          CASE WHEN COALESCE(substring(duration from '^\s*(\d+)')::int, 0) >= 15 THEN '20min' ELSE '5min' END AS bucket
        FROM ytb_uploads WHERE COALESCE(youtube_id, '') <> '' AND COALESCE(game_title, '') <> '') u
  ORDER BY t, bucket, uploaded_at NULLS LAST
), hit AS MATERIALIZED (
  SELECT need.id, need.own, uploads.youtube_id AS yid
  FROM need JOIN uploads ON uploads.t = need.t AND uploads.bucket = need.own
)
UPDATE game_evaluations ge SET
  youtube_5min_link  = CASE WHEN hit.own = '5min'  THEN COALESCE(ge.youtube_5min_link,  'https://youtu.be/' || hit.yid) ELSE ge.youtube_5min_link END,
  youtube_20min_link = CASE WHEN hit.own = '20min' THEN COALESCE(ge.youtube_20min_link, 'https://youtu.be/' || hit.yid) ELSE ge.youtube_20min_link END
FROM hit
WHERE hit.id = ge.id;

ALTER TABLE game_evaluations ENABLE TRIGGER trg_game_evaluations_updated;

-- Report windows each bucket's recording on its own completion moment.
CREATE INDEX IF NOT EXISTS idx_game_evaluations_recorded_5min_at
  ON game_evaluations ((COALESCE(record_5min_confirmed_at, youtube_5min_uploaded_at)));
CREATE INDEX IF NOT EXISTS idx_game_evaluations_recorded_20min_at
  ON game_evaluations ((COALESCE(record_20min_confirmed_at, youtube_20min_uploaded_at)));

COMMIT;
