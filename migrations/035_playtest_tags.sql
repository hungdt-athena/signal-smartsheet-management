-- Migration 035: playtest_tags — Trends tags proposed while testing a game.
--
-- Evaluators tag trends in the evaluation modal. Nothing reaches Signal Sense
-- until an admin confirms in Evaluations > Tagging; only then do we write into
-- custom_field_values (Signal Sense's table, same Neon database).
--
-- Attribution is two-tiered. Signal Sense's custom_field_values.created_by is a
-- FK to users(id) and its tag history joins through it, so free-text provenance
-- cannot go there. Confirmed tags are credited to the playtest_sync system
-- account (same pattern as the existing signal_sense_user row); the real
-- provenance -- who tagged, who confirmed, when -- lives in this table and is
-- what the Tagging > History view reads.

CREATE TABLE IF NOT EXISTS playtest_tags (
  id            serial PRIMARY KEY,
  game_id       varchar(255) NOT NULL REFERENCES game_info(game_id) ON DELETE CASCADE,
  field_value   text NOT NULL,
  sub_value_id  integer REFERENCES sub_value_definitions(id),
  status        varchar(16) NOT NULL DEFAULT 'pending',
  tagged_by     varchar(255) NOT NULL,
  tagged_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_by  varchar(255),
  confirmed_at  timestamptz,
  sync_result   varchar(16)
);

-- timestamptz, not timestamp: every surface renders these in Asia/Ho_Chi_Minh
-- (UTC+7), and a bare timestamp would show the wrong date near midnight.
--
-- sync_result values: inserted | duplicate | enriched | overwritten | kept |
-- inactive ('inactive' = the value stopped being an active Trends definition
-- between proposal and confirm, so nothing was written).

-- One live proposal per (game, value); history for the same pair may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS playtest_tags_pending_uniq
  ON playtest_tags (game_id, field_value) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS playtest_tags_status_idx
  ON playtest_tags (status, tagged_at DESC);
CREATE INDEX IF NOT EXISTS playtest_tags_game_idx ON playtest_tags (game_id);

-- System account credited for every tag synced from playtest. is_active = false
-- and no password hash, so it can never log in.
INSERT INTO users (id, first_name, last_name, email, is_active, password_hash)
VALUES ('playtest_sync', 'Signal Playtest', 'Sync', 'playtest-sync@athena.studio', false, NULL)
ON CONFLICT (id) DO NOTHING;
