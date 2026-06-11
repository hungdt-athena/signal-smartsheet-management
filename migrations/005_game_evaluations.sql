-- Migration 005: Create game_evaluations table (replaces Smartsheet)
-- Stores evaluation data that was previously managed in Smartsheet

CREATE TABLE IF NOT EXISTS game_evaluations (
  id                  SERIAL PRIMARY KEY,
  game_id             VARCHAR(255) NOT NULL REFERENCES game_info(game_id) ON DELETE CASCADE,
  category_group      VARCHAR(20) NOT NULL CHECK (category_group IN ('puzzle', 'arcade', 'simulation')),

  -- Evaluator assignment (auto-assign from Google Sheet evaluator lists)
  initial_evaluator   VARCHAR(100),
  final_evaluator     VARCHAR(100),
  assigned_date       DATE,

  -- Evaluator input (filled via web UI)
  evaluate_date       TIMESTAMP WITH TIME ZONE,  -- auto-set when evaluator submits
  initial_note        TEXT,
  initial_conclusion  VARCHAR(50),
  genre_1             VARCHAR(50),
  genre_2             VARCHAR(50),

  -- Playtest / video (List_Idea games assigned to another evaluator for recording)
  playtest_assignee    VARCHAR(100),
  assign_playtest_date TIMESTAMP WITH TIME ZONE,  -- auto when playtest assigned
  drive_link           TEXT,
  drive_date           TIMESTAMP WITH TIME ZONE,  -- auto when drive_link submitted
  youtube_link         TEXT,

  -- Timestamps
  imported_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  UNIQUE(game_id, category_group)
);

-- Indexes for common queries
CREATE INDEX idx_game_evaluations_category ON game_evaluations(category_group);
CREATE INDEX idx_game_evaluations_initial_evaluator ON game_evaluations(initial_evaluator) WHERE initial_evaluator IS NOT NULL;
CREATE INDEX idx_game_evaluations_final_evaluator ON game_evaluations(final_evaluator) WHERE final_evaluator IS NOT NULL;
CREATE INDEX idx_game_evaluations_conclusion ON game_evaluations(initial_conclusion) WHERE initial_conclusion IS NOT NULL;
CREATE INDEX idx_game_evaluations_imported ON game_evaluations(imported_at DESC);
CREATE INDEX idx_game_evaluations_unassigned ON game_evaluations(category_group, assigned_date) WHERE initial_evaluator IS NULL;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_game_evaluations_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_game_evaluations_updated
  BEFORE UPDATE ON game_evaluations
  FOR EACH ROW
  EXECUTE FUNCTION update_game_evaluations_timestamp();
