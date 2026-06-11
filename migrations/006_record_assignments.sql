-- Migration 006: Split recording assignments into 5-min and 20-min durations
-- Rename playtest_assignee → record_assignee for consistency

ALTER TABLE game_evaluations RENAME COLUMN playtest_assignee TO record_assignee;
ALTER TABLE game_evaluations RENAME COLUMN assign_playtest_date TO record_assign_date;

ALTER TABLE game_evaluations
  ADD COLUMN record_5min_assignee  VARCHAR(100),
  ADD COLUMN record_5min_date      TIMESTAMP WITH TIME ZONE,
  ADD COLUMN record_5min_drive     TEXT,
  ADD COLUMN record_5min_drive_date TIMESTAMP WITH TIME ZONE,
  ADD COLUMN record_20min_assignee VARCHAR(100),
  ADD COLUMN record_20min_date     TIMESTAMP WITH TIME ZONE,
  ADD COLUMN record_20min_drive    TEXT,
  ADD COLUMN record_20min_drive_date TIMESTAMP WITH TIME ZONE;

CREATE INDEX idx_game_evaluations_record_5min ON game_evaluations(record_5min_assignee) WHERE record_5min_assignee IS NOT NULL;
CREATE INDEX idx_game_evaluations_record_20min ON game_evaluations(record_20min_assignee) WHERE record_20min_assignee IS NOT NULL;
