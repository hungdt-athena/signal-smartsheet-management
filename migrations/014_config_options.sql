-- Migration 014: config_options — editable dropdown option lists
-- Powers the Config tab (admin + moderator). Lets the initial-conclusion and
-- final-conclusion option lists be customized at runtime instead of being
-- hardcoded in the page/route source. One row per option.
-- (Genre→category mapping for the game-splitting flow is intentionally NOT here;
--  it belongs to the later "push/split game in backend" migration.)

CREATE TABLE IF NOT EXISTS config_options (
  id          SERIAL PRIMARY KEY,
  field       TEXT NOT NULL,            -- 'conclusion' | 'final_conclusion'
  value       TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (field, value)
);

CREATE INDEX IF NOT EXISTS idx_config_options_field
  ON config_options(field, active, sort_order);

-- Seed initial-conclusion options (mirrors the previous hardcoded list/order).
INSERT INTO config_options (field, value, sort_order) VALUES
  ('conclusion', 'Bypass', 0),
  ('conclusion', 'Conclusion', 1),
  ('conclusion', 'Good', 2),
  ('conclusion', 'Link_dead', 3),
  ('conclusion', 'M_ByPass', 4),
  ('conclusion', 'Need deeper testing', 5),
  ('conclusion', 'Skip', 6),
  ('conclusion', 'Wait for PlayTest', 7),
  ('conclusion', 'Priority IV: Idea', 8),
  ('conclusion', 'Priority III: Watchlist for next phase', 9),
  ('conclusion', 'Check Market Data', 10),
  ('conclusion', 'Watchlist for next milestone', 11),
  ('conclusion', 'Priority II', 12),
  ('conclusion', 'Priority I', 13),
  ('conclusion', 'Need Direction', 14),
  ('conclusion', 'List_Idea', 15)
ON CONFLICT (field, value) DO NOTHING;

-- Seed final-conclusion options (moderator triage verdicts).
INSERT INTO config_options (field, value, sort_order) VALUES
  ('final_conclusion', 'Priority V', 0),
  ('final_conclusion', 'Priority IV', 1),
  ('final_conclusion', 'Bypass', 2),
  ('final_conclusion', 'Theme/Art', 3),
  ('final_conclusion', 'Insight', 4),
  ('final_conclusion', 'Watch List', 5),
  ('final_conclusion', 'Not Found', 6)
ON CONFLICT (field, value) DO NOTHING;
