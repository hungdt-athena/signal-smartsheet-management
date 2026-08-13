-- Migration 036: record when a synced Trends tag stops existing in Signal Sense.
--
-- Confirming a tag stamped playtest_tags with status='synced' and a sync_result,
-- and that was the end of the story. But a tag can be deleted from Signal Sense
-- afterwards, and Signal Sense derives its own custom-field tag history from the
-- custom_field_values rows themselves — so deleting the row erases the past on
-- both sides. Observed on prod: playtest_tags #4 (Artwork-Canvas) still read
-- 'synced/inserted' while no custom_field_values row remained, and the same
-- trend was re-tagged and re-confirmed as a second 'inserted' with nothing
-- recording the removal in between.
--
-- removed_at is stamped once, the first time the row is observed missing from
-- custom_field_values (by POST /api/playtest-tags/reconcile), or immediately
-- when an admin removes the tag from the Tagging tab. It is never cleared: if
-- the trend is later tagged again, that is a new playtest_tags row, so the
-- removal stays visible in history.
--
-- status gains 'removed' alongside pending | synced | rejected. sync_result is
-- left untouched, so history can still say what the original confirm did
-- ("inserted, then removed") rather than overwriting it.

ALTER TABLE playtest_tags
  ADD COLUMN IF NOT EXISTS removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS removed_by varchar(255);

-- Partial: the reconcile sweep only ever looks at synced rows not yet stamped.
CREATE INDEX IF NOT EXISTS playtest_tags_unremoved_idx
  ON playtest_tags (game_id, field_value) WHERE status = 'synced' AND removed_at IS NULL;
