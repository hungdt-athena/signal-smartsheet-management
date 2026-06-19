-- Migration 016: evaluator_roster per-bucket — Assign Setup is the sole writer.
-- Adds category_group so the same person can sit in puzzle/arcade/simulation
-- independently, widens game_category for multi-genre values ('All' or 'a,b,c'),
-- and replaces UNIQUE(list_type, name) with UNIQUE(list_type, category_group, name).

ALTER TABLE evaluator_roster ADD COLUMN IF NOT EXISTS category_group TEXT;
UPDATE evaluator_roster SET category_group = 'puzzle' WHERE category_group IS NULL;
ALTER TABLE evaluator_roster ALTER COLUMN category_group SET NOT NULL;

ALTER TABLE evaluator_roster ALTER COLUMN game_category TYPE TEXT;

-- Drop the old (list_type, name) unique constraint. The name below is Postgres'
-- default for UNIQUE(list_type, name) created in migration 008; if `\d evaluator_roster`
-- shows a different name, drop that one instead.
ALTER TABLE evaluator_roster DROP CONSTRAINT IF EXISTS evaluator_roster_list_type_name_key;

ALTER TABLE evaluator_roster
  ADD CONSTRAINT evaluator_roster_bucket_name_key UNIQUE (list_type, category_group, name);
