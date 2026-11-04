-- Migration 052: 6-char file codes for demo and record videos
-- game_info is keyed by game_id. Codes are set lazily by lib/file-codes.ts.
ALTER TABLE game_info
  ADD COLUMN IF NOT EXISTS demo_code text,
  ADD COLUMN IF NOT EXISTS record_code text;

CREATE UNIQUE INDEX IF NOT EXISTS game_info_demo_code_uq
  ON game_info (demo_code) WHERE demo_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS game_info_record_code_uq
  ON game_info (record_code) WHERE record_code IS NOT NULL;
