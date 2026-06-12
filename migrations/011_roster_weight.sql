-- Migration 011: evaluator_roster.weight — assignment quota weight
-- Mirrors the "Weight" column of the Evaluator List sheet (blank → 100).
ALTER TABLE evaluator_roster
  ADD COLUMN IF NOT EXISTS weight INT NOT NULL DEFAULT 100;
