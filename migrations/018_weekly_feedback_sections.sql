-- Migration 018: Weekly Feedback → multi-section model
-- Each week's feedback is now an ordered array of sections. Every section is a
-- row split 70/30: a Tiptap feedback document on the left, and a named
-- "game alike" block (name + list of games) on the right. Shape stored in `sections`:
--   [{ id, feedback: <tiptap doc|null>,
--      alike: { name: string, games: [{ game_id, title, app_link, icon_url, manual }] } }]
--
-- The legacy `feedback` / `game_alike` columns are kept for rollback safety. The
-- API synthesizes `sections` from them on read when `sections` is NULL, so no
-- destructive backfill is needed here.

ALTER TABLE weekly_feedback ADD COLUMN IF NOT EXISTS sections JSONB;
