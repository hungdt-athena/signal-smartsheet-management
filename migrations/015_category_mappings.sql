-- Migration 015: category_mappings — genre → evaluation-bucket map (DB-side split)
-- Replaces the `categories_list` column in the "N8N configs" Google Sheet that the
-- Smartsheet push/split flow reads. One row per (genre, bucket). A game whose
-- game_info.metadata->'categories' contains a matching genre is eligible for that
-- bucket. A game may match MULTIPLE buckets (same behavior as the Smartsheet flow,
-- which runs each bucket's filter independently — no cross-bucket dedup).

CREATE TABLE IF NOT EXISTS category_mappings (
  id             SERIAL PRIMARY KEY,
  genre          TEXT NOT NULL,          -- category name as in game_info.metadata->'categories' (e.g. 'Puzzle', 'Word')
  category_group TEXT NOT NULL,          -- target bucket: 'puzzle' | 'arcade' | 'simulation'
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (genre, category_group)
);

CREATE INDEX IF NOT EXISTS idx_category_mappings_lookup
  ON category_mappings (active, category_group);

-- Seed: mirrors the live "N8N configs" sheet `categories_list` per group
-- (matching is case-insensitive against game_info.metadata->'categories').
INSERT INTO category_mappings (genre, category_group) VALUES
  ('puzzle',     'puzzle'),
  ('word',       'puzzle'),
  ('trivia',     'puzzle'),
  ('music',      'puzzle'),
  ('casual',     'puzzle'),
  ('arcade',     'arcade'),
  ('adventure',  'arcade'),
  ('action',     'arcade'),
  ('simulation', 'simulation'),
  ('strategy',   'simulation')
ON CONFLICT (genre, category_group) DO NOTHING;
